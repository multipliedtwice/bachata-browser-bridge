import assert from "node:assert/strict";
import test from "node:test";

import {
  isIsoDate,
  strictBase64Bytes,
  validCapturedAssets,
  validCapturedSegments,
} from "../dist/background/capturedPayload.js";

const asset = (overrides = {}) => ({
  id: "asset-1",
  provider: "chatgpt",
  kind: "image",
  name: "diagram.png",
  sourceElement: "assistantMessage",
  downloadAvailable: true,
  ...overrides,
});

test("captured segments must be an array", () => {
  assert.equal(validCapturedSegments("", undefined), false);
  assert.equal(validCapturedSegments("", {}), false);
  assert.equal(validCapturedSegments("", "[]"), false);
});

test("an empty segment list only covers empty text", () => {
  assert.equal(validCapturedSegments("", []), true);
  assert.equal(validCapturedSegments("hello", []), false);
});

test("each segment must be a plain object", () => {
  assert.equal(validCapturedSegments("hi", [null]), false);
  assert.equal(validCapturedSegments("hi", ["hi"]), false);
  assert.equal(validCapturedSegments("hi", [[]]), false);
});

test("segments cover the text exactly and in order", () => {
  assert.equal(
    validCapturedSegments("abcd", [
      { type: "text", text: "ab", start: 0, end: 2 },
      { type: "quote", text: "cd", start: 2, end: 4 },
    ]),
    true,
  );
  assert.equal(
    validCapturedSegments("abcd", [{ type: "text", text: "ab", start: 0, end: 2 }]),
    false,
  );
  assert.equal(
    validCapturedSegments("abcd", [
      { type: "text", text: "cd", start: 2, end: 4 },
      { type: "text", text: "ab", start: 0, end: 2 },
    ]),
    false,
  );
});

test("a segment is rejected field by field", () => {
  const cases = [
    { type: "table", text: "ab", start: 0, end: 2 },
    { type: "text", text: 2, start: 0, end: 2 },
    { type: "text", text: "", start: 0, end: 0 },
    { type: "text", text: "ab", start: 0.5, end: 2 },
    { type: "text", text: "ab", start: 0, end: 2.5 },
    { type: "text", text: "ab", start: 1, end: 2 },
    { type: "text", text: "ab", start: 0, end: 0 },
    { type: "text", text: "ab", start: 0, end: 9 },
    { type: "text", text: "zz", start: 0, end: 2 },
    { type: "codeBlock", text: "ab", start: 0, end: 2, language: 7 },
    { type: "text", text: "ab", start: 0, end: 2, language: "ts" },
  ];
  for (const segment of cases) {
    assert.equal(validCapturedSegments("ab", [segment]), false, JSON.stringify(segment));
  }
});

test("a code block may declare a language", () => {
  assert.equal(
    validCapturedSegments("ab", [
      { type: "codeBlock", text: "ab", start: 0, end: 2, language: "ts" },
    ]),
    true,
  );
});

test("captured assets must be a bounded array", () => {
  assert.equal(validCapturedAssets("chatgpt", undefined), false);
  assert.equal(validCapturedAssets("chatgpt", {}), false);
  assert.equal(validCapturedAssets("chatgpt", []), true);
  const many = Array.from({ length: 101 }, (_, index) => asset({ id: `asset-${index}` }));
  assert.equal(validCapturedAssets("chatgpt", many), false);
  assert.equal(validCapturedAssets("chatgpt", many.slice(0, 100)), true);
});

test("each asset must be a plain object", () => {
  assert.equal(validCapturedAssets("chatgpt", [null]), false);
  assert.equal(validCapturedAssets("chatgpt", ["asset"]), false);
  assert.equal(validCapturedAssets("chatgpt", [[]]), false);
});

test("an asset carrying an unknown key is rejected", () => {
  assert.equal(validCapturedAssets("chatgpt", [asset({ href: "https://x.test/a" })]), false);
});

test("a minimal asset is accepted and optional fields stay optional", () => {
  assert.equal(validCapturedAssets("chatgpt", [asset()]), true);
  assert.equal(
    validCapturedAssets("chatgpt", [
      asset({
        mimeType: "image/png",
        size: 0,
        providerAssetId: "file-1",
        previewText: "preview",
        sourceOrigin: "https://cdn.test",
        kind: "generatedFile",
        sourceElement: "artifactPane",
      }),
    ]),
    true,
  );
});

test("an asset is rejected field by field", () => {
  const cases = [
    asset({ id: 7 }),
    asset({ id: "" }),
    asset({ id: "a".repeat(201) }),
    asset({ provider: "claude" }),
    asset({ kind: "video" }),
    asset({ name: 7 }),
    asset({ name: "   " }),
    asset({ name: "a".repeat(513) }),
    asset({ mimeType: 7 }),
    asset({ mimeType: "a".repeat(256) }),
    asset({ size: 1.5 }),
    asset({ size: -1 }),
    asset({ sourceElement: "sidebar" }),
    asset({ providerAssetId: 7 }),
    asset({ providerAssetId: "a".repeat(501) }),
    asset({ downloadAvailable: "yes" }),
    asset({ previewText: 7 }),
    asset({ previewText: "a".repeat(20_001) }),
    asset({ sourceOrigin: 7 }),
    asset({ sourceOrigin: `https://${"a".repeat(2_048)}.test` }),
    asset({ sourceOrigin: "not-an-origin" }),
  ];
  for (const candidate of cases) {
    assert.equal(validCapturedAssets("chatgpt", [candidate]), false, JSON.stringify(candidate));
  }
});

test("duplicate asset ids are rejected", () => {
  assert.equal(validCapturedAssets("chatgpt", [asset(), asset()]), false);
  assert.equal(
    validCapturedAssets("chatgpt", [asset(), asset({ id: "asset-2" })]),
    true,
  );
});

test("strict base64 rejects anything the decoder could not accept", () => {
  assert.equal(strictBase64Bytes(undefined), undefined);
  assert.equal(strictBase64Bytes(7), undefined);
  assert.equal(strictBase64Bytes(""), undefined);
  assert.equal(strictBase64Bytes("AAA"), undefined);
  assert.equal(strictBase64Bytes("AA=A"), undefined);
  assert.equal(strictBase64Bytes("A==="), undefined);
  assert.equal(strictBase64Bytes("A A="), undefined);
});

test("strict base64 decodes padded and unpadded groups", () => {
  assert.deepEqual(Array.from(strictBase64Bytes("AAAA") ?? []), [0, 0, 0]);
  assert.deepEqual(Array.from(strictBase64Bytes("/w==") ?? []), [255]);
  assert.deepEqual(Array.from(strictBase64Bytes("//8=") ?? []), [255, 255]);
});

test("an ISO date must be the canonical serialization of the instant it names", () => {
  assert.equal(isIsoDate("2026-09-02T10:00:00.000Z"), true);
  assert.equal(isIsoDate("2026-09-02T10:00:00Z"), false);
  assert.equal(isIsoDate("2026-09-02"), false);
  assert.equal(isIsoDate("not a date"), false);
  assert.equal(isIsoDate(7), false);
  assert.equal(isIsoDate(undefined), false);
});
