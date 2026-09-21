import assert from "node:assert/strict";
import test from "node:test";
import { bindProvisionalCreation, normalizeConversationRegistry, promoteCreatedConversation, maximumProvisionalCreations, provisionalCreationLifetimeMs } from "../dist/background/conversationRegistry.js";
import { storedStateFrom, migratedStoredCandidate, storageKey } from "../dist/background/routerState.js";
import { isStableRecoveryIdentity, maximumRecoverableConversations } from "../dist/protocol/recovery.js";

const id = (index) => `12345678-1234-4234-8234-${String(index).padStart(12, "0")}`;
const entry = (index = 1) => ({ id: id(index), provider: "chatgpt", conversationUrl: `https://chatgpt.com/c/chat-${index}`, conversationIdentity: `chatgpt:https://chatgpt.com/c/chat-${index}`, createdAt: 1000, updatedAt: 1000 + index });
const registry = (records) => ({ version: 1, records });
const initial = { provider: "chatgpt", tabId: 5, frameId: 0, documentId: "doc", documentToken: "token", conversationUrl: "https://chatgpt.com/", conversationIdentity: "chatgpt:https://chatgpt.com/", status: "ready" };
const marker = bindProvisionalCreation({ id: id(1), provider: "chatgpt", tabId: 5, createdAt: 1000 }, initial);
const binding = { ...initial, conversationUrl: entry().conversationUrl, conversationIdentity: entry().conversationIdentity };
const request = { ...binding, initialConversationUrl: initial.conversationUrl, transitionUsed: true, submissionCommitted: true };
const promote = (overrides = {}) => promoteCreatedConversation({ registry: undefined, marker, request, binding, now: 2000, ...overrides });

test("registry normalization rejects unknown versions and malformed envelopes", () => {
  for (const value of [null, [], "bad", {}, { version: 2, records: [entry()] }, { version: 1, records: "bad" }, { version: 1, records: [entry()], prompt: "private" }, registry(Array(1001).fill(entry()))]) {
    assert.deepEqual(normalizeConversationRegistry(value), registry([]));
  }
});
test("registry normalization drops corrupt, private, noncanonical and unsupported entries", () => {
  const bad = [
    { id: "tab-5" }, { provider: "generic" }, { provider: "claude" }, { createdAt: -1 }, { createdAt: 1002 }, { updatedAt: Infinity },
    { prompt: "private" }, { title: "private" }, { tabId: 5 }, { conversationIdentity: "chatgpt:other" },
    ...["https://chatgpt.com/", "https://chatgpt.com/c/", "https://chatgpt.com/c/a/", "https://chatgpt.com/c/a?x=1", "https://chatgpt.com/c/a#x", "https://chatgpt.com:443/c/a", "https://user:secret@chatgpt.com/c/a", "http://chatgpt.com/c/a", "https://evil.test/c/a", "https://chatgpt.com/c/a/b", "https://chatgpt.com/c/%61", `https://chatgpt.com/c/${"a".repeat(3000)}`].map((conversationUrl) => ({ conversationUrl, conversationIdentity: `chatgpt:${conversationUrl}` })),
  ];
  for (const patch of bad) assert.deepEqual(normalizeConversationRegistry(registry([{ ...entry(), ...patch }])), registry([]), JSON.stringify(patch));
  assert.equal(isStableRecoveryIdentity("claude", "https://claude.ai/chat/abc", "claude:https://claude.ai/chat/abc"), true);
  assert.equal(isStableRecoveryIdentity("claude", "https://claude.ai/chats/abc", "claude:https://claude.ai/chats/abc"), true);
});

test("duplicate IDs and identities drop every conflicting entry deterministically", () => {
  for (const records of [[entry(), entry()], [entry(), { ...entry(2), id: id(1) }], [entry(), { ...entry(), id: id(2) }]]) {
    assert.deepEqual(normalizeConversationRegistry(registry(records)), registry([]));
    assert.deepEqual(normalizeConversationRegistry(registry(records.reverse())), registry([]));
  }
});

test("retention keeps the newest 50 with deterministic ID ordering on ties", () => {
  assert.equal(maximumRecoverableConversations, 50);
  assert.equal(maximumProvisionalCreations, 16);
  const records = Array.from({ length: 60 }, (_, index) => entry(index + 1));
  const result = normalizeConversationRegistry(registry(records));
  assert.equal(result.records.length, 50);
  assert.equal(result.records[0].id, id(60));
  assert.equal(result.records.at(-1).id, id(11));
  assert.deepEqual(normalizeConversationRegistry(registry(records.reverse())), result);
  const tied = records.map((record) => ({ ...record, updatedAt: 2000 }));
  assert.equal(normalizeConversationRegistry(registry(tied)).records[0].id, id(1));
});

test("normalization and old pairing migration retain valid state without inventing created chats", () => {
  const legacy = { endpoint: "ws://127.0.0.1:43123/pair-browser-bridge-v7", connectionToken: "token", handledTabIds: [5], selectedTabId: 5, selectedSessionId: "selected" };
  const migrated = storedStateFrom(migratedStoredCandidate(undefined, [legacy])).state;
  assert.equal(storageKey, "bachataBridgeState.v8");
  assert.equal(migrated.endpoint, "ws://127.0.0.1:43123/bachata-browser-bridge-v9");
  assert.equal(migrated.connectionToken, "token");
  assert.deepEqual(migrated.handledTabIds, [5]);
  assert.equal(migrated.conversationRegistry, undefined);
  assert.deepEqual(storedStateFrom({ ...migrated, conversationRegistry: registry([entry()]) }).state.conversationRegistry, registry([entry()]));
});

test("a created initial document promotes only after an accepted committed transition", () => {
  const result = promote();
  assert.deepEqual(result, registry([{ ...entry(), updatedAt: 2000 }]));
  assert.deepEqual(Object.keys(result.records[0]).sort(), ["id", "provider", "conversationUrl", "conversationIdentity", "createdAt", "updatedAt"].sort());
  for (const patch of [{ transitionUsed: false }, { submissionCommitted: false }, { documentToken: "other" }, { documentId: "other" }, { tabId: 6 }, { initialConversationUrl: "https://chatgpt.com/c/user" }]) {
    assert.equal(promote({ request: { ...request, ...patch } }), undefined);
  }
});

test("discovered, selected, unbound, expired and failed creations cannot promote", () => {
  assert.equal(promote({ marker: undefined }), undefined);
  assert.equal(promote({ marker: { id: id(1), provider: "chatgpt", tabId: 5, createdAt: 1000 } }), undefined);
  assert.equal(promote({ now: 1000 + provisionalCreationLifetimeMs + 1 }), undefined);
  assert.equal(promote({ now: 999 }), undefined);
  assert.equal(promote({ binding: { ...binding, documentToken: "different" } }), undefined);
  assert.equal(promote({ binding: { ...binding, conversationUrl: "https://chatgpt.com/" } }), undefined);
  assert.equal(promote({ registry: registry([entry()]) }), undefined);
  for (const patch of [{ provider: "generic" }, { status: "notAuthenticated" }, { conversationUrl: "https://chatgpt.com/c/user" }, { documentToken: "" }, { tabId: 10 }]) {
    assert.equal(bindProvisionalCreation(marker, { ...initial, ...patch }), undefined);
  }
});
