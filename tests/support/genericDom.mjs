import domino from "@mixmark-io/domino";

/**
 * A DOM for the generic content modules.
 *
 * The generic provider reasons about a page it did not write: it resolves locators, decides
 * what is visible, walks message containers and turns one of them into Markdown. Those are
 * DOM behaviours, so they are tested against a real DOM implementation rather than against a
 * hand-written stand-in that would agree with whatever the code happens to do.
 *
 * Layout is the one thing the implementation cannot supply: nothing is laid out here, so a
 * rect and a computed style are attached per element and default to visible.
 */

const define = (target, name, value) => {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
};

const VISIBLE_STYLE = { display: "block", visibility: "visible", opacity: "1" };

const styleFor = (element) => {
  const overrides = element?.bachataStyle ?? {};
  const style = { ...VISIBLE_STYLE, ...overrides };
  return {
    ...style,
    getPropertyValue: (name) => style[name] ?? "",
  };
};

const rectFor = (element) => element?.bachataRect ?? { x: 0, y: 0, width: 120, height: 24 };

export const createGenericDom = (html) => {
  const window = domino.createWindow(`<html><body>${html}</body></html>`);
  const document = window.document;
  const elementPrototype = domino.impl.Element.prototype;

  define(elementPrototype, "getBoundingClientRect", function getBoundingClientRect() {
    const rect = rectFor(this);
    return {
      ...rect,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    };
  });
  define(elementPrototype, "scrollIntoView", () => undefined);
  // Domino answers some selectors with a plain array-like rather than a NodeList, and the
  // content modules walk query results with for-of, as a browser allows. Answering with a
  // real array keeps every query iterable without changing what it finds.
  const iterableResults = (original) => function querySelectorAll(selector) {
    return Array.from(original.call(this, selector));
  };
  // The prototype's method is not configurable, so the document this test drives carries the
  // wrapper as its own property.
  define(document, "querySelectorAll", iterableResults(document.querySelectorAll));
  // A class list is iterable in a browser, and the Markdown capture spreads one.
  const tokenListPrototype = Object.getPrototypeOf(document.createElement("div").classList);
  if (typeof tokenListPrototype[Symbol.iterator] !== "function") {
    define(tokenListPrototype, Symbol.iterator, Array.prototype[Symbol.iterator]);
  }
  if (!("isContentEditable" in elementPrototype)) {
    Object.defineProperty(elementPrototype, "isContentEditable", {
      configurable: true,
      get() {
        const value = this.getAttribute("contenteditable");
        return value !== null && value !== "false";
      },
    });
  }
  define(window, "getComputedStyle", (element) => styleFor(element));

  const saved = new Map();
  const globals = {
    window,
    document,
    Node: domino.impl.Node,
    Element: domino.impl.Element,
    HTMLElement: domino.impl.HTMLElement,
    HTMLTextAreaElement: domino.impl.HTMLTextAreaElement,
    HTMLInputElement: domino.impl.HTMLInputElement,
    // Candidate classification asks what an element is, and a button is one of the answers.
    HTMLButtonElement: domino.impl.HTMLButtonElement,
    // Candidate scoring compares a rect against the viewport, which domino does not model.
    innerHeight: 900,
    innerWidth: 1440,
    // The generic content entry reads the current route to notice navigation, and listens for
    // the two navigation events that cross into an isolated world.
    location: window.location,
    crypto: globalThis.crypto,
    queueMicrotask: globalThis.queueMicrotask,
    addEventListener: (...args) => window.addEventListener(...args),
    removeEventListener: (...args) => window.removeEventListener(...args),
    dispatchEvent: (...args) => window.dispatchEvent(...args),
    // Domino refuses an event built by another realm's constructor, and Node supplies its own
    // `Event` globally. Writing to a composer dispatches input and change, so the page's own
    // constructors are what the content modules must see.
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    // Domino models neither of these. An InputEvent is an Event carrying inputType and data; a
    // KeyboardEvent is an Event carrying key and code. Both are dispatched, never inspected by
    // the code under test, so the fields are what matters and the class identity is not.
    InputEvent: class InputEvent extends window.Event {
      constructor(type, init = {}) {
        super(type, init);
        this.inputType = init.inputType ?? "";
        this.data = init.data ?? null;
      }
    },
    KeyboardEvent: class KeyboardEvent extends window.Event {
      constructor(type, init = {}) {
        super(type, init);
        this.key = init.key ?? "";
        this.code = init.code ?? "";
      }
    },
    // No layout, so no selection. The composer path falls back to textContent, which is what a
    // page without execCommand does too.
    getSelection: () => null,
    getComputedStyle: (element) => styleFor(element),
    // Domino ships no CSS namespace; escaping is what the locator uses it for.
    CSS: { escape: (value) => String(value).replace(/[^\w-]/gu, (character) => `\\${character}`) },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  };
  Object.entries(globals).forEach(([name, value]) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    define(globalThis, name, value);
  });

  return {
    window,
    document,
    query: (selector) => document.querySelector(selector),
    queryAll: (selector) => Array.from(document.querySelectorAll(selector)),
    /** Nothing is laid out here, so being invisible is stated rather than measured. */
    hide: (element, how = { display: "none" }) => {
      element.bachataStyle = how;
      return element;
    },
    resize: (element, rect) => {
      element.bachataRect = rect;
      return element;
    },
    restore: () => {
      saved.forEach((descriptor, name) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      });
      saved.clear();
    },
  };
};
