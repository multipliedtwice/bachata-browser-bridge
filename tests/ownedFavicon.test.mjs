import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";

test("a bridge-owned tab keeps only the Bachata favicon and can restore the page", async () => {
  const dom = createGenericDom("");
  let notifyMutation = () => undefined;
  const listeners = new Set();
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(callback) {
        notifyMutation = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
      },
    },
  });
  try {
    const original = document.createElement("link");
    original.rel = "icon";
    original.href = "https://chatgpt.com/favicon.ico";
    document.head.appendChild(original);

    await import(`../dist/content/ownedFavicon.js?${Date.now()}`);
    const marker = document.querySelector('[data-bachata-owned-favicon="true"]');
    assert.ok(marker);
    assert.match(marker.getAttribute("href"), /^data:image\/svg\+xml,/u);
    assert.deepEqual(Array.from(document.head.querySelectorAll('link[rel~="icon"]')), [marker]);
    assert.equal(original.parentNode, null);

    const replacement = document.createElement("link");
    replacement.rel = "icon";
    replacement.href = "https://chatgpt.com/new-favicon.ico";
    document.head.appendChild(replacement);
    notifyMutation();
    assert.deepEqual(Array.from(document.head.querySelectorAll('link[rel~="icon"]')), [marker]);
    assert.equal(replacement.parentNode, null);

    marker.rel = "alternate";
    marker.type = "image/png";
    marker.href = "https://chatgpt.com/overwritten-favicon.ico";
    notifyMutation();
    assert.equal(marker.rel, "icon");
    assert.equal(marker.type, "image/svg+xml");
    assert.match(marker.getAttribute("href"), /^data:image\/svg\+xml,/u);

    assert.equal(listeners.size, 1);
    let response;
    assert.equal([...listeners][0]({ type: "not-owned" }, {}, (value) => { response = value; }), undefined);
    assert.equal(response, undefined);
    assert.equal([...listeners][0]({ type: "bachata.ownership.release" }, {}, (value) => { response = value; }), undefined);
    assert.deepEqual(response, { success: true });
    assert.equal(listeners.size, 0);
    assert.equal(Boolean(document.querySelector('[data-bachata-owned-favicon="true"]')), false);
    assert.equal(original.parentNode, document.head);
    assert.equal(replacement.parentNode, document.head);
  } finally {
    dom.restore();
  }
});
