import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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

/**
 * BB-R26-04. Three token controls (Paste, Paste & Pair, Show) share the row, so the input can no
 * longer reserve a fixed two-control gutter that a third control grows past into the caret. The
 * controls are siblings of the input in normal flow, keep their order and their keyboard labels,
 * and the input is the flex child that shrinks. This asserts the structure and the stylesheet
 * contract, not rendered pixels — a DOM mock cannot measure overlap.
 */
test("the token controls sit in normal flow beside a shrinking input", async () => {
  const restore = installGlobals(async () => state({ connected: false }), async () => "");
  try {
    await import(`../dist/popup/index.js?token-layout=${String(Math.random())}`);
    await nextTurn();

    const input = byId("token");
    const field = input.parent;
    assert.ok(field.classList.contains("token-field"), "the token input left the token field");
    const actions = field.children.find((child) => child.classList.contains("token-actions"));
    assert.ok(actions, "the token actions are not a sibling of the input in normal flow");
    assert.equal(field.children.indexOf(input), 0, "the input is not first in the token field");
    assert.deepEqual(
      actions.children.map((button) => button.id),
      ["token-paste", "token-paste-pair", "token-reveal"],
      "the token control order changed",
    );
    for (const button of actions.children) {
      assert.equal(button.type, "button", `${button.id} is not a plain button`);
      assert.ok(button.textContent.trim().length > 0, `${button.id} lost its keyboard label`);
    }
    assert.equal(byId("token-paste").textContent, "Paste");
    assert.equal(byId("token-paste-pair").textContent, "Paste & Pair");

    const style = readFileSync(new URL("../src/popup/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(style, /padding-right:\s*108px/u, "the fixed two-control gutter remains");
    assert.match(style, /\.token-field input\s*\{[^}]*min-width:\s*0/u, "the input does not shrink");
    assert.doesNotMatch(
      style,
      /\.token-actions\s*\{[^}]*position:\s*absolute/u,
      "the token actions are still absolutely positioned over the input",
    );
  } finally {
    restore();
  }
});
