import assert from "node:assert/strict";
import test from "node:test";

import {
  nextTurn,
  deferred,
  installGlobals,
  endpoint,
  state,
  byId,
  type,
  click,
} from "./support/popupDom.mjs";

const validToken = "a".repeat(43);
const otherEndpoint = "ws://127.0.0.1:51000/bachata-browser-bridge-v9";

/**
 * Paste & Pair is the whole first run in one control, so what it must never do is take the
 * endpoint from the clipboard: a clipboard is writable by any local process, and an endpoint read
 * out of it would point the Bridge at a port that process controls. The token is the only thing
 * that crosses, the endpoint comes from the prefilled field, and a clipboard that is not a token
 * is refused before anything is sent.
 */
test("Paste & Pair carries only the token, and refuses a clipboard that is not one", async () => {
  const messages = [];
  const clipboard = ["https://evil.test/not-a-token", `  ${validToken}  `];
  let read = 0;
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return state({ revision: 2, connected: true });
    },
    async () => {
      const value = clipboard[Math.min(read, clipboard.length - 1)];
      read += 1;
      return value;
    },
  );
  try {
    await import(`../dist/popup/index.js?paste-pair=${String(Math.random())}`);
    await nextTurn();

    // The endpoint is canonical without the reader carrying it, which is what makes one paste enough.
    assert.equal(byId("endpoint").value, endpoint);

    // First clipboard: not a pairing token. Refused before any pairing call.
    await click("token-paste-pair");
    await nextTurn();
    assert.equal(
      messages.some((message) => message.type === "popup.pair"),
      false,
      "a non-token clipboard reached the pairing call",
    );
    assert.match(byId("token-error").textContent, /not a pairing token/iu);

    // Second clipboard: a real token. Pairs with the field's endpoint, not anything pasted.
    await click("token-paste-pair");
    await nextTurn();
    const pair = messages.find((message) => message.type === "popup.pair");
    assert.ok(pair, "Paste & Pair did not pair on a valid token");
    assert.equal(pair.token, validToken, "the token was not the trimmed clipboard value");
    assert.equal(pair.endpoint, endpoint, "the endpoint did not come from the field");
  } finally {
    restore();
  }
});

/**
 * The prefill is the half that makes one paste enough, so it has to be proven against a background
 * that reports no endpoint at all — the state a Bridge is in before it has ever paired. A fixture
 * that supplies the endpoint would assert nothing about the prefill.
 */
test("with no endpoint from the background, the canonical one is offered and used", async () => {
  const messages = [];
  const withoutEndpoint = (overrides = {}) => {
    const { endpoint: omitted, ...rest } = state(overrides);
    return rest;
  };
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return withoutEndpoint({ revision: 2 });
    },
    async () => validToken,
  );
  try {
    await import(`../dist/popup/index.js?paste-pair-noendpoint=${String(Math.random())}`);
    await nextTurn();

    assert.equal(
      byId("endpoint").value,
      endpoint,
      "an unpaired Bridge did not offer the canonical endpoint",
    );
    // The placeholder is the same constant, so the two cannot drift apart.
    assert.equal(byId("endpoint").placeholder, endpoint);

    await click("token-paste-pair");
    await nextTurn();
    const pair = messages.find((message) => message.type === "popup.pair");
    assert.ok(pair, "Paste & Pair did not pair from the prefilled endpoint");
    assert.equal(pair.endpoint, endpoint, "pairing did not use the canonical endpoint");
    assert.equal(pair.token, validToken);
  } finally {
    restore();
  }
});

/**
 * BB-R26-03. The endpoint the reader sees is the endpoint that pairs. A clipboard read is async and
 * the endpoint field stays editable while it waits, so an endpoint edited during the read must not
 * be pre-empted by the endpoint the field held when Paste & Pair was pressed. The deferred clipboard
 * resolves only after the edit, and the pairing that captured the old endpoint is refused rather than
 * sent to it.
 */
test("Paste & Pair refuses to pair an endpoint edited while the clipboard was read", async () => {
  const clipboard = deferred();
  const messages = [];
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return state({ revision: 2, connected: true });
    },
    async () => clipboard.promise,
  );
  try {
    await import(`../dist/popup/index.js?paste-pair-endpoint-edit=${String(Math.random())}`);
    await nextTurn();

    byId("token-paste-pair").fire("click");
    // The reader retargets the Bridge to a different loopback port before the clipboard resolves.
    type("endpoint", otherEndpoint);
    clipboard.resolve(validToken);
    await nextTurn();

    assert.equal(
      messages.some((message) => message.type === "popup.pair"),
      false,
      "a stale Paste & Pair paired after the endpoint was edited",
    );
    assert.equal(byId("endpoint").value, otherEndpoint, "the edited endpoint was overwritten");
  } finally {
    restore();
  }
});

test("pairing keeps the token separate from actions and exposes one primary action", async () => {
  const restore = installGlobals(async () => state({ connected: false }), async () => "");
  try {
    await import(`../dist/popup/index.js?token-layout=${String(Math.random())}`);
    await nextTurn();
    const input = byId("token");
    const field = input.parent;
    assert.equal(field.children.filter((child) => child.tagName === "INPUT").length, 1);
    assert.equal(field.children.filter((child) => child.tagName === "BUTTON").length, 0,
      "action buttons must not share the token input's row");
    assert.equal(input.getAttribute("aria-describedby"), "token-hint token-error");
    assert.equal(byId("token-reveal").getAttribute("aria-controls"), input.id);
    for (const id of ["token-paste", "token-paste-pair", "token-reveal"]) {
      assert.equal(byId(id).type, "button");
      assert.ok(byId(id).textContent.trim());
    }
    const primary = () => byId("pairing-form").querySelectorAll("button")
      .filter((button) => button.classList.contains("primary") && !button.hidden);
    assert.deepEqual(primary().map((button) => button.id), ["token-paste-pair"]);
    assert.equal(byId("token-paste-pair").disabled, false);
    type("token", "typed-token");
    assert.deepEqual(primary().map((button) => button.id), ["pair"]);
    assert.equal(byId("pair").disabled, false);
    await click("token-reveal");
    assert.equal(byId("token-reveal").getAttribute("aria-pressed"), "true");
    assert.equal(input.type, "text");
    await click("token-reveal");
    assert.equal(byId("token-reveal").getAttribute("aria-pressed"), "false");
    assert.equal(input.type, "password");
    type("token", "");
    assert.deepEqual(primary().map((button) => button.id), ["token-paste-pair"]);
  } finally {
    restore();
  }
});

test("advanced connection settings stay optional but expose an invalid loaded address", async () => {
  const customEndpoint = "ws://127.0.0.1:50087/bachata-browser-bridge-v9";
  const messages = [];
  let clipboardReads = 0;
  const restore = installGlobals(async (message) => {
    messages.push(message);
    return state({ endpoint: customEndpoint });
  }, async () => {
    clipboardReads += 1;
    return "a".repeat(43);
  });
  try {
    await import(`../dist/popup/index.js?advanced-settings=${String(Math.random())}`);
    await nextTurn();
    const advanced = byId("connection-advanced");
    const input = byId("endpoint");
    assert.equal(advanced.tagName, "DETAILS");
    assert.equal(advanced.children[0].tagName, "SUMMARY");
    assert.equal(advanced.open, false);
    assert.equal(input.value, customEndpoint);
    assert.equal(input.getAttribute("aria-invalid"), "false");
    advanced.open = true;
    input.focus();
    type("endpoint", "wss://untrusted.example/bridge");
    assert.equal(advanced.open, true);
    assert.equal(document.activeElement, input);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.match(input.getAttribute("aria-describedby"), /endpoint-error/);
    assert.equal(byId("endpoint-error").hidden, false);
    assert.equal(byId("token-paste-pair").disabled, true);
    type("endpoint", customEndpoint);
    assert.equal(input.getAttribute("aria-invalid"), "false");
    assert.equal(advanced.open, true, "state updates must preserve an expanded settings section");
    type("endpoint", "   ");
    assert.equal(byId("token-paste-pair").disabled, true);
    byId("token-paste-pair").fire("click");
    await nextTurn();
    assert.equal(clipboardReads, 0, "an empty endpoint must not consume clipboard contents");
    assert.equal(messages.some((message) => message.type === "popup.pair"), false);
    type("endpoint", customEndpoint);
    assert.equal(byId("token-paste-pair").disabled, false);
  } finally {
    restore();
  }

  const restoreInvalid = installGlobals(async () => state({ endpoint: "ws://untrusted.example/bridge" }));
  try {
    await import(`../dist/popup/index.js?invalid-settings=${String(Math.random())}`);
    await nextTurn();
    assert.equal(byId("connection-advanced").open, true);
    assert.equal(byId("endpoint-error").hidden, false);
    assert.equal(byId("token-paste-pair").disabled, true);
  } finally {
    restoreInvalid();
  }
});

test("a clipboard primary replaced by typed-token submit keeps keyboard focus reachable", async () => {
  const validToken = "a".repeat(43);
  const restore = installGlobals(async (message) => message.type === "popup.pair"
    ? { success: false, revision: 1, error: "Token expired. Copy a new token in VS Code." }
    : state(), async () => validToken);
  try {
    await import(`../dist/popup/index.js?primary-focus=${String(Math.random())}`);
    await nextTurn();
    byId("token-paste-pair").focus();
    await click("token-paste-pair");
    assert.equal(byId("token-paste-pair").hidden, true);
    assert.equal(byId("pair").hidden, false);
    assert.equal(document.activeElement.id, "pair");
    assert.equal(byId("connection-notice").getAttribute("role"), "alert");
    assert.match(byId("connection-error").textContent, /Token expired/);
  } finally {
    restore();
  }
});
