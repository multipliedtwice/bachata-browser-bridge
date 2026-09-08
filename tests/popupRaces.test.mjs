import assert from "node:assert/strict";
import test from "node:test";

import {
  nextTurn,
  deferred,
  installGlobals,
  state,
  byId,
  type,
  click,
} from "./support/popupDom.mjs";

test("Reconnect now cancels an older pending Paste & Pair intent", async () => {
  const clipboard = deferred();
  const messages = [];
  const restore = installGlobals(async (message) => {
    messages.push(message);
    return message.type === "popup.reconnect"
      ? state({ revision: 2, connected: true })
      : state({ retryInMs: 1_000 });
  }, async () => clipboard.promise);
  try {
    await import(`../dist/popup/index.js?pair-reconnect-race=${String(Math.random())}`);
    await nextTurn();
    assert.equal(byId("pairing-form").hidden, false);
    assert.equal(byId("retry").hidden, false);
    byId("token-paste-pair").fire("click");
    await click("reconnect");
    clipboard.resolve("a".repeat(43));
    await nextTurn();
    assert.equal(messages.filter((message) => message.type === "popup.reconnect").length, 1);
    assert.equal(messages.filter((message) => message.type === "popup.pair").length, 0,
      "the older clipboard intent replaced the connection restored by Reconnect now");
  } finally {
    restore();
  }
});

test("popup preserves endpoint edits made before delayed initial state", async () => {
  const initial = deferred();
  const restore = installGlobals(async () => initial.promise);
  try {
    await import(`../dist/popup/index.js?popup-endpoint-race=${String(Math.random())}`);
    type("endpoint", "ws://127.0.0.1:44000/bachata-browser-bridge-v9");
    initial.resolve(state());
    await nextTurn();
    assert.equal(byId("endpoint").value, "ws://127.0.0.1:44000/bachata-browser-bridge-v9");
  } finally {
    restore();
  }
});

test("popup does not overwrite a newer token edit with a delayed clipboard read", async () => {
  const clipboard = deferred();
  const restore = installGlobals(async () => state(), async () => clipboard.promise);
  try {
    await import(`../dist/popup/index.js?popup-clipboard-race=${String(Math.random())}`);
    await nextTurn();
    byId("token-paste").fire("click");
    type("token", "typed-after-click");
    clipboard.resolve("stale-clipboard-token");
    await nextTurn();
    assert.equal(byId("token").value, "typed-after-click");
    assert.equal(byId("token-error").hidden, true);
  } finally {
    restore();
  }
});

test("Paste & Pair does not pair a second time after a manual pair wins the race", async () => {
  const clipboard = deferred();
  const messages = [];
  const manualToken = "b".repeat(43);
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return state({ revision: 2, connected: true });
    },
    async () => clipboard.promise,
  );
  try {
    await import(`../dist/popup/index.js?paste-pair-manual-race=${String(Math.random())}`);
    await nextTurn();
    // A token is already typed, so the form can pair manually while the clipboard read is deferred.
    type("token", manualToken);
    byId("token-paste-pair").fire("click");
    byId("pairing-form").fire("submit");
    await nextTurn();
    clipboard.resolve("a".repeat(43));
    await nextTurn();
    const pairs = messages.filter((message) => message.type === "popup.pair");
    assert.equal(pairs.length, 1, "the stale clipboard paired a second time after a manual pair");
    assert.equal(pairs[0].token, manualToken, "the manual pair did not carry the typed token");
  } finally {
    restore();
  }
});

test("Paste & Pair refuses after a competing disconnect during the clipboard read", async () => {
  const clipboard = deferred();
  const messages = [];
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return state({ revision: 2, connected: message.type === "popup.pair" });
    },
    async () => clipboard.promise,
  );
  try {
    await import(`../dist/popup/index.js?paste-pair-disconnect-race=${String(Math.random())}`);
    await nextTurn();
    byId("token-paste-pair").fire("click");
    byId("disconnect").fire("click");
    await nextTurn();
    clipboard.resolve("a".repeat(43));
    await nextTurn();
    assert.equal(
      messages.some((message) => message.type === "popup.pair"),
      false,
      "a stale Paste & Pair paired after a competing disconnect",
    );
    assert.equal(messages.some((message) => message.type === "popup.disconnect"), true);
  } finally {
    restore();
  }
});

test("popup resurfaces the same connection error after recovery", async () => {
  const responses = [
    state({ connected: true, error: "Transport unavailable" }),
    state({ revision: 2, connected: true, error: undefined }),
    state({ revision: 3, connected: true, error: "Transport unavailable" }),
  ];
  const restore = installGlobals(async () => responses.shift());
  try {
    await import(`../dist/popup/index.js?popup-error-recurrence=${String(Math.random())}`);
    await nextTurn();
    assert.equal(byId("connection-section").hidden, false);
    assert.equal(byId("connection-notice").hidden, false);
    await click("connection-dismiss");
    assert.equal(byId("connection-notice").hidden, true);
    byId("disconnect").fire("click");
    await nextTurn();
    assert.equal(byId("connection-section").hidden, true);
    byId("disconnect").fire("click");
    await nextTurn();
    assert.equal(byId("connection-section").hidden, false);
    assert.equal(byId("connection-notice").hidden, false);
    assert.equal(byId("connection-error").textContent, "Transport unavailable");
  } finally {
    restore();
  }
});
