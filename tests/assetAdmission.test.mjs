import assert from "node:assert/strict";
import test from "node:test";

import { admitAssetFetch } from "../dist/background/assetAdmission.js";

// BB-AUD-09. Whether a controller's `asset.fetch` may open a transfer. Every accepted and
// refused outcome is driven here directly, with no socket, no Chrome and no capture: the
// decision reads state and answers with a verdict, so that is what is asserted.

const binding = (overrides = {}) => ({
  provider: "chatgpt",
  tabId: 7,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "token-1",
  conversationUrl: "https://chatgpt.com/c/one",
  conversationIdentity: "chatgpt:one",
  ...overrides,
});

const registered = (overrides = {}) => ({
  asset: { id: "asset-1", downloadAvailable: true, ...(overrides.asset ?? {}) },
  binding: overrides.binding ?? binding(),
});

const request = (overrides = {}) => ({
  transferId: "transfer-1",
  assetId: "asset-1",
  maxBytes: 1_024,
  ...overrides,
});

const admit = (overrides = {}) =>
  admitAssetFetch({
    request: request(),
    registered: registered(),
    currentDocument: binding(),
    transferIdInUse: false,
    ...overrides,
  });

test("an asset no document still holds is refused as unavailable", () => {
  const verdict = admit({ registered: undefined, currentDocument: undefined });
  assert.deepEqual(verdict, {
    verdict: "asset-unknown",
    code: "ASSET_UNAVAILABLE",
    message: "The browser asset is no longer available",
    forgetAsset: false,
  });
});

test("a recovered asset that is not the one asked for is refused rather than transferred", () => {
  // The recovery path answers with whatever a document reported; the admission is what refuses
  // to open a transfer for an asset the controller did not name.
  const verdict = admit({ registered: registered({ asset: { id: "asset-other" } }) });
  assert.equal(verdict.verdict, "asset-unknown");
  assert.equal(verdict.code, "ASSET_UNAVAILABLE");
});

test("an asset that exists but cannot be downloaded is refused with the same words", () => {
  const verdict = admit({ registered: registered({ asset: { downloadAvailable: false } }) });
  assert.equal(verdict.verdict, "asset-not-downloadable");
  assert.equal(verdict.code, "ASSET_UNAVAILABLE");
  assert.equal(verdict.message, "The browser asset is no longer available");
  assert.equal(verdict.forgetAsset, false);
});

test("a transfer id already in use is refused instead of replacing the open transfer", () => {
  const verdict = admit({ transferIdInUse: true });
  assert.deepEqual(verdict, {
    verdict: "transfer-exists",
    code: "TRANSFER_EXISTS",
    message: "The browser asset transfer already exists",
    forgetAsset: false,
  });
});

test("a transfer id in use is refused even when the document has also changed", () => {
  // Order is behaviour: a request that fails more than one check is refused with the code it
  // was refused with before the decision moved out of the entry.
  const verdict = admit({ transferIdInUse: true, currentDocument: undefined });
  assert.equal(verdict.code, "TRANSFER_EXISTS");
});

test("an asset whose tab now holds no document is refused, and the asset is forgotten", () => {
  const verdict = admit({ currentDocument: undefined });
  assert.deepEqual(verdict, {
    verdict: "document-changed",
    code: "ASSET_DOCUMENT_CHANGED",
    message: "The browser document that produced the asset has changed",
    forgetAsset: true,
  });
});

test("every part of the document binding is part of the admission's ownership check", () => {
  for (const change of [
    { provider: "claude" },
    { tabId: 8 },
    { frameId: 1 },
    { documentId: "doc-2" },
    { documentToken: "token-2" },
    { conversationIdentity: "chatgpt:two" },
  ]) {
    const verdict = admit({ currentDocument: binding(change) });
    assert.equal(verdict.verdict, "document-changed", JSON.stringify(change));
    assert.equal(verdict.forgetAsset, true);
  }
  // A binding that differs only in the conversation URL is the same document: the identity is
  // what the transfer is bound to, and a canonicalised URL change alone does not break it.
  const sameDocument = admit({ currentDocument: binding({ conversationUrl: "https://chatgpt.com/c/one?x=1" }) });
  assert.equal(sameDocument.verdict, "admitted");
});

test("a byte budget that is not a usable count is refused before a transfer opens", () => {
  for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
    const verdict = admit({ request: request({ maxBytes }) });
    assert.equal(verdict.verdict, "budget-invalid", String(maxBytes));
    assert.equal(verdict.code, "ASSET_REQUEST_INVALID");
    assert.equal(verdict.message, "The browser asset transfer budget is not a usable byte count");
    assert.equal(verdict.forgetAsset, false);
  }
  assert.equal(admit({ request: request({ maxBytes: 1 }) }).verdict, "admitted");
  assert.equal(admit({ request: request({ maxBytes: Number.MAX_SAFE_INTEGER }) }).verdict, "admitted");
});

test("an admitted transfer carries the exact state a transfer begins with", () => {
  const verdict = admit();
  assert.equal(verdict.verdict, "admitted");
  assert.deepEqual(verdict.transfer, {
    transferId: "transfer-1",
    assetId: "asset-1",
    binding: binding(),
    maxBytes: 1_024,
    receivedBytes: 0,
    nextSequence: 0,
    started: false,
  });
});

test("an admitted transfer holds a copy of the binding, not the registration's own", () => {
  const source = registered();
  const verdict = admitAssetFetch({
    request: request(),
    registered: source,
    currentDocument: binding(),
    transferIdInUse: false,
  });
  assert.equal(verdict.verdict, "admitted");
  assert.notEqual(verdict.transfer.binding, source.binding);
  source.binding.documentToken = "token-rebound";
  assert.equal(verdict.transfer.binding.documentToken, "token-1");
});
