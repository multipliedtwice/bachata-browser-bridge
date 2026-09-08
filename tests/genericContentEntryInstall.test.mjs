import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";

// REVIEW-11 / BB-5. The entry installs its listener at import and guards against installing a
// second one. Proving that needs the module loaded twice, which needs two module URLs, which
// makes V8 attribute both runs to one file and report the skipped one. So it lives here, alone,
// where no coverage claim depends on it.

const dom = createGenericDom("<main id=\"root\"></main>");

const listeners = [];
const saved = new Map();
const define = (name, value) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const realSetTimeout = globalThis.setTimeout;
define("setTimeout", (callback, delayMs, ...args) => {
  const handle = realSetTimeout(callback, delayMs, ...args);
  handle.unref?.();
  return handle;
});

define("chrome", {
  runtime: {
    id: "bachata-bridge-test",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: async () => ({ ok: true }),
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
});

await import("../dist/content/generic/index.js");

test.after(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test("the entry installs exactly one listener and marks the document as bound", () => {
  assert.equal(listeners.length, 1);
  assert.equal(dom.window.__BACHATA_GENERIC_CONTENT_INSTALLED__, true);
});

test("the entry installs only once, however many times it is loaded", async () => {
  const before = listeners.length;
  await import("../dist/content/generic/index.js?second");
  assert.equal(listeners.length, before, "a second load installed a second listener");
});
