import assert from "node:assert/strict";
import test from "node:test";
import { installGlobals, byId, click } from "./support/popupDom.mjs";
import { installGenericManagement } from "../dist/popup/genericManagement.js";

test("Generic setup requests one exact origin and never starts after denied permission", async () => {
  const messages = [];
  const permissions = [];
  let allowed = false;
  const restore = installGlobals(async (message) => { messages.push(message); return { ok: true }; });
  try {
    chrome.tabs = { query: async () => [{ id: 17, url: "https://llm.test/private/chat?secret=hidden" }] };
    chrome.permissions = { request: async (permission) => { permissions.push(permission); return allowed; } };
    installGenericManagement(byId("root"));
    await click("generic-setup");
    assert.equal(document.activeElement, byId("generic-allow"));
    assert.equal(byId("generic-allow").textContent, "Allow and set up https://llm.test");
    await click("generic-allow");
    assert.deepEqual(permissions, [{ origins: ["https://llm.test/*"] }]);
    assert.deepEqual(messages, []);
    assert.match(byId("generic-status").textContent, /not granted/);
    allowed = true;
    await click("generic-allow");
    assert.deepEqual(messages, [{ type: "BACHATA_GENERIC_MANAGE", action: "setup", tabId: 17, origin: "https://llm.test" }]);
    assert.equal(byId("generic-allow").hidden, true);
    assert.equal(document.activeElement, byId("generic-setup"));
  } finally { restore(); }
});

test("saved binding controls require confirmation and retain the list on a failed removal", async () => {
  const entry = { origin: "https://llm.test", id: "a".repeat(64), validated: true, permitted: true };
  const messages = [];
  let fail = true;
  let entries = [entry];
  const restore = installGlobals(async (message) => {
    messages.push(message);
    if (message.action === "list") return { ok: true, entries };
    if (fail) return { ok: false, error: "The saved binding changed" };
    entries = [];
    return { ok: true };
  });
  try {
    installGenericManagement(byId("root"));
    await click("generic-saved");
    const row = byId("generic-bindings").children[0];
    const remove = row.children[2];
    remove.fire("click");
    assert.equal(byId("generic-confirmation").hidden, false);
    assert.equal(document.activeElement, byId("generic-cancel"));
    await click("generic-cancel");
    assert.equal(document.activeElement, remove);
    assert.equal(messages.length, 1);
    remove.fire("click");
    await click("generic-confirm");
    assert.match(byId("generic-status").textContent, /saved binding changed/);
    assert.equal(byId("generic-bindings").children.length, 1);
    fail = false;
    remove.fire("click");
    await click("generic-confirm");
    assert.equal(byId("generic-bindings").children.length, 0);
    assert.equal(document.activeElement, byId("generic-saved"));
    assert.equal(messages.filter((message) => message.action === "revoke").length, 0);
  } finally { restore(); }
});

test("malformed binding lists and unsupported current pages remain actionable errors", async () => {
  const restore = installGlobals(async () => ({ ok: true, entries: [{ origin: "https://llm.test/private", id: "bad" }] }));
  try {
    chrome.tabs = { query: async () => [{ id: 17, url: "https://chatgpt.com/c/private" }] };
    installGenericManagement(byId("root"));
    await click("generic-saved");
    assert.match(byId("generic-status").textContent, /list is invalid/);
    await click("generic-setup");
    assert.match(byId("generic-status").textContent, /built-in/);
    assert.equal(byId("generic-allow").hidden, true);
  } finally { restore(); }
});
