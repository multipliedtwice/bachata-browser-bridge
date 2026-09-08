import { setTimeout as delay } from "node:timers/promises";

export const waitForSetup = async (condition) => {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Setup did not reach the expected UI state");
    await delay(1);
  }
};

export const prepareGenericSetupDom = (document) => {
  const shadows = new Map();
  let focused;
  const original = document.createElement.bind(document);
  const define = (target, key, value) => Object.defineProperty(target, key, { configurable: true, writable: true, value });
  define(document, "createElement", (tag) => {
    const element = original(tag);
    define(element, "append", (...nodes) => nodes.forEach((node) => element.appendChild(node)));
    define(element, "replaceChildren", (...nodes) => {
      while (element.firstChild) element.removeChild(element.firstChild);
      element.append(...nodes);
    });
    define(element, "focus", () => { focused = element; });
    const query = element.querySelectorAll.bind(element);
    define(element, "querySelectorAll", (selector) => Array.from(query(selector)));
    define(element, "attachShadow", () => {
      const root = document.createElement("div");
      shadows.set(element, root);
      return root;
    });
    return element;
  });
  define(document.documentElement, "append", (...nodes) => nodes.forEach((node) => document.documentElement.appendChild(node)));
  return { panel: () => [...shadows.values()].at(-1), focused: () => focused, shadows };
};
