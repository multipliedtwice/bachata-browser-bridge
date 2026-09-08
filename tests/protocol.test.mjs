import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isHttpOrigin, parseServerMessage, protocolVersion } from "../dist/protocol/types.js";

const binding = {
  requestId: "request-1",
  agentId: "chatgpt",
  provider: "chatgpt",
  sessionId: "chatgpt:10:document-token",
  tabId: 10,
  frameId: 0,
  documentId: "document-10",
  documentToken: "document-token",
  conversationUrl: "https://chatgpt.com/c/example",
  conversationIdentity: "chatgpt:example",
};

test("server protocol accepts an exact bound conversation request", () => {
  const message = parseServerMessage({
    type: "conversation.send",
    protocolVersion,
    ...binding,
    text: "Carefully inspect the folder.",
    attachments: [],
    allowInitialConversationTransition: false,
    deadlineAt: Date.now() + 30_000,
  });

  assert.equal(message.type, "conversation.send");
  assert.equal(message.text, "Carefully inspect the folder.");
  assert.equal(message.documentToken, binding.documentToken);
  assert.equal(message.conversationUrl, binding.conversationUrl);
});

test("server protocol accepts interruption with the same document binding", () => {
  const message = parseServerMessage({
    type: "conversation.interrupt",
    protocolVersion,
    ...binding,
  });
  assert.equal(message.type, "conversation.interrupt");
  assert.equal(message.sessionId, binding.sessionId);
});

test("server protocol rejects interruption with a broken document binding", () => {
  assert.throws(
    () =>
      parseServerMessage({
        type: "conversation.interrupt",
        protocolVersion,
        ...binding,
        documentToken: "",
      }),
    /Invalid conversation\.interrupt message/u,
  );
  assert.throws(
    () =>
      parseServerMessage({
        type: "conversation.interrupt",
        protocolVersion,
        ...binding,
        extra: true,
      }),
    /Invalid conversation\.interrupt message/u,
  );
});

test("server protocol accepts lightweight keepalive pong", () => {
  assert.deepEqual(
    parseServerMessage({
      type: "bridge.pong",
      protocolVersion,
      nonce: "nonce-1",
    }),
    {
      type: "bridge.pong",
      protocolVersion,
      nonce: "nonce-1",
    },
  );
});

test("server protocol rejects an incomplete document binding", () => {
  assert.throws(
    () =>
      parseServerMessage({
        type: "conversation.send",
        protocolVersion,
        requestId: "request-1",
        agentId: "chatgpt",
        sessionId: "session-1",
        tabId: 10,
        frameId: 0,
        conversationUrl: "https://chatgpt.com/c/example",
        text: "Prompt",
      }),
    /Invalid conversation\.send message/,
  );
});

test("server protocol rejects unknown properties", () => {
  assert.throws(
    () =>
      parseServerMessage({
        type: "provider.discover",
        protocolVersion,
        hiddenPrompt: "not allowed",
      }),
    /Invalid provider\.discover message/,
  );
});

test("server protocol rejects a version mismatch", () => {
  assert.throws(
    () =>
      parseServerMessage({
        type: "bridge.connected",
        protocolVersion: protocolVersion + 1,
      }),
    /Invalid Bachata Browser Bridge message/,
  );
});


test("shared compatibility fixtures match the browser parser", () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(currentDirectory, "..", "protocol", "browser-protocol-v9.contract.json"),
      "utf8",
    ),
  );
  for (const fixture of contract.serverCompatibilityFixtures) {
    assert.doesNotThrow(
      () => parseServerMessage(fixture),
      `Rejected server fixture ${fixture.type}`,
    );
  }
});

test("server protocol rejects an invalid paired message", () => {
  assert.throws(
    () => parseServerMessage({ type: "bridge.paired", protocolVersion }),
    /Invalid bridge\.paired message/u,
  );
  assert.throws(
    () => parseServerMessage({ type: "bridge.paired", protocolVersion, connectionToken: 5, extra: true }),
    /Invalid bridge\.paired message/u,
  );
});

test("server protocol rejects an invalid pong message", () => {
  assert.throws(
    () => parseServerMessage({ type: "bridge.pong", protocolVersion }),
    /Invalid bridge\.pong message/u,
  );
  assert.throws(
    () => parseServerMessage({ type: "bridge.pong", protocolVersion, nonce: "" }),
    /Invalid bridge\.pong message/u,
  );
});

test("server protocol rejects an invalid local model config", () => {
  const valid = {
    type: "localModel.config",
    protocolVersion,
    enabled: true,
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "stub-model",
    timeoutMs: 5_000,
  };
  assert.doesNotThrow(() => parseServerMessage({ ...valid }));
  assert.doesNotThrow(() => parseServerMessage({
    type: "localModel.config",
    protocolVersion,
    enabled: false,
    backend: "ollama",
    model: "stub-model",
    timeoutMs: 5_000,
  }));
  assert.throws(
    () => parseServerMessage({ ...valid, backend: "remote" }),
    /Invalid localModel\.config message/u,
  );
  assert.throws(
    () => parseServerMessage({ ...valid, timeoutMs: 0 }),
    /Invalid localModel\.config message/u,
  );
});

test("server protocol validates the preferred origin on open conversation", () => {
  const base = {
    type: "provider.openConversation",
    protocolVersion,
    requestId: "request-origin",
    provider: "chatgpt",
    fresh: false,
  };
  assert.doesNotThrow(() => parseServerMessage({ ...base, preferredOrigin: "https://chatgpt.com" }));
  for (const preferredOrigin of [
    5,
    "not-a-url",
    "ftp://chatgpt.com",
    "https://chatgpt.com/",
    "https://chatgpt.com/?a=b",
    "https://chatgpt.com/#frag",
  ]) {
    assert.throws(
      () => parseServerMessage({ ...base, preferredOrigin }),
      /Invalid provider\.openConversation message/u,
    );
  }
  assert.throws(
    () => parseServerMessage({ ...base, preferredConversationIdentity: "" }),
    /Invalid provider\.openConversation message/u,
  );
  assert.throws(
    () => parseServerMessage({ ...base, preferredTabId: 0 }),
    /Invalid provider\.openConversation message/u,
  );
  assert.throws(
    () => parseServerMessage({ ...base, fresh: "yes" }),
    /Invalid provider\.openConversation message/u,
  );
});

test("server protocol rejects an invalid cancel open conversation message", () => {
  assert.throws(
    () => parseServerMessage({ type: "provider.cancelOpenConversation", protocolVersion }),
    /Invalid provider\.cancelOpenConversation message/u,
  );
  assert.throws(
    () => parseServerMessage({ type: "provider.cancelOpenConversation", protocolVersion, requestId: "r", extra: 1 }),
    /Invalid provider\.cancelOpenConversation message/u,
  );
});

test("server protocol rejects an invalid asset fetch message", () => {
  assert.doesNotThrow(() =>
    parseServerMessage({
      type: "asset.fetch",
      protocolVersion,
      transferId: "transfer-1",
      assetId: "asset-1",
      maxBytes: 1_024,
    }));
  assert.throws(
    () => parseServerMessage({ type: "asset.fetch", protocolVersion, transferId: "", assetId: "asset-1", maxBytes: 1_024 }),
    /Invalid asset\.fetch message/u,
  );
  assert.throws(
    () => parseServerMessage({ type: "asset.fetch", protocolVersion, transferId: "transfer-1", assetId: "asset-1", maxBytes: -1 }),
    /Invalid asset\.fetch message/u,
  );
});

test("server protocol rejects an invalid asset cancel message", () => {
  assert.doesNotThrow(() =>
    parseServerMessage({
      type: "asset.cancel",
      protocolVersion,
      transferId: "transfer-1",
      assetId: "asset-1",
    }));
  assert.throws(
    () => parseServerMessage({ type: "asset.cancel", protocolVersion, transferId: "transfer-1" }),
    /Invalid asset\.cancel message/u,
  );
});

test("server protocol rejects an invalid asset reveal message", () => {
  assert.doesNotThrow(() =>
    parseServerMessage({
      type: "asset.reveal",
      protocolVersion,
      requestId: "request-1",
      assetId: "asset-1",
    }));
  assert.throws(
    () => parseServerMessage({ type: "asset.reveal", protocolVersion, requestId: "request-1" }),
    /Invalid asset\.reveal message/u,
  );
});

test("server protocol rejects an invalid bridge error message", () => {
  assert.doesNotThrow(() =>
    parseServerMessage({
      type: "bridge.error",
      protocolVersion,
      code: "PROVIDER_ERROR",
      message: "failed",
    }));
  assert.throws(
    () => parseServerMessage({ type: "bridge.error", protocolVersion, code: "", message: "failed" }),
    /Invalid bridge\.error message/u,
  );
});

test("server protocol rejects unsupported message types", () => {
  assert.throws(
    () => parseServerMessage({ type: "bridge.nonsense", protocolVersion }),
    /Unsupported bridge message type: bridge\.nonsense/u,
  );
});

// Every value the asset producer can emit for `sourceOrigin`, kept beside the parser that decides
// whether the background may forward it. The producer and this validator disagreeing is what made
// a valid captured asset fail the whole conversation.response.
const capturedAssetSourceOrigins = {
  valid: ["https://chatgpt.com", "https://claude.ai", "https://cdn.example.invalid:8443"],
  invalid: [
    "null",
    "blob:https://chatgpt.com",
    "data:text/plain,ok",
    "https://cdn.example.invalid/generated/report.txt",
    "https://cdn.example.invalid?q=1",
    "https://cdn.example.invalid#fragment",
    "HTTPS://CDN.EXAMPLE.INVALID",
    "",
    " https://cdn.example.invalid",
  ],
};

test("captured asset source origins are accepted only in canonical http(s) origin form", () => {
  for (const value of capturedAssetSourceOrigins.valid) {
    assert.equal(isHttpOrigin(value), true, `Rejected canonical origin ${value}`);
  }
  for (const value of capturedAssetSourceOrigins.invalid) {
    assert.equal(isHttpOrigin(value), false, `Accepted noncanonical origin ${JSON.stringify(value)}`);
  }
});

test("the shared contract asset fixture carries a canonical source origin", () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(currentDirectory, "..", "protocol", "browser-protocol-v9.contract.json"),
      "utf8",
    ),
  );
  const response = contract.clientCompatibilityFixtures.find(
    (fixture) => fixture.type === "conversation.response",
  );
  assert.notEqual(response, undefined);
  for (const asset of response.assets) {
    if (asset.sourceOrigin === undefined) continue;
    assert.equal(isHttpOrigin(asset.sourceOrigin), true, `Fixture origin ${asset.sourceOrigin}`);
  }
  assert.equal(response.assets.some((asset) => asset.sourceOrigin !== undefined), true);
});

// BB-AUD-06. The Extension parser rejects a segment that carries no text or does not
// advance. This side proves the producers never emit one, so the two ends agree on the
// same contract rather than one end merely tolerating the other.
test("every contract response fixture carries only advancing, non-empty segments", () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(currentDirectory, "..", "protocol", "browser-protocol-v9.contract.json"),
      "utf8",
    ),
  );
  const responses = contract.clientCompatibilityFixtures.filter(
    (fixture) => fixture.type === "conversation.response",
  );
  assert.ok(responses.length > 0, "the contract carries no conversation.response fixture");
  for (const response of responses) {
    let cursor = 0;
    for (const segment of response.segments ?? []) {
      assert.ok(segment.text.length > 0, `${response.type} carries an empty segment`);
      assert.ok(segment.end > segment.start, `${response.type} carries a non-advancing segment`);
      assert.equal(segment.start, cursor, `${response.type} segments do not tile in order`);
      cursor = segment.end;
    }
    assert.equal(cursor, response.text.length, `${response.type} segments do not cover its text`);
  }
});
