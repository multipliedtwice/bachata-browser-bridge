import assert from "node:assert/strict";
import test from "node:test";

import {
  nextTurn,
  installGlobals,
  endpoint,
  state,
  byId,
  type,
  pairingValue,
  typePairing,
  pastePairing,
  click,
} from "./support/popupDom.mjs";

const validToken = "1234";
const otherEndpoint = "ws://127.0.0.1:51000/bachata-browser-bridge-v9";
const routedCode = `v9.51000.${validToken}`;

/**
 * Pairing codes use the visible endpoint. Arbitrary clipboard values remain
 * invalid; only the constrained versioned pairing-code form may select another loopback port.
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

    assert.equal(byId("endpoint"), null, "the popup exposed a connection URL field");

    // First clipboard: not a pairing token. Refused before any pairing call.
    await click("token-paste-pair");
    await nextTurn();
    assert.equal(
      messages.some((message) => message.type === "popup.pair"),
      false,
      "a non-token clipboard reached the pairing call",
    );
    assert.match(byId("token-error").textContent, /not a pairing token/iu);

    // Second clipboard: a real token. The popup resolves the rendezvous endpoint itself.
    await click("token-paste-pair");
    await nextTurn();
    const pair = messages.find((message) => message.type === "popup.pair");
    assert.ok(pair, "Paste & Pair did not pair on a valid token");
    assert.equal(pair.token, validToken, "the token was not the trimmed clipboard value");
    assert.equal(pair.endpoint, endpoint, "the short code did not use the canonical rendezvous endpoint");
  } finally {
    restore();
  }
});

test("a legacy 43-character pairing token remains accepted during migration", async () => {
  const legacyToken = "a".repeat(43);
  const messages = [];
  const restore = installGlobals(async (message) => {
    messages.push(message);
    return state({ revision: 2, connected: true });
  }, async () => legacyToken);
  try {
    await import(`../dist/popup/index.js?legacy-token=${String(Math.random())}`);
    await nextTurn();
    await click("token-paste-pair");
    await nextTurn();
    assert.equal(messages.find((message) => message.type === "popup.pair")?.token, legacyToken);
  } finally {
    restore();
  }
});

test("a pairing code discovers its Bridge port and sends only the raw token", async () => {
  const messages = [];
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return message.type === "popup.pair"
        ? state({ revision: 2, connected: true, endpoint: otherEndpoint })
        : state();
    },
    async () => routedCode,
  );
  try {
    await import(`../dist/popup/index.js?routed-paste-pair=${String(Math.random())}`);
    await nextTurn();

    await click("token-paste-pair");
    await nextTurn();
    const pair = messages.find((message) => message.type === "popup.pair");
    assert.ok(pair, "the routed pairing code did not pair");
    assert.deepEqual(pair, { type: "popup.pair", endpoint: otherEndpoint, token: validToken });
  } finally {
    restore();
  }
});

test("a pairing code pasted into the OTP discovers its Bridge port on submit", async () => {
  const messages = [];
  const restore = installGlobals(async (message) => {
    messages.push(message);
    return message.type === "popup.pair"
      ? state({ revision: 2, connected: true, endpoint: otherEndpoint })
      : state();
  });
  try {
    await import(`../dist/popup/index.js?routed-field-pair=${String(Math.random())}`);
    await nextTurn();

    pastePairing(routedCode);
    byId("pairing-form").fire("submit");
    await nextTurn();
    const pair = messages.find((message) => message.type === "popup.pair");
    assert.ok(pair, "the typed pairing code did not pair");
    assert.deepEqual(pair, { type: "popup.pair", endpoint: otherEndpoint, token: validToken });
  } finally {
    restore();
  }
});

test("a failed routed pairing keeps the exact code and discovered port for retry", async () => {
  const messages = [];
  const restore = installGlobals(
    async (message) => {
      messages.push(message);
      return message.type === "popup.pair"
        ? state({
          revision: 2,
          connected: false,
          endpoint: otherEndpoint,
          error: "Could not connect to the Bachata VS Code extension",
        })
        : state();
    },
    async () => routedCode,
  );
  try {
    await import(`../dist/popup/index.js?routed-failure-retained=${String(Math.random())}`);
    await nextTurn();

    await click("token-paste-pair");
    await nextTurn();
    assert.equal(pairingValue(), validToken, "the failed attempt erased or rewrote the pairing code");
    assert.equal(
      messages.find((message) => message.type === "popup.pair")?.endpoint,
      otherEndpoint,
      "the routed code's discovered port was lost",
    );
    assert.equal(byId("pair").hidden, false, "the retained code cannot be retried");
    assert.match(byId("connection-error").textContent, /Could not connect/iu);
  } finally {
    restore();
  }
});

test("a pairing code cannot carry an invalid or out-of-range port", async () => {
  const messages = [];
  const restore = installGlobals(async (message) => {
    messages.push(message);
    return state({ revision: 2 });
  });
  try {
    await import(`../dist/popup/index.js?routed-invalid=${String(Math.random())}`);
    await nextTurn();

    pastePairing(`v9.65536.${validToken}`);
    byId("pairing-form").fire("submit");
    await nextTurn();
    assert.equal(messages.some((message) => message.type === "popup.pair"), false);
    assert.match(byId("token-error").textContent, /pairing code is invalid/iu);
  } finally {
    restore();
  }
});

test("with no endpoint from the background, the canonical rendezvous is used invisibly", async () => {
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

    assert.equal(byId("endpoint"), null);
    assert.equal(byId("connection-advanced"), null);

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

test("pairing uses an accessible four-cell OTP and exposes one primary action", async () => {
  const restore = installGlobals(async () => state({ connected: false }), async () => "");
  try {
    await import(`../dist/popup/index.js?token-layout=${String(Math.random())}`);
    await nextTurn();
    const group = byId("token-inputs");
    const inputs = group.querySelectorAll("input");
    assert.equal(inputs.length, 4);
    assert.equal(group.getAttribute("role"), "group");
    assert.equal(group.getAttribute("aria-labelledby"), "token-label");
    assert.match(byId("token-hint").textContent, /remains valid until used or reset/iu);
    inputs.forEach((input, index) => {
      assert.equal(input.maxLength, 1);
      assert.equal(input.inputMode, "numeric");
      assert.equal(input.getAttribute("aria-describedby"), "token-hint token-error");
      assert.equal(input.getAttribute("aria-label"), `Pairing code digit ${index + 1} of 4`);
    });
    for (const id of ["token-paste", "token-paste-pair"]) {
      assert.equal(byId(id).type, "button");
      assert.ok(byId(id).textContent.trim());
    }
    const primary = () => byId("pairing-form").querySelectorAll("button")
      .filter((button) => button.classList.contains("primary") && !button.hidden);
    assert.deepEqual(primary().map((button) => button.id), ["token-paste-pair"]);
    assert.equal(byId("token-paste-pair").disabled, false);
    typePairing(validToken);
    assert.deepEqual(primary().map((button) => button.id), ["pair"]);
    assert.equal(byId("pair").disabled, false);
    typePairing("");
    assert.deepEqual(primary().map((button) => button.id), ["token-paste-pair"]);
  } finally {
    restore();
  }
});

test("the OTP advances, filters input, pastes a whole code, and navigates backward", async () => {
  const restore = installGlobals(async () => state({ connected: false }));
  try {
    await import(`../dist/popup/index.js?otp-behavior=${String(Math.random())}`);
    await nextTurn();

    byId("token-1").focus();
    type("token-1", "5");
    assert.equal(document.activeElement.id, "token-2");
    type("token-2", "x");
    assert.equal(pairingValue(), "5");
    assert.equal(document.activeElement.id, "token-2");

    pastePairing("5745", 2);
    assert.equal(pairingValue(), "5745");
    assert.equal(document.activeElement.id, "token-4");
    assert.equal(byId("pair").disabled, false);

    type("token-4", "");
    byId("token-4").focus();
    byId("token-4").fire("keydown", { key: "Backspace" });
    assert.equal(document.activeElement.id, "token-3");
    assert.equal(pairingValue(), "57");

    byId("token-3").fire("keydown", { key: "ArrowLeft" });
    assert.equal(document.activeElement.id, "token-2");
    byId("token-2").fire("keydown", { key: "ArrowRight" });
    assert.equal(document.activeElement.id, "token-3");
  } finally {
    restore();
  }
});

test("a short code ignores a stale saved port and exposes no URL controls", async () => {
  const messages = [];
  const restore = installGlobals(async (message) => {
    messages.push(message);
    return message.type === "popup.pair"
      ? state({ revision: 2, connected: true, endpoint })
      : state({ endpoint: otherEndpoint });
  });
  try {
    await import(`../dist/popup/index.js?stale-endpoint-hidden=${String(Math.random())}`);
    await nextTurn();
    assert.equal(byId("endpoint"), null);
    assert.equal(byId("connection-advanced"), null);
    typePairing(validToken);
    byId("pairing-form").fire("submit");
    await nextTurn();
    const pair = messages.find((message) => message.type === "popup.pair");
    assert.deepEqual(pair, { type: "popup.pair", endpoint, token: validToken });
  } finally {
    restore();
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
