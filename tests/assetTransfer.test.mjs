import assert from "node:assert/strict";
import test from "node:test";

import {
  assetFetchAckRejected,
  assetOrderAfterRegistration,
  parseAssetChunk,
  parseAssetCompletion,
  parseAssetStart,
} from "../dist/background/assetTransfer.js";

// BB-AUD-09. These judgements sat in the service-worker entry beside the socket send and the
// `chrome.tabs` call that act on them, so an out-of-order chunk or an over-budget completion
// could only be reached by driving a whole capture against a live browser.

const transfer = (overrides = {}) => ({
  maxBytes: 1_000,
  receivedBytes: 0,
  nextSequence: 0,
  started: false,
  ...overrides,
});

test("a start frame is accepted once, with a usable name", () => {
  assert.deepEqual(parseAssetStart(transfer(), { name: "diagram.png" }), { name: "diagram.png" });
  assert.equal(parseAssetStart(transfer({ started: true }), { name: "diagram.png" }), undefined);
  assert.equal(parseAssetStart(transfer(), { name: 7 }), undefined);
  assert.equal(parseAssetStart(transfer(), {}), undefined);
  assert.equal(parseAssetStart(transfer(), { name: "   " }), undefined);
  assert.equal(parseAssetStart(transfer(), { name: "a".repeat(513) }), undefined);
});

test("a start frame carries only a usable mime type", () => {
  assert.equal(
    parseAssetStart(transfer(), { name: "a", mimeType: "image/png" })?.mimeType,
    "image/png",
  );
  assert.equal(parseAssetStart(transfer(), { name: "a", mimeType: 5 }), undefined);
  assert.equal(
    parseAssetStart(transfer(), { name: "a", mimeType: "x".repeat(256) }),
    undefined,
  );
});

test("a declared size has to fit the budget the controller granted", () => {
  assert.equal(parseAssetStart(transfer(), { name: "a", size: 1_000 })?.size, 1_000);
  assert.equal(parseAssetStart(transfer(), { name: "a", size: 1_001 }), undefined);
  assert.equal(parseAssetStart(transfer(), { name: "a", size: -1 }), undefined);
  assert.equal(parseAssetStart(transfer(), { name: "a", size: 1.5 }), undefined);
  assert.equal(parseAssetStart(transfer(), { name: "a", size: "10" }), undefined);
  assert.equal(
    Object.hasOwn(parseAssetStart(transfer(), { name: "a" }) ?? {}, "size"),
    false,
  );
});

test("a chunk is accepted only in sequence and inside the budget", () => {
  const started = transfer({ started: true, nextSequence: 3, receivedBytes: 900 });
  assert.deepEqual(
    parseAssetChunk(started, { sequence: 3 }, { byteLength: 100 }),
    { sequence: 3, byteLength: 100 },
  );
  assert.equal(parseAssetChunk(started, { sequence: 3 }, { byteLength: 101 }), undefined);
  assert.equal(parseAssetChunk(started, { sequence: 4 }, { byteLength: 1 }), undefined);
  assert.equal(parseAssetChunk(started, { sequence: 2 }, { byteLength: 1 }), undefined);
  assert.equal(parseAssetChunk(started, { sequence: 3.5 }, { byteLength: 1 }), undefined);
  assert.equal(parseAssetChunk(started, { sequence: "3" }, { byteLength: 1 }), undefined);
  assert.equal(parseAssetChunk(started, { sequence: 3 }, undefined), undefined);
  assert.equal(
    parseAssetChunk(transfer({ nextSequence: 3 }), { sequence: 3 }, { byteLength: 1 }),
    undefined,
  );
});

test("completion has to match what the transfer actually received", () => {
  const started = transfer({ started: true, receivedBytes: 64 });
  const sha256 = "a".repeat(64);
  assert.deepEqual(parseAssetCompletion(started, { size: 64, sha256 }), { size: 64, sha256 });
  assert.equal(parseAssetCompletion(started, { size: 65, sha256 }), undefined);
  assert.equal(parseAssetCompletion(started, { size: "64", sha256 }), undefined);
  assert.equal(parseAssetCompletion(started, { size: 64.5, sha256 }), undefined);
  assert.equal(parseAssetCompletion(transfer({ receivedBytes: 64 }), { size: 64, sha256 }), undefined);
});

test("completion has to match the size the start frame declared", () => {
  const sha256 = "b".repeat(64);
  const declared = transfer({ started: true, receivedBytes: 64, declaredSize: 64 });
  assert.equal(parseAssetCompletion(declared, { size: 64, sha256 })?.size, 64);
  const mismatched = transfer({ started: true, receivedBytes: 64, declaredSize: 32 });
  assert.equal(parseAssetCompletion(mismatched, { size: 64, sha256 }), undefined);
});

test("completion has to carry a digest of the right shape", () => {
  const started = transfer({ started: true, receivedBytes: 1 });
  assert.equal(parseAssetCompletion(started, { size: 1, sha256: "short" }), undefined);
  assert.equal(parseAssetCompletion(started, { size: 1, sha256: 64 }), undefined);
  assert.equal(parseAssetCompletion(started, { size: 1, sha256: "g".repeat(64) }), undefined);
  assert.equal(parseAssetCompletion(started, { size: 1, sha256: "A".repeat(64) })?.size, 1);
});

test("registering assets keeps one bounded most-recent list", () => {
  assert.deepEqual(assetOrderAfterRegistration([], ["a", "b"], 10), {
    order: ["a", "b"],
    evicted: [],
  });
  assert.deepEqual(assetOrderAfterRegistration(["a", "b", "c"], ["a"], 10), {
    order: ["b", "c", "a"],
    evicted: [],
  });
  assert.deepEqual(assetOrderAfterRegistration(["a", "b", "c"], ["d"], 2), {
    order: ["c", "d"],
    evicted: ["a", "b"],
  });
});

test("a repeated id inside one registration lands once, at its last position", () => {
  assert.deepEqual(assetOrderAfterRegistration([], ["a", "b", "a"], 10), {
    order: ["b", "a"],
    evicted: [],
  });
});

test("a content script that does not accept the fetch has refused it", () => {
  assert.equal(assetFetchAckRejected({ success: false }, true), true);
  assert.equal(assetFetchAckRejected({ accepted: false }, true), true);
  assert.equal(assetFetchAckRejected({ success: true }, true), false);
  assert.equal(assetFetchAckRejected({ accepted: true }, true), false);
});

test("an empty answer counts as a refusal only while the transfer is still live", () => {
  assert.equal(assetFetchAckRejected({}, true), true);
  assert.equal(assetFetchAckRejected({}, false), false);
  assert.equal(assetFetchAckRejected(undefined, true), true);
  assert.equal(assetFetchAckRejected(undefined, false), false);
});
