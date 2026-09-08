const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

class FakeElement {
  constructor(tag, owner) {
    this.tagName = String(tag).toUpperCase();
    this.owner = owner;
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.ownText = "";
    this.identifier = "";
    this.isHidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "";
    this.title = "";
    this.placeholder = "";
    this.autocomplete = "";
    this.spellcheck = true;
  }

  get hidden() {
    return this.isHidden;
  }

  set hidden(value) {
    this.isHidden = Boolean(value);
    if (this.isHidden && this.contains(this.owner.activeElement)) {
      this.owner.activeElement = this.owner.body;
    }
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  get id() {
    return this.identifier;
  }

  set id(value) {
    this.identifier = String(value);
    this.owner.register(this);
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set className(value) {
    this.classes = new Set(String(value).split(" ").filter(Boolean));
  }

  get classList() {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classes.has(name) : force;
        if (next) this.classes.add(name);
        else this.classes.delete(name);
        return next;
      },
    };
  }

  get textContent() {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this.ownText;
  }

  set textContent(value) {
    for (const child of this.children) {
      child.parent = null;
    }
    this.children = [];
    this.ownText = String(value);
  }

  get visibleText() {
    if (this.isHidden) return "";
    return this.children.length > 0
      ? this.children.map((child) => child.visibleText).join(" ").trim()
      : this.ownText;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  insertBefore(node, reference) {
    node.remove();
    node.parent = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) {
      child.parent = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (this.contains(this.owner.activeElement)) {
      this.owner.activeElement = this.owner.body;
    }
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  focus() {
    this.owner.activeElement = this;
  }

  querySelectorAll(selector) {
    if (!/^[a-z]+$/i.test(selector)) throw new Error(`Unsupported test selector: ${selector}`);
    const tag = selector.toUpperCase();
    return this.children.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }

  fire(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ preventDefault: () => undefined, target: this, ...event });
    }
  }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.body = new FakeElement("body", this);
    this.activeElement = null;
    const root = new FakeElement("div", this);
    root.id = "root";
    const bindingStatus = new FakeElement("div", this);
    bindingStatus.id = "binding-status";
    this.root = root;
    this.bindingStatus = bindingStatus;
  }

  register(element) {
    if (element.id) this.byId.set(element.id, element);
  }

  createElement(tag) {
    return new FakeElement(tag, this);
  }

  getElementById(id) {
    return this.byId.get(id) ?? null;
  }
}

const installGlobals = (sendMessage, readText = async () => "") => {
  const saved = new Map();
  for (const name of ["document", "chrome", "navigator", "setInterval"]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  const documentValue = new FakeDocument();
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: documentValue },
    chrome: {
      configurable: true,
      writable: true,
      value: {
        runtime: {
          sendMessage,
          getURL: (path) => `chrome-extension://bachata-browser-bridge${path}`,
        },
      },
    },
    navigator: { configurable: true, writable: true, value: { clipboard: { readText } } },
    setInterval: { configurable: true, writable: true, value: () => 1 },
  });
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
};

const endpoint = "ws://127.0.0.1:43127/bachata-browser-bridge-v9";

const providerTabs = () => [
  {
    id: 7,
    provider: "chatgpt",
    title: "Ready chat",
    url: "https://chatgpt.com/c/ready",
    status: "ready",
    ready: true,
    reason: "Ready",
    conversationIdentity: "ready",
  },
  {
    id: 8,
    provider: "claude",
    title: "Login required",
    url: "https://claude.ai/new",
    status: "notAuthenticated",
    ready: false,
    reason: "Sign in to Claude",
  },
  {
    id: 12,
    provider: "generic",
    title: "Local model",
    url: "http://localhost:8080/chat",
    status: "streaming",
    ready: false,
    reason: "This conversation is generating a response.",
  },
  {
    id: 13,
    provider: "generic",
    title: "   ",
    url: "",
    status: "unregistered",
    ready: false,
    reason: "Refresh tabs to inspect this provider page.",
  },
];

const readyPair = () => providerTabs().map((tab) =>
  tab.id === 8 ? { ...tab, status: "ready", ready: true, reason: "Ready" } : tab,
);

const state = (overrides = {}) => ({
  revision: 1,
  endpoint,
  connected: false,
  connecting: false,
  tabs: providerTabs(),
  ...overrides,
});

const byId = (id) => document.getElementById(id);
const type = (id, value) => {
  const element = byId(id);
  element.value = value;
  element.fire("input");
};
const click = async (id) => {
  const element = byId(id);
  if (!element.hidden && !element.disabled) {
    element.focus();
  }
  element.fire("click");
  await nextTurn();
};

export {
  nextTurn,
  deferred,
  installGlobals,
  endpoint,
  providerTabs,
  readyPair,
  state,
  byId,
  type,
  click,
};
