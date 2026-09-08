import { profileIdentity } from "../dist/background/profileIdentity.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createGenericDom } from "./support/genericDom.mjs";
import { prepareGenericSetupDom, waitForSetup } from "./support/genericSetupDom.mjs";
import { showGenericSetup } from "../dist/content/generic/setup.js";

const capabilities = async () => ({ submission: "syntheticEnter", completion: "manualOnly", interruption: "unavailable", assets: "textOnly", conversationState: "uncertain" });

const turn = () => new Promise((resolve) => setImmediate(resolve));

const setupDom = () => {
  const dom = createGenericDom('<main id="conversation"><textarea id="composer"></textarea></main>');
  const { panel, focused } = prepareGenericSetupDom(dom.document);
  globalThis.location = { origin: "https://llm.test", pathname: "/chat", search: "", hash: "" };
  const state = { profiles: [] };
  globalThis.chrome = {
    runtime: { sendMessage: async () => ({ ok: true, value: state.profiles, fingerprints: await Promise.all(state.profiles.map(profileIdentity)) }) },
    storage: { local: { get: async () => ({}), remove: async () => undefined } },
  };
  const click = async (text) => {
    const button = panel().querySelectorAll("button").find((element) => element.textContent === text);
    assert.ok(button, `Missing control: ${text}`);
    const event = dom.document.createEvent("Event");
    event.initEvent("click", true, true);
    button.dispatchEvent(event);
    await turn();
    await waitForSetup(() => !button.disabled);
    assert.equal(button.disabled, false, `Control did not finish: ${text}`);
  };
  return { dom, state, panel, focused, click };
};

test("guided setup exposes required controls and keeps optional missing controls nonfatal", async () => {
  const { dom, state, panel, click } = setupDom();
  let valid = false;
  let detected = false;
  const close = showGenericSetup({ capabilities, revision: () => 1, assertIdle: () => undefined, validate: async () => valid, autoDetect: async () => detected });
  try {
    await turn();
    assert.equal(panel().querySelectorAll("li").length, 6);
    assert.equal(panel().querySelectorAll("small").filter((element) => element.textContent.startsWith("Required")).length, 2);
    await click("Auto-detect controls");
    assert.match(panel().textContent, /No unambiguous binding/);
    await click("Validate binding");
    assert.match(panel().textContent, /not valid on this page/);
    state.profiles = [{ protocol: "bachata-generic-binding-v1", origin: "https://llm.test", routePattern: "/chat", framePath: [],
      composer: { tag: "textarea", stableAttributes: {}, structuralPath: [], cssFallback: "#composer" },
      conversationRoot: { tag: "main", stableAttributes: {}, structuralPath: [], cssFallback: "#conversation" },
      createdBy: "user", validated: true, consecutiveFailures: 0, documentRevision: 1 }];
    valid = true;
    detected = true;
    await click("Auto-detect controls");
    assert.match(panel().textContent, /Controls found/);
    await click("Validate binding");
    assert.match(panel().textContent, /Binding validated/);
    assert.match(panel().textContent, /Manual response selection required/);
    assert.match(panel().textContent, /does not prove automatic completion or Stop/);
    assert.equal(panel().querySelectorAll("small").filter((element) => element.textContent.includes("Located")).length, 2);
    await click("Close setup");
    assert.equal(dom.document.querySelectorAll("aside").length, 0);
  } finally { close(); dom.restore(); }
});

test("guided setup refuses changes while a request owns the binding", async () => {
  const { dom, panel, click } = setupDom();
  let calls = 0;
  const close = showGenericSetup({ capabilities, revision: () => 1, assertIdle: () => { throw new Error("Finish the active request"); }, validate: async () => { calls += 1; return true; }, autoDetect: async () => { calls += 1; return true; } });
  try {
    await turn();
    await click("Auto-detect controls");
    assert.match(panel().textContent, /Finish the active request/);
    await click("Validate binding");
    assert.equal(calls, 0);
  } finally { close(); dom.restore(); }
});

test("cancelling keyboard selection restores focus to the replacement setup control", async () => {
  const { dom, panel, focused } = setupDom();
  const close = showGenericSetup({ capabilities, revision: () => 1, assertIdle: () => undefined, validate: async () => false, autoDetect: async () => false });
  try {
    await waitForSetup(() => panel().querySelectorAll("li").length === 6);
    const button = panel().querySelectorAll("button").find((element) => element.textContent === "Choose Composer");
    const click = dom.document.createEvent("Event");
    click.initEvent("click", true, true);
    button.dispatchEvent(click);
    await waitForSetup(() => dom.document.querySelector("[data-bachata-picker-help]"));
    const escape = dom.document.createEvent("Event");
    escape.initEvent("keydown", true, true);
    escape.key = "Escape";
    dom.document.dispatchEvent(escape);
    await waitForSetup(() => focused()?.textContent === "Choose Composer");
    const replacement = panel().querySelectorAll("button").find((element) => element.textContent === "Choose Composer");
    assert.notEqual(replacement, button);
    assert.equal(focused(), replacement);
    assert.equal(replacement.disabled, false);
    assert.equal(dom.document.querySelector("aside").hidden, false);
  } finally { close(); dom.restore(); }
});
