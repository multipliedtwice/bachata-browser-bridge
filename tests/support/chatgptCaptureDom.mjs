import domino from "@mixmark-io/domino";

// A production-entry fixture for the ChatGPT capture loop backed by a real DOM implementation.
// The hand-rolled element stubs elsewhere in this suite answer the queries a test writes; they
// cannot answer `closest`, subtree queries, reparenting or node identity the way a page does, and
// the completion state machine is defined in exactly those terms. Only the handful of APIs domino
// does not implement are shimmed here, each to the narrowest behaviour the adapter relies on.

const define = (target, name, value) => {
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
};

// Domino's prototypes are module state shared by every fixture in the process, so each patch is
// recorded and put back exactly as it was.
const patchPrototype = (restorers) => (target, name, descriptor) => {
  restorers.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
};

export const createChatGptCaptureDom = ({
  url = "https://chatgpt.com/c/capture",
  body = `
    <main>
      <div id="thread"></div>
      <form>
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button"></button>
      </form>
    </main>
  `,
} = {}) => {
  const window = domino.createWindow(`<html><body>${body}</body></html>`, url);
  const document = window.document;
  const elementPrototype = domino.impl.Element.prototype;
  const restorers = [];
  const patch = patchPrototype(restorers);
  let innerHtmlReads = 0;
  let innerTextReads = 0;

  // Domino already implements `innerText`, `isConnected` and a dispatching `click`, so the adapter
  // reads and activates the page through the real implementations. Only what domino omits is
  // added, each to the narrowest behaviour the adapter relies on.
  // Domino exposes `activeElement` as a getter, and focus is not modelled at all. The adapter
  // only asks who has focus, so the fixture keeps that answer itself.
  let activeElement;
  patch(document, "activeElement", { get: () => activeElement });
  patch(elementPrototype, "focus", {
    writable: true,
    value: function focus() {
      activeElement = this;
    },
  });
  patch(elementPrototype, "scrollIntoView", { writable: true, value: () => undefined });
  patch(elementPrototype, "getBoundingClientRect", { writable: true, value: function getBoundingClientRect() {
    const rect = this.bachataRect ?? { x: 0, y: 0, width: 120, height: 24 };
    return {
      ...rect,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    };
  } });
  patch(elementPrototype, "replaceChildren", {
    writable: true,
    value: function replaceChildren(...nodes) {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (const node of nodes) this.appendChild(node);
    },
  });

  // Domino declares `innerHTML` non-configurable on its prototype, so serialization is counted on
  // the exact nodes the completion-evidence path would read. Own properties shadow the prototype
  // accessor and are discarded with the node.
  const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, "innerHTML");
  const countInnerHtml = (element) => {
    Object.defineProperty(element, "innerHTML", {
      configurable: true,
      get() {
        innerHtmlReads += 1;
        return innerHtmlDescriptor.get.call(this);
      },
      set(value) {
        innerHtmlDescriptor.set.call(this, value);
      },
    });
    return element;
  };

  // Reader faults are injected where the adapter actually reads the answer. `shouldThrow` receives
  // the 1-based read count and returns an error to raise, or nothing to let the real getter answer.
  const innerTextDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, "innerText");
  const failInnerText = (element, shouldThrow) => {
    let reads = 0;
    Object.defineProperty(element, "innerText", {
      configurable: true,
      get() {
        reads += 1;
        innerTextReads += 1;
        const failure = shouldThrow(reads);
        if (failure) throw failure;
        return innerTextDescriptor.get.call(this);
      },
      set(value) {
        innerTextDescriptor.set.call(this, value);
      },
    });
    return element;
  };

  // A fault positioned after the alert read: the adapter asks the document for the Stop control
  // once per look, so failing that query lands the fault later in the same observation.
  const failStopQuery = (shouldThrow) => {
    const original = document.querySelectorAll.bind(document);
    let queries = 0;
    define(document, "querySelectorAll", (selector) => {
      if (String(selector).includes("stop-button")) {
        queries += 1;
        const failure = shouldThrow(queries);
        if (failure) throw failure;
      }
      return original(selector);
    });
  };

  const failGetAttribute = (element, shouldThrow) => {
    const original = element.getAttribute.bind(element);
    let reads = 0;
    define(element, "getAttribute", (name) => {
      reads += 1;
      const failure = shouldThrow(reads, name);
      if (failure) throw failure;
      return original(name);
    });
    return element;
  };

  const html = (markup) => {
    const holder = document.createElement("div");
    holder.innerHTML = markup;
    return holder.firstElementChild;
  };

  const saved = new Map();
  const observedTargets = [];
  const intervals = [];
  const sent = [];
  const listeners = [];
  const location = { href: url, pathname: new URL(url).pathname, origin: new URL(url).origin };

  // The adapter dispatches real events at the composer, and domino refuses anything that is not
  // an initialized event of its own. Construct one and carry the fields the page would see.
  class FixtureEvent {
    constructor(type, init = {}) {
      const event = document.createEvent("Event");
      event.initEvent(String(type), Boolean(init.bubbles), true);
      event.data = init.data;
      event.inputType = init.inputType;
      event.key = init.key;
      event.code = init.code;
      return event;
    }
  }

  const globals = {
    window,
    document,
    location,
    history: { pushState: () => undefined, replaceState: () => undefined },
    Node: domino.impl.Node,
    Element: domino.impl.Element,
    HTMLElement: domino.impl.HTMLElement,
    HTMLTextAreaElement: domino.impl.HTMLTextAreaElement,
    HTMLInputElement: domino.impl.HTMLInputElement,
    HTMLButtonElement: domino.impl.HTMLButtonElement,
    HTMLAnchorElement: domino.impl.HTMLAnchorElement,
    HTMLImageElement: domino.impl.HTMLImageElement,
    Event: FixtureEvent,
    InputEvent: FixtureEvent,
    KeyboardEvent: FixtureEvent,
    CSS: { escape: (value) => String(value).replace(/[^\w-]/gu, (character) => `\\${character}`) },
    getComputedStyle: (element) => {
      const style = element?.bachataStyle ?? { display: "block", visibility: "visible", opacity: "1" };
      return { ...style, getPropertyValue: (name) => style[name] ?? "" };
    },
    requestAnimationFrame: (callback) => {
      callback(Date.now());
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval: () => undefined,
    // Which nodes the adapter chose to watch is the observable difference between a dormant
    // completion-evidence path and an active one, so every target is recorded.
    MutationObserver: class {
      observe(target) {
        observedTargets.push(target);
      }
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    chrome: {
      runtime: {
        id: "bachata-fixture",
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => {
          sent.push(structuredClone(message));
          if (message?.type === "BACHATA_QUARANTINE_IS") return { ok: true, value: false };
          if (message?.type === "BACHATA_QUARANTINE_LIST") return { ok: true, value: [] };
          if (
            message?.type === "BACHATA_QUARANTINE_SET"
            || message?.type === "BACHATA_QUARANTINE_CLEAR"
          ) {
            return { ok: true };
          }
          if (message?.type === "content.register") {
            return { success: true, registered: true };
          }
          return { success: true };
        },
      },
    },
  };

  Object.entries(globals).forEach(([name, value]) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    define(globalThis, name, value);
  });

  return {
    window,
    document,
    location,
    sent,
    listeners,
    intervals,
    html,
    query: (selector) => document.querySelector(selector),
    innerHtmlReads: () => innerHtmlReads,
    innerTextReads: () => innerTextReads,
    observedTargets,
    countInnerHtml,
    failInnerText,
    failStopQuery,
    failGetAttribute,
    thread: () => document.querySelector("#thread"),
    composer: () => document.querySelector("#prompt-textarea"),
    sendButton: () => document.querySelector("button[data-testid='send-button']"),
    hide: (element, how = { display: "none" }) => {
      element.bachataStyle = how;
      return element;
    },
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      for (const [target, name, descriptor] of restorers.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    },
  };
};
