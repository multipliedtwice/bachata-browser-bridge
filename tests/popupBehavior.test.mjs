import assert from "node:assert/strict";
import test from "node:test";

import {
  nextTurn,
  installGlobals,
  endpoint,
  providerTabs,
  readyPair,
  state,
  byId,
  type,
  click,
} from "./support/popupDom.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

test("popup drives the whole pairing, binding, and failure lifecycle", async () => {
  const messages = [];
  const responses = [
    state(),
    state({ revision: 2, connected: true }),
    state({ revision: 3, connected: true, selectedTabId: 7, tabs: readyPair() }),
    state({ revision: 4, connected: true }),
    state({ revision: 5, connected: true, tabs: providerTabs().slice(0, 1) }),
    { success: false, revision: 5, error: "Bind refused" },
    { nonsense: true },
    { throws: "Receiving end does not exist" },
    state({ revision: 6, connected: false, connecting: true, retryInMs: 4200, tabs: [] }),
    state({ revision: 6, connected: false, connecting: true, retryInMs: 4200, tabs: [] }),
    state({ revision: 7, tabs: [] }),
    { success: false, revision: 7, error: "Pairing token rejected" },
    state({ revision: 1, connected: true }),
    { ...state({ revision: 8, connected: true }), unexpected: "value" },
    { ...state({ revision: 8, connected: true }), tabs: [providerTabs()[0], providerTabs()[0]] },
    { ...state({ revision: 8, connected: true }), tabs: [{ ...providerTabs()[0], id: -1 }] },
    { ...state({ revision: 8, connected: true }), selectedTabId: 0 },
    state({ revision: 2, connected: true }),
    state({ revision: 9, connected: true }),
  ];
  let clipboardReads = 0;
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      const response = responses.length > 1 ? responses.shift() : responses[0];
      if (response && response.throws) {
        throw new Error(response.throws);
      }
      return response;
    },
    async () => {
      clipboardReads += 1;
      if (clipboardReads === 2) {
        throw new Error("Read permission denied");
      }
      return clipboardReads === 3 ? "   " : "  clipboard-token  ";
    },
  );
  try {
    await import(`../dist/popup/index.js?popup-behavior=${String(Math.random())}`);
    await nextTurn();

    assert.deepEqual(messages[0], { type: "popup.getState" });
    assert.equal(byId("connection").textContent, "Disconnected");
    assert.equal(byId("connection").classList.contains("disconnected"), true);
    assert.equal(byId("endpoint").value, endpoint);
    assert.equal(byId("pair").disabled, true);
    assert.equal(byId("token-reveal").disabled, true);
    assert.equal(byId("tabs-empty").hidden, true);
    assert.equal(byId("tab-list").children.length, 4);
    assert.equal(byId("bind-7").hidden, true);
    assert.match(byId("tab-list").textContent, /Generic · localhost:8080/);
    assert.match(byId("tab-list").textContent, /tab 12/);
    assert.match(byId("tab-list").textContent, /Sign in to Claude/);
    assert.match(byId("tab-list").textContent, /Streaming/);
    assert.equal(byId("binding-status").textContent, "");
    assert.equal(
      byId("favicon-7").getAttribute("src"),
      `chrome-extension://bachata-browser-bridge/_favicon/?pageUrl=${encodeURIComponent("https://chatgpt.com/c/ready")}&size=32`,
    );
    assert.equal(byId("favicon-13").hidden, true);
    assert.match(byId("tab-list").textContent, /Untitled conversation/);
    assert.match(byId("tab-list").textContent, /Generic/);
    assert.match(byId("tab-list").textContent, /tab 13/);
    assert.equal(byId("bind-7").getAttribute("aria-label"), "Use Ready chat on tab 7");
    assert.equal(byId("unbind-7").getAttribute("aria-label"), "Stop using Ready chat on tab 7");
    byId("favicon-8").fire("error");
    assert.equal(byId("favicon-8").hidden, true);

    type("endpoint", "ws://example.com:1/x");
    assert.equal(byId("endpoint-error").hidden, false);
    assert.match(byId("endpoint-error").textContent, /loopback WebSocket URL/);
    assert.equal(byId("endpoint").classList.contains("invalid"), true);
    assert.equal(byId("pair").disabled, true);
    byId("pairing-form").fire("submit");
    await nextTurn();
    assert.equal(messages.length, 1);

    type("endpoint", endpoint);
    assert.equal(byId("endpoint-error").hidden, true);
    await click("token-paste");
    assert.equal(byId("token").value, "clipboard-token");
    assert.equal(byId("token-error").hidden, true);
    assert.equal(byId("pair").disabled, false);

    await click("token-paste");
    assert.equal(byId("token-error").hidden, false);
    assert.match(byId("token-error").textContent, /Ctrl\+V/);

    await click("token-paste");
    assert.equal(byId("token-error").hidden, false);
    assert.match(byId("token-error").textContent, /clipboard is empty/);
    assert.equal(byId("token").value, "clipboard-token");

    type("token", "bachata-token");
    assert.equal(byId("token-error").hidden, true);
    assert.equal(byId("pair").disabled, false);
    assert.equal(byId("token").type, "password");
    await click("token-reveal");
    assert.equal(byId("token").type, "text");
    assert.equal(byId("token-reveal").textContent, "Hide");

    byId("pairing-form").fire("submit");
    await nextTurn();
    assert.deepEqual(messages[1], { type: "popup.pair", endpoint, token: "bachata-token" });
    assert.equal(byId("token").value, "");
    assert.equal(byId("token").type, "password");
    assert.equal(byId("connection").textContent, "Connected");
    assert.equal(byId("connection-section").hidden, true);
    assert.equal(byId("connection").getAttribute("aria-expanded"), "false");

    await click("connection");
    assert.equal(byId("connection-section").hidden, false);
    assert.equal(byId("connection-summary").hidden, false);
    assert.equal(byId("pairing-form").hidden, true);
    assert.equal(byId("endpoint-summary").textContent, "127.0.0.1:43127");
    assert.equal(byId("bind-7").hidden, false);
    assert.equal(byId("bind-8").hidden, true);

    await click("edit-connection");
    assert.equal(byId("pairing-form").hidden, false);
    assert.equal(byId("cancel-edit").hidden, false);
    type("endpoint", "ws://127.0.0.1:1/bachata-browser-bridge-v9");
    await click("cancel-edit");
    assert.equal(byId("pairing-form").hidden, true);
    await click("connection");
    assert.equal(byId("connection-section").hidden, true);
    assert.equal(byId("endpoint").value, endpoint);

    await click("bind-8");
    assert.equal(messages.length, 2);

    byId("bind-7").focus();
    await click("bind-7");
    assert.deepEqual(messages[2], { type: "popup.select", tabId: 7 });
    assert.equal(document.activeElement.id, "unbind-7");
    assert.equal(byId("bind-7").hidden, true);
    assert.equal(byId("unbind-7").hidden, false);
    assert.equal(byId("conversations-heading").textContent, "Selected chat");
    assert.equal(byId("change-conversation").hidden, false);
    assert.equal(byId("refresh").hidden, true);
    assert.equal(byId("tab-list").children[1].hidden, true);
    assert.equal(byId("tab-list").children[0].hidden, false);

    await click("change-conversation");
    assert.equal(byId("conversations-heading").textContent, "Choose a chat");
    assert.equal(byId("tab-list").children[1].hidden, false);
    assert.equal(byId("done-choosing").hidden, false);
    assert.equal(byId("refresh").hidden, false);

    assert.equal(byId("bind-8").hidden, false);
    byId("bind-8").focus();
    await click("done-choosing");
    assert.equal(byId("tab-list").children[1].hidden, true);
    assert.equal(document.activeElement.id, "change-conversation");

    await click("change-conversation");
    assert.equal(byId("tab-list").children[1].hidden, false);
    assert.equal(byId("unbind-8").hidden, true);
    assert.equal(byId("binding-status").textContent, "Bound to ChatGPT conversation Ready chat.");

    await click("unbind-7");
    assert.deepEqual(messages[3], { type: "popup.deselect" });
    assert.equal(document.activeElement.id, "bind-7");
    assert.equal(byId("binding-status").textContent, "Provider conversation unbound.");
    assert.equal(byId("bind-7").hidden, false);

    await click("refresh");
    assert.deepEqual(messages[4], { type: "popup.discover" });
    assert.equal(byId("tab-list").children.length, 1);

    await click("refresh");
    assert.equal(byId("binding-notice").hidden, false);
    assert.equal(byId("binding-error").textContent, "Bind refused");
    assert.equal(byId("connection-notice").hidden, true);
    await click("binding-dismiss");
    assert.equal(byId("binding-notice").hidden, true);

    await click("refresh");
    assert.equal(byId("connection-notice").hidden, false);
    assert.equal(byId("connection-error").textContent, "The browser bridge returned an invalid response");

    await click("refresh");
    assert.equal(byId("connection-error").textContent, "Receiving end does not exist");
    await click("connection-dismiss");
    assert.equal(byId("connection-notice").hidden, true);

    await click("disconnect");
    assert.deepEqual(messages[8], { type: "popup.disconnect" });
    assert.equal(byId("connection").textContent, "Connecting");
    assert.equal(byId("connection").classList.contains("connecting"), true);
    assert.equal(byId("retry").hidden, false);
    assert.equal(byId("retry-text").textContent, "Retrying in 5s");
    assert.equal(byId("cancel-connect").hidden, false);
    assert.equal(byId("tabs-empty").hidden, false);
    assert.match(byId("tabs-empty").textContent, /Open a ChatGPT or Claude conversation/);
    assert.equal(byId("subtitle").hidden, false);

    await click("reconnect");
    assert.deepEqual(messages[9], { type: "popup.reconnect" });

    await click("cancel-connect");
    assert.deepEqual(messages[10], { type: "popup.disconnect" });
    assert.equal(byId("connection").textContent, "Disconnected");
    assert.equal(byId("retry").hidden, true);

    type("token", "second-token");
    byId("pairing-form").fire("submit");
    await nextTurn();
    assert.deepEqual(messages[11], { type: "popup.pair", endpoint, token: "second-token" });
    assert.equal(byId("connection-notice").hidden, false);
    assert.equal(byId("connection-error").textContent, "Pairing token rejected");
    assert.equal(byId("binding-notice").hidden, true);

    await click("refresh");
    assert.equal(byId("connection").textContent, "Disconnected");
    assert.equal(byId("tab-list").children.length, 0);

    for (const description of ["unknown keys", "duplicate tab ids", "an invalid tab id", "an invalid selection"]) {
      await click("refresh");
      assert.equal(
        byId("connection-error").textContent,
        "The browser bridge returned an invalid response",
        `a response with ${description} was accepted`,
      );
      assert.equal(byId("connection").textContent, "Disconnected");
    }

    type("token", "third-token");
    byId("pairing-form").fire("submit");
    await nextTurn();
    assert.equal(byId("token").value, "third-token");
    assert.equal(byId("pairing-form").hidden, false);
    assert.equal(byId("connection").textContent, "Disconnected");

    await click("refresh");
    assert.equal(byId("connection").textContent, "Connected");

    const limitedTab = { ...providerTabs()[0], capabilities: {
      submission: "syntheticEnter", completion: "manualOnly", interruption: "unavailable",
      assets: "textOnly", conversationState: "uncertain",
    }, recovery: { kind: "failure", submission: "uncertain" } };
    responses.splice(0, responses.length,
      state({ revision: 10, connected: true, tabs: [{ ...limitedTab, manualSelectionAvailable: true }] }),
      { success: false, revision: 10, error: "Select the completed answer first" },
      state({ revision: 11, connected: true, tabs: [limitedTab] }),
      state({ revision: 12, connected: true, tabs: [limitedTab] }),
      state({ revision: 13, connected: true, tabs: [{ ...limitedTab, capabilities: { completion: "native" } }] }),
    );
    await click("refresh");
    assert.match(byId("capabilities-7").textContent, /Manual response selection required/);
    assert.match(byId("capabilities-7").textContent, /Conversation uncertain/);
    assert.match(byId("capability-details-7").textContent, /Keyboard fallback for Send/);
    assert.match(byId("capability-details-7").textContent, /Text only/);
    assert.equal(byId("recover-7").textContent, "Use selected response");
    assert.match(byId("recovery-7").textContent, /submission is uncertain/);
    assert.match(byId("recovery-7").textContent, /without replaying/);
    await click("recover-7");
    assert.deepEqual(messages.at(-1), { type: "popup.recover", tabId: 7, action: "selected" });
    assert.equal(byId("binding-error").textContent, "Select the completed answer first");
    assert.equal(byId("binding-notice").hidden, false);
    await click("refresh");
    assert.equal(byId("recover-7").textContent, "Open conversation");
    assert.match(byId("recovery-7").textContent, /No prompt will be resent/);
    await click("recover-7");
    assert.deepEqual(messages.at(-1), { type: "popup.recover", tabId: 7, action: "open" });
    await click("refresh");
    assert.match(byId("connection-error").textContent, /invalid response/);
    assert.match(byId("capabilities-7").textContent, /Manual response selection required/);
  } finally {
    restore();
  }
});
