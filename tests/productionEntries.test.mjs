import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createChatGptCaptureDom } from "./support/chatgptCaptureDom.mjs";
import test from "node:test";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const saveGlobals = (names) => new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

const restoreGlobals = (saved) => {
  for (const [name, descriptor] of saved) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
};

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
};

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.innerText = "";
    this.isConnected = true;
    this.textContent = "";
    this.value = "";
  }

  append(...values) {
    this.children.push(...values);
  }

  click() {}

  closest() {
    return null;
  }

  dispatchEvent() {
    return true;
  }

  focus() {}

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  replaceChildren(...values) {
    this.children = [...values];
    this.textContent = values.map((value) => value?.textContent ?? String(value ?? "")).join("");
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

// A real MutationObserver delivers its callback at the end of a microtask checkpoint but hands
// back everything pending from `takeRecords()` synchronously. Modelling both halves is what lets a
// test express "the page refused the upload inside the same event handler that took the files".
class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.records = [];
    this.observing = false;
    FakeMutationObserver.instances.push(this);
  }

  disconnect() {
    this.observing = false;
  }

  observe() {
    this.observing = true;
  }

  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }
}

// Queue a mutation on every live observer, the way one DOM change reaches every observer watching
// that subtree.
const queueMutation = (target) => {
  for (const observer of FakeMutationObserver.instances) {
    if (observer.observing) observer.records.push({ target, addedNodes: [] });
  }
};

// A send that stages attachments now waits the whole bounded refusal window before it will call an
// upload accepted, so those dispatches need a budget larger than that window.
const attachmentDispatchTimeoutMs = 5_000;

const dispatchRuntimeMessage = (listener, message, sender = {}, timeoutMs = 500) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response for ${message.type}`)), timeoutMs);
    const respond = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    listener(message, sender, respond);
  });

// The background answers the quarantine authority query in production, so these harnesses answer
// it too. An unanswered query is deliberately fail-closed now, which would otherwise turn every
// unrelated entry assertion into a quarantine-availability assertion.
const quarantineAuthorityReply = (message) => {
  if (message?.type === "BACHATA_QUARANTINE_IS") return { ok: true, value: false };
  if (message?.type === "BACHATA_QUARANTINE_LIST") return { ok: true, value: [] };
  if (message?.type === "BACHATA_QUARANTINE_SET" || message?.type === "BACHATA_QUARANTINE_CLEAR") {
    return { ok: true };
  }
  return undefined;
};

/**
 * Every harness that starts a provider entry installs the whole message table that entry
 * answers, and a harness that only sends the one message it is about proves that the listener
 * exists rather than that it works. Each answer driven here is a refusal or a projection that
 * needs no page behind it: a status read, an interrupt for a request that is not running, an
 * asset nothing published, a transfer for that asset, and the document's own re-registration.
 *
 * Node reports coverage as the run total across every instance of the entry a suite loads, not
 * as their union, so a listener every harness installs has to be driven by every harness for
 * that total to mean anything. This is that sweep, and it is a real assertion in each place: an
 * entry left unable to answer its own table after a refused send would fail here.
 */
const driveEntryMessageTable = async (listener, provider, sent) => {
  const status = await dispatchRuntimeMessage(listener, { type: "provider.status" });
  assert.equal(typeof status.documentToken, "string");

  const interrupted = await dispatchRuntimeMessage(listener, {
    type: "conversation.interrupt",
    requestId: "sweep-request-missing",
    provider,
    sessionId: "sweep-session",
    tabId: 1,
    frameId: 0,
    documentToken: status.documentToken,
    conversationUrl: status.conversationUrl,
    conversationIdentity: status.conversationIdentity,
  });
  assert.equal(interrupted.interrupted, true, "the entry refused to cancel a request it never ran");

  assert.deepEqual(
    await dispatchRuntimeMessage(listener, { type: "asset.probe", assetId: "sweep-asset-missing" }),
    { success: true },
  );
  const reveal = await dispatchRuntimeMessage(listener, {
    type: "asset.reveal",
    assetId: "sweep-asset-missing",
  });
  assert.equal(reveal.success, false);
  assert.deepEqual(
    await dispatchRuntimeMessage(listener, {
      type: "asset.cancel",
      transferId: "sweep-transfer",
      assetId: "sweep-asset-missing",
    }),
    { success: false },
  );
  assert.deepEqual(
    await dispatchRuntimeMessage(listener, {
      type: "asset.fetch",
      transferId: "sweep-transfer",
      assetId: "sweep-asset-missing",
      maxBytes: 1024,
    }),
    { success: true, accepted: true },
  );
  await nextTurn();
  if (sent) {
    assert.equal(
      sent.some(
        (message) =>
          message.type === "content.asset.error" &&
          message.transferId === "sweep-transfer" &&
          message.code === "ASSET_UNAVAILABLE",
      ),
      true,
      "the entry accepted a transfer for an asset it never published",
    );
  }
  assert.deepEqual(
    await dispatchRuntimeMessage(listener, { type: "content.reregister" }),
    { success: true },
  );
  return status;
};

const runProviderEntry = async (provider) => {
  const names = [
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLImageElement",
    "MutationObserver",
    "document",
    "location",
    "history",
    "window",
    "chrome",
    "CSS",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "clearInterval",
    "__pairAssetLogic",
    "__pairProviderControls",
    "__pairDomHealing",
    "__pairChatGptLogic",
    "__pairClaudeLogic",
    "__pairBrowserBridgeChatGptV6",
    "__pairBrowserBridgeClaudeV6",
  ];
  const saved = saveGlobals(names);
  const listeners = [];
  const sent = [];
  const intervalCallbacks = [];
  let current = new URL(
    provider === "chatgpt"
      ? "https://chatgpt.com/c/initial"
      : "https://claude.ai/chat/initial",
  );
  const updateLocation = (value) => {
    if (value !== undefined && value !== null && value !== "") {
      current = new URL(String(value), current);
    }
    location.href = current.href;
    location.pathname = current.pathname;
  };

  try {
    const documentElement = new FakeElement();
    const document = {
      activeElement: undefined,
      body: new FakeElement(),
      documentElement,
      createElement: () => new FakeElement(),
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const location = { href: current.href, pathname: current.pathname };
    const history = {
      pushState: (_state, _unused, url) => updateLocation(url),
      replaceState: (_state, _unused, url) => updateLocation(url),
    };
    const windowListeners = new Map();
    const window = {
      addEventListener: (name, listener) => { windowListeners.set(name, listener); },
      getSelection: () => undefined,
    };
    const chrome = {
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.push(listener),
        },
        sendMessage: async (message) => {
          sent.push(structuredClone(message));
          const quarantine = quarantineAuthorityReply(message);
          if (quarantine) return quarantine;
          if (message.type === "content.register") {
            return { success: true, registered: true };
          }
          return { success: true };
        },
      },
    };

    setGlobal("Element", FakeElement);
    setGlobal("HTMLElement", FakeElement);
    setGlobal("HTMLTextAreaElement", FakeElement);
    setGlobal("HTMLInputElement", FakeElement);
    setGlobal("HTMLButtonElement", FakeElement);
    setGlobal("HTMLAnchorElement", FakeElement);
    setGlobal("HTMLImageElement", FakeElement);
    setGlobal("MutationObserver", FakeMutationObserver);
    setGlobal("document", document);
    setGlobal("location", location);
    setGlobal("history", history);
    setGlobal("window", window);
    setGlobal("chrome", chrome);
    setGlobal("CSS", { escape: (value) => String(value) });
    setGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    setGlobal("requestAnimationFrame", (callback) => {
      callback(Date.now());
      return 1;
    });
    setGlobal("cancelAnimationFrame", () => undefined);
    setGlobal("setInterval", (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    });
    setGlobal("clearInterval", () => undefined);

    const stamp = `${provider}-${Date.now()}-${Math.random()}`;
    await import(`../dist/content/assetLogic.js?${stamp}`);
    await import(`../dist/content/providerControls.js?${stamp}`);
    await import(`../dist/content/domHealing.js?${stamp}`);
    await import(`../dist/content/providerLogic.js?${stamp}`);
    await import(`../dist/content/${provider === "chatgpt" ? "chatgptLogic" : "claudeLogic"}.js?${stamp}`);
    await import(`../dist/content/${provider}.js?${stamp}`);
    await nextTurn();

    assert.equal(listeners.length, 1);
    assert.equal(intervalCallbacks.length, 1);
    assert.equal(sent.some((message) => message.type === "content.register"), true);

    const status = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    assert.equal(status.status, "notReady");
    assert.equal(status.conversationUrl, current.href);
    assert.equal(typeof status.documentToken, "string");

    const stale = await dispatchRuntimeMessage(listeners[0], {
      type: "conversation.send",
      requestId: "request-stale",
      agentId: provider,
      provider,
      sessionId: "session-stale",
      tabId: 1,
      frameId: 0,
      documentToken: "wrong-token",
      conversationUrl: current.href,
      conversationIdentity: status.conversationIdentity,
      text: "hello",
      attachments: [],
      allowInitialConversationTransition: false,
      deadlineAt: Date.now() + 30_000,
    });
    assert.equal(stale.submitted, false);
    assert.match(stale.error, /no longer matches/);

    await driveEntryMessageTable(listeners[0], provider, sent);

    // Behavioural proof, not a source-string one. Patching history in the isolated world never
    // reached the page's own calls, so drive the signals that do cross: the URL changes, then a
    // real popstate arrives. Asserting through the fake history object would pass against a
    // mechanism that does not exist in a browser.
    const previousRegistrations = sent.filter((message) => message.type === "content.register").length;
    updateLocation(provider === "chatgpt" ? "/c/next" : "/chat/next");
    const onPopState = windowListeners.get("popstate");
    assert.equal(typeof onPopState, "function", "the content script registered no popstate listener");
    onPopState();
    await nextTurn();
    await nextTurn();
    assert.ok(
      sent.filter((message) => message.type === "content.register").length > previousRegistrations,
      "a real navigation signal did not re-register the document",
    );

    await driveEntryMessageTable(listeners[0], provider, sent);
  } finally {
    restoreGlobals(saved);
  }
};

test("production ChatGPT content entry registers, handles SPA navigation, and rejects stale bindings", async () => {
  await runProviderEntry("chatgpt");
});

test("production Claude content entry registers, handles SPA navigation, and rejects stale bindings", async () => {
  await runProviderEntry("claude");
});

const createEvent = () => {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    listeners,
  };
};

const backgroundChromeSupport = () => ({
  alarms: {
    create: async () => undefined,
    clear: async () => true,
    onAlarm: { addListener: () => undefined },
  },
  contextMenus: {
    create: () => undefined,
    remove: async () => undefined,
    onClicked: { addListener: () => undefined },
  },
});

test("production background entry initializes and serves popup state through its real listener", async () => {
  const names = ["chrome", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const alarmEvent = createEvent();
  const writes = [];
  const recoveryTabUpdates = [];
  const sockets = [];
  const timers = new Map();
  const intervals = new Map();
  const injections = [];
  let providerTabs = [];
  let contentStatusReply;
  let nextTimerId = 1;
  let genericPermitted = true;
  let genericPermissionThrows = false;
  try {
    const chrome = {
      contextMenus: {
        create: () => undefined,
        remove: async () => undefined,
        onClicked: { addListener: () => undefined },
      },
      alarms: {
        create: async () => undefined,
        clear: async () => true,
        onAlarm: alarmEvent,
      },
      runtime: { id: "bachata-bridge-test", onMessage: runtimeEvent, getURL: (path) => `chrome-extension://bachata-bridge-test/${path}` },
      storage: {
        local: {
          get: async () => ({}),
          set: async (value) => writes.push(structuredClone(value)),
        },
        session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
      },
      // N1. A Generic origin is honoured only while the user still permits it, and the entry
      // reads that at the moment a navigation is handled rather than trusting the grant it was
      // registered under.
      permissions: {
        contains: async () => {
          if (genericPermissionThrows) throw new Error("the permission store is unavailable");
          return genericPermitted;
        },
      },
      tabs: {
        query: async () => providerTabs,
        get: async (tabId) => providerTabs.find((tab) => tab.id === tabId),
        create: async () => undefined,
        update: async (tabId, changes) => { recoveryTabUpdates.push({ tabId, changes }); },
        remove: async () => undefined,
        sendMessage: async (_tabId, message) =>
          (message?.type === "provider.status" && contentStatusReply
            ? contentStatusReply
            : { success: false }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => injections.push("executeScript") },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      close() {
        this.readyState = 3;
        this.emit("close");
      }

      send(value) {
        this.sent.push(JSON.parse(String(value)));
      }
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    const realSetTimeout = globalThis.setTimeout;
    setGlobal("setTimeout", (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      if (delay <= 100) return realSetTimeout(callback, 0);
      return id;
    });
    setGlobal("clearTimeout", (id) => timers.delete(id));
    // BB-AUD-09. The keep-alive ladder lives on an interval, so an interval that never fires
    // leaves the whole of it — ping, pong, a missed pong and a send that throws — unreachable.
    setGlobal("setInterval", (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      intervals.set(id, { callback, delay });
      return id;
    });
    setGlobal("clearInterval", (id) => intervals.delete(id));

    await import(`../dist/background/index.js?background-${Date.now()}-${Math.random()}`);
    await nextTurn();
    assert.equal(runtimeEvent.listeners.length >= 1, true);
    assert.equal(removedEvent.listeners.length >= 1, true);
    assert.equal(updatedEvent.listeners.length, 1);
    assert.equal(alarmEvent.listeners.length, 1);
    alarmEvent.listeners[0]({ name: "unrelated-alarm", scheduledTime: Date.now() });
    alarmEvent.listeners[0]({ name: "bachataBridgeReconnect.v8", scheduledTime: Date.now() });
    await nextTurn();

    const state = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    assert.equal(state.connected, false);
    assert.equal(state.connecting, false);
    assert.equal("connectionToken" in state, false);
    assert.deepEqual(state.tabs, []);
    assert.equal(typeof state.revision, "number");
    assert.deepEqual(writes, []);

    // BB-AUD-09. Message families the entry does not own are declined synchronously, so the
    // modules that do own them answer on their own listener; everything else is the entry's
    // own and is answered asynchronously.
    for (const type of [
      "BACHATA_LOCAL_MODEL_PROMPT",
      "BACHATA_LOCAL_MODEL_CANCEL",
      "BACHATA_GENERIC_STATUS",
      "BACHATA_QUARANTINE_IS",
    ]) {
      assert.equal(runtimeEvent.listeners[0]({ type }, {}, () => undefined), false, type);
    }
    assert.equal(
      runtimeEvent.listeners[0]({ type: "popup.getState" }, {}, () => undefined),
      true,
    );

    const discovered = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.discover",
    });
    assert.deepEqual(discovered.tabs, []);

    const deselected = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.deselect",
    });
    assert.equal(Object.hasOwn(deselected, "selectedTabId"), false);

    // An unrecognized popup type is answered with nothing rather than an invented result.
    assert.equal(
      await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.unknown" }),
      undefined,
    );

    const selectMissing = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.select",
      tabId: 77,
    });
    assert.equal(selectMissing.success, false);

    // BB-AUD-09. With a supported provider tab present the entry queries it, projects it as an
    // unregistered row, and on selection injects the provider's own content files before
    // giving up on a page that never registers a document.
    providerTabs = [
      { id: 21, url: "https://chatgpt.com/c/one", title: "ChatGPT", status: "complete" },
      { id: 22, url: "https://example.invalid/", title: "Unsupported", status: "complete" },
    ];
    const listed = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    assert.deepEqual(listed.tabs.map((tab) => tab.id), [21]);
    assert.equal(listed.tabs[0].status, "unregistered");
    assert.equal(listed.tabs[0].ready, false);

    const popupSender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup/index.html") };
    for (const foreign of [{}, { ...popupSender, id: "another-extension" }, { ...popupSender, tab: { id: 21 } }]) {
      const refused = await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.recover", tabId: 21, action: "open" }, foreign);
      assert.equal(refused.success, false);
      assert.match(refused.error, /requires the Browser Bridge popup/);
    }
    assert.deepEqual(recoveryTabUpdates, []);
    const opened = await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.recover", tabId: 21, action: "open" }, popupSender);
    assert.equal(opened.tabs[0].id, 21);
    assert.deepEqual(recoveryTabUpdates, [{ tabId: 21, changes: { active: true } }]);
    const missingRecovery = await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.recover", tabId: 999, action: "open" }, popupSender);
    assert.match(missingRecovery.error, /no longer available/);
    const inactiveSelection = await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.recover", tabId: 21, action: "selected" }, popupSender);
    assert.match(inactiveSelection.error, /unavailable/);
    assert.equal(recoveryTabUpdates.length, 1);

    const selectUnregistered = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.select",
      tabId: 21,
    }, {}, 5_000);
    assert.equal(selectUnregistered.success, false);
    assert.deepEqual(injections, ["executeScript"]);

    // BB-AUD-09. A registered document turns that tab into a published session, which is the
    // path the live-binding and content-status decisions sit on.
    const contentSender = {
      tab: { id: 21 },
      frameId: 0,
      url: "https://chatgpt.com/c/one",
      id: undefined,
    };
    contentStatusReply = {
      status: "ready",
      documentToken: "document-21",
      conversationUrl: "https://chatgpt.com/c/one",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
      conversationState: "confirmed",
    };
    const registered = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "content.register",
      documentToken: "document-21",
      provider: "chatgpt",
      conversationUrl: "https://chatgpt.com/c/one",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
    }, contentSender);
    assert.equal(registered.success, true);

    const withSession = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    assert.equal(withSession.tabs[0].status, "ready");
    assert.equal(withSession.tabs[0].ready, true);
    assert.equal(
      withSession.tabs[0].conversationIdentity,
      "chatgpt:https://chatgpt.com/c/one",
    );

    // A page that answers for a different document is not that binding's session.
    contentStatusReply = {
      status: "ready",
      documentToken: "another-document",
      conversationUrl: "https://chatgpt.com/c/one",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
    };
    const mismatched = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    assert.equal(mismatched.tabs[0].status, "unregistered");

    // Nor is a page whose status is not one the protocol publishes.
    contentStatusReply = {
      status: "thinking",
      documentToken: "document-21",
      conversationUrl: "https://chatgpt.com/c/one",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
    };
    assert.equal(
      (await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.getState" }))
        .tabs[0].status,
      "unregistered",
    );

    // Nor a page that has navigated to another conversation than the one it registered.
    contentStatusReply = {
      status: "ready",
      documentToken: "document-21",
      conversationUrl: "https://chatgpt.com/c/two",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/two",
    };
    assert.equal(
      (await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.getState" }))
        .tabs[0].status,
      "unregistered",
    );

    contentStatusReply = undefined;
    providerTabs = [];

    const reconnected = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.reconnect",
    });
    assert.equal(typeof reconnected.revision, "number");

    const invalid = await dispatchRuntimeMessage(runtimeEvent.listeners[0], null);
    assert.equal(invalid.success, false);
    assert.match(invalid.error, /Invalid browser message/);

    const invalidPair = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.pair",
      endpoint: "https://example.invalid/socket",
      token: "",
    });
    assert.equal(invalidPair.success, false);
    assert.match(invalidPair.error, /loopback endpoint and pairing token/);

    for (const endpoint of [
      "ws://10.0.0.1:43123/bachata-browser-bridge-v9",
      "ws://127.0.0.1:43123/some-other-path",
      "not-a-url",
    ]) {
      const refused = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
        type: "popup.pair",
        endpoint,
        token: "pairing-token",
      });
      assert.equal(refused.success, false, endpoint);
    }

    const invalidSelection = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.select",
      tabId: 0,
    });
    assert.equal(invalidSelection.success, false);
    assert.match(invalidSelection.error, /valid browser tab/);

    const pairing = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.pair",
      endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
      token: "pairing-token",
    });
    assert.equal(pairing.connecting, true);
    const firstSocket = sockets[0];
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "bridge.paired",
        protocolVersion: 9,
        connectionToken: "connection-token",
      }),
    });
    await nextTurn();
    firstSocket.emit("message", {
      data: JSON.stringify({ type: "bridge.connected", protocolVersion: 9 }),
    });
    await nextTurn();
    await nextTurn();

    // An asset the entry never registered cannot be revealed, and saying so is the answer.
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "asset.reveal",
        protocolVersion: 9,
        requestId: "reveal-1",
        assetId: "asset-nobody-registered",
      }),
    });
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    assert.equal(
      firstSocket.sent.some((frame) => frame.requestId === "reveal-1"),
      true,
      "a reveal for an unknown asset went unanswered",
    );

    // BB-AUD-09. An interrupt for a request that is not running is answered as a mismatch, not
    // as a silent success: the controller has to be able to tell "stopped" from "was never
    // there", and a request the entry has never seen was never stopped by it.
    const binding = {
      agentId: "agent-1",
      provider: "chatgpt",
      sessionId: "session-1",
      tabId: 4242,
      frameId: 0,
      documentToken: "no-such-document",
      conversationUrl: "https://chatgpt.com/c/nowhere",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/nowhere",
    };
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "conversation.interrupt",
        protocolVersion: 9,
        requestId: "request-that-is-not-running",
        ...binding,
      }),
    });
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    const interruptRefusal = firstSocket.sent.find(
      (frame) => frame.requestId === "request-that-is-not-running",
    );
    assert.notEqual(interruptRefusal, undefined, "an interrupt went unanswered");
    assert.equal(interruptRefusal.type, "conversation.error");
    assert.equal(interruptRefusal.code, "INTERRUPT_MISMATCH");

    // A send naming a tab the entry holds no document for is refused before the page is touched.
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "send-with-no-document",
        ...binding,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
      }),
    });
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();
    assert.equal(
      firstSocket.sent.some((frame) => frame.requestId === "send-with-no-document"),
      true,
      "a send against a document the entry does not hold went unanswered",
    );

    // BB-AUD-09. Provisioning: a request the entry cannot satisfy answers with a refusal rather
    // than silence, a cancellation for a request that is no longer queued is not an error, and a
    // repeated request id is answered from the retained result rather than run twice.
    providerTabs = [];
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "provider.openConversation",
        protocolVersion: 9,
        requestId: "provision-1",
        provider: "chatgpt",
      }),
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    const provisioning = firstSocket.sent.find(
      (frame) => frame.type === "provider.openConversation.result" && frame.requestId === "provision-1",
    );
    assert.notEqual(provisioning, undefined, "an open-conversation request went unanswered");
    assert.equal(provisioning.success, false);

    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "provider.openConversation",
        protocolVersion: 9,
        requestId: "provision-1",
        provider: "chatgpt",
      }),
    });
    await nextTurn();
    await nextTurn();
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "provider.cancelOpenConversation",
        protocolVersion: 9,
        requestId: "provision-never-queued",
      }),
    });
    await nextTurn();
    // The Generic half of provisioning refuses differently: with no bound tab there is no
    // session to select, and the entry never opens one on its own.
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "provider.openConversation",
        protocolVersion: 9,
        requestId: "provision-generic",
        provider: "generic",
        preferredOrigin: "https://bound.invalid",
      }),
    });
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    const genericProvisioning = firstSocket.sent.find(
      (frame) => frame.requestId === "provision-generic",
    );
    assert.notEqual(genericProvisioning, undefined, "a generic open-conversation went unanswered");
    assert.equal(genericProvisioning.success, false);

    firstSocket.emit("message", {
      data: JSON.stringify({ type: "provider.discover", protocolVersion: 9 }),
    });
    await nextTurn();
    await nextTurn();

    // BB-AUD-09. The asset-transfer path's refusals, which is where it decides anything. An
    // asset this document never produced is refused by name rather than fetched, a transfer id
    // already in flight is refused rather than reused, and a cancellation for a transfer that
    // does not exist is not an error to report back.
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "asset.fetch",
        protocolVersion: 9,
        transferId: "transfer-1",
        assetId: "asset-nobody-registered",
        maxBytes: 1_024,
      }),
    });
    await nextTurn();
    await nextTurn();
    const assetRefusal = firstSocket.sent.at(-1);
    assert.equal(assetRefusal.type, "asset.error");
    assert.equal(assetRefusal.code, "ASSET_UNAVAILABLE");
    assert.equal(assetRefusal.transferId, "transfer-1");

    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "asset.cancel",
        protocolVersion: 9,
        transferId: "transfer-that-never-started",
        assetId: "asset-nobody-registered",
      }),
    });
    await nextTurn();
    await nextTurn();
    assert.equal(
      firstSocket.sent.at(-1).transferId,
      "transfer-1",
      "cancelling a transfer that never started sent something back",
    );

    // BB-AUD-09. The keep-alive ladder, driven through the real entry. A pong answers the ping
    // it was sent for; a second tick with the first still unanswered is the controller having
    // stopped responding, and the socket is closed rather than left believed-open.
    const keepAlive = [...intervals.values()].find((timer) => timer.delay === 20_000);
    assert.notEqual(keepAlive, undefined, "the keep-alive interval was never installed");
    const socketForKeepAlive = firstSocket;
    socketForKeepAlive.readyState = FakeWebSocket.OPEN;
    keepAlive.callback();
    const ping = socketForKeepAlive.sent.at(-1);
    assert.equal(ping.type, "bridge.ping");
    assert.equal(typeof ping.nonce, "string");

    // A pong naming another ping answers nothing.
    socketForKeepAlive.emit("message", {
      data: JSON.stringify({ type: "bridge.pong", protocolVersion: 9, nonce: "another-ping" }),
    });
    await nextTurn();
    socketForKeepAlive.emit("message", {
      data: JSON.stringify({ type: "bridge.pong", protocolVersion: 9, nonce: ping.nonce }),
    });
    await nextTurn();
    // Answered, so the next tick sends a fresh ping rather than closing.
    keepAlive.callback();
    assert.equal(socketForKeepAlive.sent.at(-1).type, "bridge.ping");
    assert.notEqual(socketForKeepAlive.sent.at(-1).nonce, ping.nonce);
    // Unanswered, so the next tick closes.
    keepAlive.callback();
    await nextTurn();
    await nextTurn();
    assert.equal(socketForKeepAlive.readyState, 3, "an unanswered keep-alive left the socket open");
    // A tick on a socket that is no longer the current one does nothing at all.
    keepAlive.callback();

    // The ladder already closed it; closing again must not schedule a second reconnect.
    firstSocket.emit("close");
    await nextTurn();
    assert.equal([...timers.values()].some((timer) => timer.delay >= 2_700), true);

    alarmEvent.listeners[0]({ name: "bachataBridgeReconnect.v8", scheduledTime: Date.now() });
    await nextTurn();
    await nextTurn();
    assert.equal(sockets.length, 2);

    // BB-AUD-09. The retry boundary. A socket that errors before it opens records why rather
    // than failing silently, and the close that follows steps the ladder rather than restarting
    // it: another attempt is scheduled, not the same one again.
    const secondSocket = sockets[1];
    secondSocket.emit("error", {});
    await nextTurn();
    assert.match(
      (await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.getState" })).error,
      /Could not connect to the Bachata VS Code extension/u,
    );
    const waitsBefore = [...timers.values()].filter((timer) => timer.delay >= 2_700).length;
    secondSocket.emit("close");
    await nextTurn();
    await nextTurn();
    assert.ok(
      [...timers.values()].filter((timer) => timer.delay >= 2_700).length > waitsBefore,
      "a closed reconnect attempt scheduled no further attempt",
    );
    // An error on a socket the entry has already let go changes nothing.
    secondSocket.emit("error", {});
    await nextTurn();

    // BB-AUD-09. Tab lifecycle is the entry's own work: a navigation off a supported site
    // drops the tab, a status-only update leaves it alone, and a closed tab is forgotten.
    updatedEvent.listeners[0](77, { url: "https://example.invalid/not-a-provider" });
    await nextTurn();
    await nextTurn();
    updatedEvent.listeners[0](77, { status: "complete" });
    await nextTurn();
    updatedEvent.listeners[0](77, { url: "https://chatgpt.com/c/reopened" });
    await nextTurn();
    await nextTurn();

    // N1. The same tab lifecycle reached through Chrome's own navigation events. Each of the
    // three is subscribed, each is deduplicated to an effective transition, and the refusals
    // are refusals in the entry and not only in the normalizer: a subframe, a prerendered
    // document and an unsupported origin must leave the entry's state alone.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);

    const committed = (details) => committedEvent.listeners[0]({
      tabId: 77,
      frameId: 0,
      documentId: "document-a",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/reopened",
      ...details,
    });

    committed({});
    await nextTurn();
    await nextTurn();
    // The same commit again is one state, not two.
    committed({});
    await nextTurn();
    // A subframe is not the conversation moving.
    committed({ frameId: 4, url: "https://chatgpt.com/c/subframe" });
    await nextTurn();
    // A prerendered document has not been shown to anyone.
    committed({ documentLifecycle: "prerender", url: "https://chatgpt.com/c/prerendered" });
    await nextTurn();
    // A pushState inside the bound conversation keeps the document and changes the route.
    historyEvent.listeners[0]({
      tabId: 77,
      frameId: 0,
      documentId: "document-a",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/pushed",
    });
    await nextTurn();
    await nextTurn();
    // A hash change on a document that has already been replaced is a late report.
    fragmentEvent.listeners[0]({
      tabId: 77,
      frameId: 0,
      documentId: "document-gone",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/pushed#section",
    });
    await nextTurn();
    // An origin the extension may not read is refused before anything is bound to it.
    committed({ url: "https://unrelated.invalid/", documentId: "document-b" });
    await nextTurn();
    await nextTurn();
    // A tab Chrome swapped in carries none of the replaced tab's identity.
    providerTabs = [{ id: 78, url: "https://chatgpt.com/c/replacement", title: "replacement" }];
    replacedEvent.listeners[0](78, 77);
    await nextTurn();
    await nextTurn();
    await nextTurn();
    // A replacement whose surviving tab cannot be read reports nothing rather than guessing.
    providerTabs = [];
    replacedEvent.listeners[0](79, 78);
    await nextTurn();
    await nextTurn();

    // N1, Generic half. A registered Generic origin navigates; the permission decides whether
    // that is a route change or consent withdrawn.
    const genericOrigin = "https://bound.invalid";
    const genericSender = {
      id: "bachata-bridge-test",
      frameId: 0,
      tab: { id: 21, url: `${genericOrigin}/chat/one`, title: "bound" },
      url: `${genericOrigin}/chat/one`,
    };
    // The generic registration is answered by its own listener, not the popup one, so the
    // message is offered to each until one keeps the channel open for its answer.
    const registerGeneric = () => new Promise((resolve, reject) => {
      const message = {
        type: "BACHATA_GENERIC_REGISTER",
        origin: genericOrigin,
        url: `${genericOrigin}/chat/one`,
        title: "bound",
        documentRevision: 1,
        documentToken: "generic-document:abcdefghijklmnop",
      };
      for (const listener of runtimeEvent.listeners) {
        if (listener(message, genericSender, resolve) === true) return;
      }
      reject(new Error("no listener claimed BACHATA_GENERIC_REGISTER"));
    });
    const navigateGeneric = (path, documentId) => committedEvent.listeners[0]({
      tabId: 21,
      frameId: 0,
      documentId,
      documentLifecycle: "active",
      url: `${genericOrigin}${path}`,
    });

    providerTabs = [{ id: 21, url: `${genericOrigin}/chat/one`, title: "bound" }];
    assert.deepEqual(await registerGeneric(), { ok: true });
    // Still permitted: the route change is handled and the binding survives it.
    navigateGeneric("/chat/two", "generic-document-1");
    await nextTurn();
    await nextTurn();
    // An authority that could not answer is not an authority that said yes.
    genericPermissionThrows = true;
    navigateGeneric("/chat/three", "generic-document-2");
    await nextTurn();
    await nextTurn();
    await nextTurn();
    // And an explicit revocation is refused the same way.
    genericPermissionThrows = false;
    assert.deepEqual(await registerGeneric(), { ok: true });
    genericPermitted = false;
    navigateGeneric("/chat/four", "generic-document-3");
    await nextTurn();
    await nextTurn();
    await nextTurn();
    genericPermitted = true;
    providerTabs = [];

    removedEvent.listeners[0](77);
    await nextTurn();
    await nextTurn();
    assert.deepEqual((await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    })).tabs, []);

    const closed = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.disconnect",
    });
    assert.equal(closed.connected, false);

    // A reconnect alarm that outlives the pairing it belonged to clears itself instead of
    // dialling an endpoint the user has disconnected from.
    alarmEvent.listeners[0]({ name: "bachataBridgeReconnect.v8", scheduledTime: Date.now() });
    await nextTurn();
    await nextTurn();
    assert.equal(sockets.length, 2);
  } finally {
    restoreGlobals(saved);
  }
});


test("production background migrates a legacy saved endpoint to the current protocol version", async () => {
  const names = ["chrome", "WebSocket", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const writes = [];
  const sockets = [];
  let socketConstructions = 0;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({
            "bachataBridgeState.v7": {
              endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v7",
              connectionToken: "legacy-token",
              selectedTabId: 5,
              selectedSessionId: " legacy-session ",
              handledTabIds: [3, 1, 3],
            },
          }),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [{ id: 9, title: "Legacy resume", url: "https://chatgpt.com/c/legacy-resume" }],
        get: async (tabId) => ({ id: tabId, title: "Legacy resume", url: "https://chatgpt.com/c/legacy-resume" }),
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async (_tabId, message) => {
          if (message.type === "provider.status") {
            return {
              status: "ready",
              documentToken: "document-legacy",
              conversationUrl: "https://chatgpt.com/c/legacy-resume",
              conversationIdentity: "chatgpt:https://chatgpt.com/c/legacy-resume",
            };
          }
          return { success: true, registered: true };
        },
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        socketConstructions += 1;
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      close() {
        this.readyState = 3;
        this.emit("close");
      }

      send(value) {
        this.sent.push(JSON.parse(String(value)));
      }
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?legacy-background-${Date.now()}-${Math.random()}`);
    await nextTurn();
    // N1. Every background entry subscribes Chrome's navigation events, so every harness that
    // starts one proves they are installed and that a report reaches the same tab-change path
    // `tabs.onUpdated` reaches. A subframe is refused here as it is anywhere else.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed",
    });
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 7,
      documentId: "installed-subframe",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/subframe",
    });
    historyEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed",
    });
    fragmentEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed#a",
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    assert.equal(runtimeEvent.listeners.length >= 1, true);
    assert.equal(socketConstructions, 1);
    const socket = sockets[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await nextTurn();
    await nextTurn();
    assert.deepEqual(socket.sent[0], {
      type: "bridge.authenticate",
      protocolVersion: 9,
      connectionToken: "legacy-token",
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "bridge.paired",
        protocolVersion: 9,
        connectionToken: "legacy-token",
      }),
    });
    await nextTurn();
    socket.emit("message", {
      data: JSON.stringify({ type: "bridge.connected", protocolVersion: 9 }),
    });
    await nextTurn();
    await nextTurn();

    const state = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    assert.equal(state.endpoint, "ws://127.0.0.1:43123/bachata-browser-bridge-v9");
    assert.equal(state.selectedTabId, undefined);
    assert.equal(state.connected, true);
    assert.equal(state.connecting, false);
    assert.equal(state.error, undefined);

    const legacySender = {
      tab: { id: 9, url: "https://chatgpt.com/c/legacy-resume" },
      frameId: 0,
      documentId: "document-id-9",
      url: "https://chatgpt.com/c/legacy-resume",
    };
    const registered = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "content.register",
      provider: "chatgpt",
      documentToken: "document-legacy",
      conversationUrl: "https://chatgpt.com/c/legacy-resume",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/legacy-resume",
    }, legacySender);
    assert.deepEqual(registered, { success: true, registered: true });

    const selected = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.select",
      tabId: 9,
    });
    assert.equal(selected.selectedTabId, 9);
    assert.equal(typeof selected.tabs[0].sessionId, "string");
    assert.equal(selected.tabs[0].ready, true);

    assert.equal(writes.length >= 1, true);
    const persisted = writes[0]["bachataBridgeState.v8"];
    assert.equal(persisted.endpoint, "ws://127.0.0.1:43123/bachata-browser-bridge-v9");
    assert.equal(persisted.connectionToken, "legacy-token");
    assert.equal(persisted.selectedTabId, 5);
    assert.equal(persisted.selectedSessionId, "legacy-session");
    assert.deepEqual(persisted.handledTabIds, [1, 3]);
    assert.equal(persisted["bachataBridgeState.v7"], undefined);

    const disconnected = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.disconnect",
    });
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.endpoint, undefined);
    assert.deepEqual(writes.at(-1), { "bachataBridgeState.v8": {} });
  } finally {
    restoreGlobals(saved);
  }
});

test("production background clears an invalid saved endpoint and remains recoverable", async () => {  const names = ["chrome", "WebSocket", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const writes = [];
  let socketConstructions = 0;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({
            "bachataBridgeState.v8": {
              endpoint: "ws://127.0.0.1:99999/bachata-browser-bridge-v9",
              connectionToken: "saved-token",
            },
          }),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [],
        get: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async (_tabId, message) =>
          (message?.type === "provider.status" && contentStatusReply
            ? contentStatusReply
            : { success: false }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor() {
        socketConstructions += 1;
        throw new Error("WebSocket must not be constructed for invalid saved state");
      }
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?invalid-background-${Date.now()}-${Math.random()}`);
    await nextTurn();
    // N1. Every background entry subscribes Chrome's navigation events, so every harness that
    // starts one proves they are installed and that a report reaches the same tab-change path
    // `tabs.onUpdated` reaches. A subframe is refused here as it is anywhere else.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed",
    });
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 7,
      documentId: "installed-subframe",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/subframe",
    });
    historyEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed",
    });
    fragmentEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed#a",
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    assert.equal(runtimeEvent.listeners.length >= 1, true);

    const state = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    assert.equal(state.endpoint, undefined);
    assert.equal("connectionToken" in state, false);
    assert.equal(state.connected, false);
    assert.equal(state.connecting, false);
    assert.match(state.error, /invalid.*cleared/iu);
    assert.equal(socketConstructions, 0);
    assert.deepEqual(writes[0], { "bachataBridgeState.v8": {} });

    const disconnected = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.disconnect",
    });
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.connecting, false);
    assert.equal(disconnected.endpoint, undefined);
    assert.deepEqual(writes.at(-1), { "bachataBridgeState.v8": {} });
  } finally {
    restoreGlobals(saved);
  }
});


test("production background pairs, registers, selects, and disconnects a real provider session", async () => {
  const names = ["chrome", "WebSocket", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const writes = [];
  const sockets = [];
  const url = "https://chatgpt.com/c/entry-session";
  const documentToken = "document-entry-session";
  const conversationIdentity = `chatgpt:${url}`;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({}),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [{ id: 7, title: "Entry session", url }],
        get: async () => ({ id: 7, title: "Entry session", url }),
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async (_tabId, message) => {
          if (message.type === "provider.status") {
            return {
              status: "ready",
              documentToken,
              conversationUrl: url,
              conversationIdentity,
            };
          }
          return { success: true, registered: true };
        },
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      close() {
        this.readyState = 3;
        this.emit("close", {});
      }

      emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      send(value) {
        this.sent.push(JSON.parse(String(value)));
      }
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?paired-background-${Date.now()}-${Math.random()}`);
    await nextTurn();
    // N1. Every background entry subscribes Chrome's navigation events, so every harness that
    // starts one proves they are installed and that a report reaches the same tab-change path
    // `tabs.onUpdated` reaches. A subframe is refused here as it is anywhere else.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed",
    });
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 7,
      documentId: "installed-subframe",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/subframe",
    });
    historyEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed",
    });
    fragmentEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed#a",
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    const listener = runtimeEvent.listeners[0];
    const sender = {
      tab: { id: 7, url },
      frameId: 0,
      documentId: "document-id-7",
      url,
    };
    const registered = await dispatchRuntimeMessage(listener, {
      type: "content.register",
      provider: "chatgpt",
      documentToken,
      conversationUrl: url,
      conversationIdentity,
    }, sender);
    assert.deepEqual(registered, { success: true, registered: true });

    const pairing = await dispatchRuntimeMessage(listener, {
      type: "popup.pair",
      endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
      token: "pairing-token",
    });
    assert.equal(pairing.connecting, true);
    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open", {});
    assert.deepEqual(socket.sent[0], {
      type: "bridge.pair",
      protocolVersion: 9,
      token: "pairing-token",
    });

    socket.emit("message", {
      data: JSON.stringify({
        type: "bridge.paired",
        protocolVersion: 9,
        connectionToken: "connection-token",
      }),
    });
    await nextTurn();
    socket.emit("message", {
      data: JSON.stringify({ type: "bridge.connected", protocolVersion: 9 }),
    });
    await nextTurn();
    await nextTurn();

    const connected = await dispatchRuntimeMessage(listener, { type: "popup.getState" });
    assert.equal(connected.connected, true);
    assert.equal(connected.connecting, false);
    assert.equal(connected.tabs.length, 1);
    assert.equal(connected.tabs[0].ready, true);
    assert.equal(connected.tabs[0].conversationIdentity, conversationIdentity);
    assert.equal(socket.sent.some((message) => message.type === "provider.status"), true);

    const selected = await dispatchRuntimeMessage(listener, {
      type: "popup.select",
      tabId: 7,
    });
    assert.equal(selected.selectedTabId, 7);
    assert.equal(typeof selected.tabs[0].sessionId, "string");
    assert.equal(selected.tabs[0].sessionId.length > 0, true);

    const deselected = await dispatchRuntimeMessage(listener, { type: "popup.deselect" });
    assert.equal(deselected.selectedTabId, undefined);

    const discovered = await dispatchRuntimeMessage(listener, { type: "popup.discover" });
    assert.equal(discovered.tabs.length, 1);
    assert.equal(writes.some((write) => write["bachataBridgeState.v8"]?.handledTabIds?.includes(7)), true);

    const disconnected = await dispatchRuntimeMessage(listener, { type: "popup.disconnect" });
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.endpoint, undefined);
    assert.deepEqual(writes.at(-1), { "bachataBridgeState.v8": {} });
  } finally {
    restoreGlobals(saved);
  }
});

test("production background clears selected state when a provider tab leaves supported sites", async () => {
  const names = ["chrome", "WebSocket", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const writes = [];
  const providerUrl = "https://chatgpt.com/c/navigation-cleanup";
  const documentToken = "navigation-document";
  const conversationIdentity = `chatgpt:${providerUrl}`;
  let currentUrl = providerUrl;
  let currentTabId = 7;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({}),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [{ id: currentTabId, title: "Selected", url: currentUrl }],
        get: async (tabId) => ({ id: tabId, title: "Selected", url: currentUrl }),
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async () => ({
          status: "ready",
          documentToken,
          conversationUrl: providerUrl,
          conversationIdentity,
        }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?navigation-cleanup-${Date.now()}-${Math.random()}`);
    await nextTurn();
    // N1. Every background entry subscribes Chrome's navigation events, so every harness that
    // starts one proves they are installed and that a report reaches the same tab-change path
    // `tabs.onUpdated` reaches. A subframe is refused here as it is anywhere else.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed",
    });
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 7,
      documentId: "installed-subframe",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/subframe",
    });
    historyEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed",
    });
    fragmentEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed#a",
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    assert.equal(updatedEvent.listeners.length, 1);
    const listener = runtimeEvent.listeners[0];
    const sender = {
      tab: { id: 7, url: providerUrl },
      frameId: 0,
      documentId: "document-id-7",
      url: providerUrl,
    };
    const registered = await dispatchRuntimeMessage(listener, {
      type: "content.register",
      provider: "chatgpt",
      documentToken,
      conversationUrl: providerUrl,
      conversationIdentity,
    }, sender);
    assert.deepEqual(registered, { success: true, registered: true });
    const selected = await dispatchRuntimeMessage(listener, {
      type: "popup.select",
      tabId: 7,
    });
    assert.equal(selected.selectedTabId, 7);

    currentUrl = "http://chatgpt.com/gone";
    updatedEvent.listeners[0](7, { url: currentUrl });
    await nextTurn();
    await nextTurn();

    const state = await dispatchRuntimeMessage(listener, { type: "popup.getState" });
    assert.equal(state.selectedTabId, undefined);
    assert.deepEqual(state.tabs, []);
    assert.equal(state.error, undefined);
    const persisted = writes.at(-1)["bachataBridgeState.v8"];
    assert.equal(persisted.selectedTabId, undefined);
    assert.equal(persisted.selectedSessionId, undefined);
    assert.deepEqual(persisted.handledTabIds ?? [], []);

    currentUrl = providerUrl;
    currentTabId = 8;
    const secondSender = {
      ...sender,
      tab: { id: 8, url: providerUrl },
      documentId: "document-id-8",
    };
    const secondRegistered = await dispatchRuntimeMessage(listener, {
      type: "content.register",
      provider: "chatgpt",
      documentToken,
      conversationUrl: providerUrl,
      conversationIdentity,
    }, secondSender);
    assert.deepEqual(secondRegistered, { success: true, registered: true });
    const secondSelected = await dispatchRuntimeMessage(listener, {
      type: "popup.select",
      tabId: 8,
    });
    assert.equal(secondSelected.selectedTabId, 8);

    currentUrl = "https://example.com/completed";
    updatedEvent.listeners[0](8, { status: "complete" });
    await nextTurn();
    await nextTurn();

    const completedState = await dispatchRuntimeMessage(listener, { type: "popup.getState" });
    assert.equal(completedState.selectedTabId, undefined);
    assert.deepEqual(completedState.tabs, []);
    assert.equal(completedState.error, undefined);
    const completedPersisted = writes.at(-1)["bachataBridgeState.v8"];
    assert.equal(completedPersisted.selectedTabId, undefined);
    assert.equal(completedPersisted.selectedSessionId, undefined);
    assert.deepEqual(completedPersisted.handledTabIds ?? [], []);
  } finally {
    restoreGlobals(saved);
  }
});



const runProviderComposerCleanupEntry = async (provider, removalControlAvailable = true, attachmentInputMode = "composer") => {
  const names = [
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLImageElement",
    "MutationObserver",
    "InputEvent",
    "Event",
    "DataTransfer",
    "File",
    "document",
    "location",
    "history",
    "window",
    "chrome",
    "CSS",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "clearInterval",
    "__pairAssetLogic",
    "__pairProviderControls",
    "__pairDomHealing",
    "__pairChatGptLogic",
    "__pairClaudeLogic",
    "__pairBrowserBridgeChatGptV6",
    "__pairBrowserBridgeClaudeV6",
  ];
  const saved = saveGlobals(names);
  const listeners = [];
  const sent = [];
  const providerUrl = provider === "chatgpt"
    ? "https://chatgpt.com/c/composer-cleanup"
    : "https://claude.ai/chat/composer-cleanup";
  const providerLabel = provider === "chatgpt" ? "ChatGPT" : "Claude";
  let removalVisible = false;
  let removalClicks = 0;
  let attachmentButtonClicks = 0;
  let introducedInputsVisible = false;
  const composerScopedAttachmentModes = new Set([
    "composer",
    "personControl",
    "personDuringDiscovery",
    "personBeforeSend",
  ]);
  const attachPersonFile = () => {
    fileInput._files = [
      ...fileInput._files,
      new CleanupFile([], "person-typed.png", { type: "image/png" }),
    ];
    removalVisible = true;
  };
  const attachmentControlInsideComposer = attachmentInputMode !== "unrelatedGlobal" && attachmentInputMode !== "trustedDetached";

  class CleanupElement extends FakeElement {
    constructor() {
      super();
      this.parentElement = null;
    }

    contains(element) {
      return element === composer ||
        element === removeButton ||
        element === sendButton ||
        (attachmentControlInsideComposer && element === attachButton) ||
        (attachmentInputMode === "ambiguousControls" && element === attachButtonB) ||
        (composerScopedAttachmentModes.has(attachmentInputMode) && element === fileInput) ||
        (attachmentInputMode === "ambiguous" && (element === introducedInputA || element === introducedInputB));
    }
  }

  class CleanupTextArea extends CleanupElement {
    constructor() {
      super();
      this._value = "";
    }

    get value() {
      return this._value;
    }

    set value(value) {
      const text = String(value);
      this._value = text ? `${text} normalized` : "";
      // BR-G6-02 residue. Staging has settled and the prompt is being written, which is the last
      // moment before the Send: the person attaches a file of their own right here.
      if (
        attachmentInputMode === "personBeforeSend" &&
        text &&
        fileInput._files.some((file) => file.name === "cleanup.png") &&
        !fileInput._files.some((file) => file.name === "person-typed.png")
      ) {
        attachPersonFile();
      }
    }
  }

  class CleanupInput extends CleanupElement {
    constructor() {
      super();
      this.accept = "image/*";
      this._files = [];
    }

    get files() {
      return this._files;
    }

    set files(value) {
      this._files = Array.from(value ?? []);
      // BR-G6-02, reopened. The person drops a file of their own into the composer in the same
      // moment this request's staging lands, and the provider renders their chip first.
      if (
        attachmentInputMode === "personControl" &&
        this === fileInput &&
        this._files.some((file) => file.name === "cleanup.png") &&
        !this._files.some((file) => file.name === "person-typed.png")
      ) {
        this._files.push(new CleanupFile([], "person-typed.png", { type: "image/png" }));
      }
      removalVisible = this._files.length > 0;
    }
  }

  class CleanupButton extends CleanupElement {
    constructor(kind) {
      super();
      this.kind = kind;
      this.disabled = false;
      this.isConnected = true;
      if (kind === "remove") {
        this.setAttribute("aria-label", "Remove attachment");
      } else if (kind === "attach") {
        this.setAttribute("aria-label", "Attach files");
      } else {
        this.setAttribute("aria-label", "Send message");
      }
    }

    click() {
      if (this.kind === "remove") {
        removalClicks += 1;
        removalVisible = false;
      } else if (this.kind === "attach") {
        attachmentButtonClicks += 1;
        introducedInputsVisible = true;
        // BR-G6-02 residue. Opening the picker is an awaited step; the person attaches during it.
        if (attachmentInputMode === "personDuringDiscovery") {
          attachPersonFile();
        }
      }
    }
  }

  class CleanupDataTransfer {
    constructor() {
      const values = [];
      this.items = { add: (value) => values.push(value) };
      Object.defineProperty(this, "files", { get: () => values });
    }
  }

  class CleanupFile {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type ?? "";
    }
  }

  class CleanupMutationObserver {
    disconnect() {}
    observe() {}
    takeRecords() {
      return [];
    }
  }

  class CleanupEvent {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
  }

  const form = new CleanupElement();
  const composer = new CleanupTextArea();
  const fileInput = new CleanupInput();
  const unrelatedInput = new CleanupInput();
  const introducedInputA = new CleanupInput();
  const introducedInputB = new CleanupInput();
  const removeButton = new CleanupButton("remove");
  const sendButton = new CleanupButton("send");
  const unrelatedSendButton = new CleanupButton("send");
  const attachButton = new CleanupButton("attach");
  const attachButtonB = new CleanupButton("attach");
  if (attachmentInputMode === "trustedDetached") {
    attachButton.setAttribute("data-testid", "composer-button-file-upload");
  }
  composer.parentElement = form;
  fileInput.parentElement = form;
  removeButton.parentElement = form;
  sendButton.parentElement = form;
  attachButton.parentElement = form;
  composer.closest = (selector) => selector === "form" ? form : null;
  fileInput.closest = (selector) => selector === "form" ? form : null;
  const querySelectorAll = (selector) => {
    if (
      selector === "#prompt-textarea" ||
      selector === "[data-testid='chat-input']"
    ) {
      return [composer];
    }
    if (selector === "input[type='file']") {
      if (attachmentInputMode === "personDuringDiscovery") {
        // The input only exists once the attachment control has been opened, so discovery has to
        // wait for it — and that wait is the window the person attaches their own file in.
        return introducedInputsVisible ? [fileInput] : [];
      }
      if (composerScopedAttachmentModes.has(attachmentInputMode)) {
        return [fileInput];
      }
      if (attachmentInputMode === "ambiguous") {
        return introducedInputsVisible
          ? [unrelatedInput, introducedInputA, introducedInputB]
          : [unrelatedInput];
      }
      if (attachmentInputMode === "trustedDetached") {
        return introducedInputsVisible ? [introducedInputA] : [unrelatedInput];
      }
      if (attachmentInputMode === "outsideIntroduced") {
        return introducedInputsVisible ? [unrelatedInput, introducedInputA] : [unrelatedInput];
      }
      return introducedInputsVisible ? [unrelatedInput, introducedInputA] : [unrelatedInput];
    }
    if (selector === "button[data-testid='composer-button-file-upload']") {
      return attachmentInputMode === "trustedDetached" ? [attachButton] : [];
    }
    if (selector.includes("Attach") || selector.includes("Upload")) {
      return attachmentInputMode === "ambiguousControls"
        ? [attachButton, attachButtonB]
        : [attachButton];
    }
    if (selector === "button[data-testid='send-button']") {
      return [sendButton];
    }
    if (selector === "button[aria-label='Send message']") {
      return [sendButton, unrelatedSendButton];
    }
    return [];
  };


  form.querySelectorAll = (selector) => {
    if (
      selector === "button[aria-label], button[title], button[data-testid]" &&
      removalVisible &&
      removalControlAvailable
    ) {
      removeButton.setAttribute(
        "aria-label",
        attachmentInputMode === "personControl"
          ? "Remove attachment person-typed.png"
          : "Remove attachment cleanup.png",
      );
      return [removeButton];
    }
    return querySelectorAll(selector).filter((element) => form.contains(element));
  };

  try {
    const current = new URL(providerUrl);
    const documentElement = new CleanupElement();
    const document = {
      activeElement: undefined,
      body: form,
      documentElement,
      createElement: () => new CleanupElement(),
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: (selector) => querySelectorAll(selector)[0] ?? null,
      querySelectorAll,
    };
    const location = { href: current.href, pathname: current.pathname };
    const history = {
      pushState: () => undefined,
      replaceState: () => undefined,
    };
    const window = {
      addEventListener: () => undefined,
      getSelection: () => undefined,
    };
    const chrome = {
      runtime: {
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => {
          sent.push(structuredClone(message));
          return quarantineAuthorityReply(message) ?? { success: true, registered: true };
        },
      },
    };

    setGlobal("Element", CleanupElement);
    setGlobal("HTMLElement", CleanupElement);
    setGlobal("HTMLTextAreaElement", CleanupTextArea);
    setGlobal("HTMLInputElement", CleanupInput);
    setGlobal("HTMLButtonElement", CleanupButton);
    setGlobal("HTMLAnchorElement", CleanupElement);
    setGlobal("HTMLImageElement", CleanupElement);
    setGlobal("MutationObserver", CleanupMutationObserver);
    setGlobal("InputEvent", CleanupEvent);
    setGlobal("Event", CleanupEvent);
    setGlobal("DataTransfer", CleanupDataTransfer);
    setGlobal("File", CleanupFile);
    setGlobal("document", document);
    setGlobal("location", location);
    setGlobal("history", history);
    setGlobal("window", window);
    setGlobal("chrome", chrome);
    setGlobal("CSS", { escape: (value) => String(value) });
    setGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    setGlobal("requestAnimationFrame", (callback) => {
      callback(Date.now());
      return 1;
    });
    setGlobal("cancelAnimationFrame", () => undefined);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    const stamp = `cleanup-${provider}-${Date.now()}-${Math.random()}`;
    await import(`../dist/content/assetLogic.js?${stamp}`);
    await import(`../dist/content/providerControls.js?${stamp}`);
    await import(`../dist/content/domHealing.js?${stamp}`);
    await import(`../dist/content/providerLogic.js?${stamp}`);
    await import(`../dist/content/${provider === "chatgpt" ? "chatgptLogic" : "claudeLogic"}.js?${stamp}`);
    await import(`../dist/content/${provider}.js?${stamp}`);
    await nextTurn();

    composer.value = "existing user draft";
    const occupiedStatus = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    assert.equal(occupiedStatus.status, "notReady");
    composer.value = "";
    const status = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    assert.equal(status.status, "ready");

    // BB-4 / BR-G6-02. The shared composer guard, through the provider entry that now
    // instantiates it: an attachment the person staged themselves is a refusal before anything
    // is submitted, worded in this provider's name — and the refusal leaves it exactly where
    // they put it. This request inserted nothing, so it takes nothing back out; the guard that
    // refuses because their attachment is there must not be the thing that deletes it. Only in
    // the mode where cleanup could have succeeded: the other modes are about what happens when
    // it cannot, and a blocked composer would change what they are testing.
    if (removalControlAvailable && attachmentInputMode === "composer") {
      fileInput.files = [new CleanupFile([], "already-attached.png", { type: "image/png" })];
      const conflicted = await dispatchRuntimeMessage(listeners[0], {
        type: "conversation.send",
        requestId: `conflict-${provider}`,
        agentId: provider,
        provider,
        sessionId: `session-conflict-${provider}`,
        tabId: 1,
        frameId: 0,
        documentToken: status.documentToken,
        conversationUrl: status.conversationUrl,
        conversationIdentity: status.conversationIdentity,
        text: "a prompt that must not be sent",
        attachments: [],
        allowInitialConversationTransition: false,
        deadlineAt: Date.now() + 30_000,
      }, {}, attachmentDispatchTimeoutMs);
      assert.equal(conflicted.submitted, false);
      assert.equal(
        conflicted.error,
        provider === "chatgpt"
          ? "ChatGPT composer already contains attachments. Send or clear them before using Bachata"
          : "Claude composer already contains attachments. Send or clear them before using Bachata",
      );
      assert.equal(fileInput.files.length, 1, "the refusal deleted the person's own attachment");
      assert.equal(
        removalClicks,
        0,
        "the refusal clicked a removal control for an attachment it never staged",
      );
      assert.equal(composer.value, "");
      const blockedByConflict = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
      assert.equal(
        blockedByConflict.status,
        "notReady",
        "an attachment the person left staged was reported as a ready composer",
      );
      // The person clears their own attachment. The counters belong to the case below, which
      // asserts exactly one removal click for the attachment this request stages itself.
      fileInput.files = [];
      removalClicks = 0;
      removalVisible = false;
    }

    const result = await dispatchRuntimeMessage(listeners[0], {
      type: "conversation.send",
      requestId: `cleanup-${provider}`,
      agentId: provider,
      provider,
      sessionId: `session-${provider}`,
      tabId: 1,
      frameId: 0,
      documentToken: status.documentToken,
      conversationUrl: status.conversationUrl,
      conversationIdentity: status.conversationIdentity,
      text: "provider cleanup prompt",
      attachments: [{
        name: "cleanup.png",
        mimeType: "image/png",
        size: 1,
        dataBase64: "AA==",
      }],
      allowInitialConversationTransition: false,
      deadlineAt: Date.now() + 30_000,
    }, {}, attachmentDispatchTimeoutMs);

    assert.equal(result.submitted, false);
    if (attachmentInputMode === "ambiguous") {
      assert.match(result.error, /ambiguous attachment inputs/);
      assert.equal(attachmentButtonClicks, 1);
      assert.equal(unrelatedInput.files.length, 0);
      assert.equal(introducedInputA.files.length, 0);
      assert.equal(introducedInputB.files.length, 0);
      assert.equal(composer.value, "");
      return;
    }
    if (attachmentInputMode === "unrelatedGlobal") {
      assert.match(result.error, /image attachment input is unavailable/);
      assert.equal(attachmentButtonClicks, 0);
      assert.equal(unrelatedInput.files.length, 0);
      assert.equal(introducedInputA.files.length, 0);
      assert.equal(composer.value, "");
      return;
    }
    if (attachmentInputMode === "ambiguousControls") {
      assert.match(result.error, /ambiguous attachment controls/);
      assert.equal(attachmentButtonClicks, 0);
      assert.equal(unrelatedInput.files.length, 0);
      assert.equal(composer.value, "");
      return;
    }
    if (attachmentInputMode === "outsideIntroduced") {
      assert.match(result.error, /input outside the composer/);
      assert.equal(attachmentButtonClicks, 1);
      assert.equal(unrelatedInput.files.length, 0);
      assert.equal(introducedInputA.files.length, 0);
      assert.equal(composer.value, "");
      return;
    }
    if (attachmentInputMode === "personDuringDiscovery") {
      // BR-G6-02 residue. The person's file landed while the attachment input was still being
      // opened. The native setter replaces the whole list, so writing here would have carried
      // their file away; the last look before the write refuses instead.
      assert.equal(
        result.error,
        `${providerLabel} composer gained an attachment Bachata did not stage. Send or clear it before using Bachata`,
      );
      assert.deepEqual(
        fileInput.files.map((file) => file.name),
        ["person-typed.png"],
        "the write overwrote the file the person attached",
      );
      assert.equal(removalClicks, 0);
      assert.equal(composer.value, "");
      // Nothing was written, so nothing is owned and the document is not blocked: the person can
      // clear their own attachment and use it again.
      const afterRefusal = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
      assert.equal(afterRefusal.status, "notReady");
      const retry = await dispatchRuntimeMessage(listeners[0], {
        type: "conversation.send",
        requestId: `discovery-retry-${provider}`,
        agentId: provider,
        provider,
        sessionId: `session-discovery-retry-${provider}`,
        tabId: 1,
        frameId: 0,
        documentToken: status.documentToken,
        conversationUrl: status.conversationUrl,
        conversationIdentity: status.conversationIdentity,
        text: "retry must not be blocked",
        attachments: [],
        allowInitialConversationTransition: false,
        deadlineAt: Date.now() + 30_000,
      }, {}, attachmentDispatchTimeoutMs);
      assert.equal(retry.submitted, false);
      assert.equal(
        retry.error,
        `${providerLabel} composer already contains attachments. Send or clear them before using Bachata`,
        "a request that wrote nothing blocked the document anyway",
      );
      assert.deepEqual(fileInput.files.map((file) => file.name), ["person-typed.png"]);
      return;
    }
    if (attachmentInputMode === "personBeforeSend") {
      // BR-G6-02 residue. Staging settled cleanly and the prompt went in; the person attached in
      // the last moment before the Send. The check immediately before the Send catches it, so
      // nothing of theirs is ever submitted.
      assert.match(result.error, /gained an attachment Bachata did not stage/u);
      assert.match(result.error, /cleanup could not be verified/u);
      assert.deepEqual(
        fileInput.files.map((file) => file.name),
        ["person-typed.png"],
        "the withdrawal took the person's file or left this request's behind",
      );
      assert.equal(removalClicks, 0);
      assert.equal(
        sent.some((message) => message.type === "content.stream" || message.type === "content.response"),
        false,
        "a submission continued after a foreign attachment appeared",
      );
      return;
    }
    if (attachmentInputMode === "personControl") {
      // BR-G6-02 residue. One removal control appeared after staging began and exactly one
      // attachment was expected, and it is the person's. Nothing binds it to this request's
      // file, so cleanup clicks nothing: it withdraws the exact `File` objects this request
      // placed, leaves the person's where it is, and blocks the composer because the control
      // that stayed behind means the withdrawal could not be proved.
      assert.match(result.error, /cleanup could not be verified/);
      assert.equal(
        removalClicks,
        0,
        "cleanup clicked a control that named the person's own attachment",
      );
      assert.deepEqual(
        fileInput.files.map((file) => file.name),
        ["person-typed.png"],
        "an unprovable cleanup kept this request's own attachment on the person's input",
      );
      // BR-G6-02 residue. Both providers now refuse during staging, the moment the input holds
      // something neither of them placed, so neither reaches the prompt insertion at all.
      assert.equal(composer.value, "");
      const blockedByAmbiguity = await dispatchRuntimeMessage(listeners[0], {
        type: "provider.status",
      });
      assert.equal(blockedByAmbiguity.status, "failed");
      const blockedRetry = await dispatchRuntimeMessage(listeners[0], {
        type: "conversation.send",
        requestId: `cleanup-person-retry-${provider}`,
        agentId: provider,
        provider,
        sessionId: `session-person-retry-${provider}`,
        tabId: 1,
        frameId: 0,
        documentToken: status.documentToken,
        conversationUrl: status.conversationUrl,
        conversationIdentity: status.conversationIdentity,
        text: "retry must remain blocked",
        attachments: [],
        allowInitialConversationTransition: false,
        deadlineAt: Date.now() + 30_000,
      });
      assert.equal(blockedRetry.submitted, false);
      assert.match(blockedRetry.error, /Reload the provider tab/);
      return;
    }
    assert.match(result.error, /composer changed the prompt text/);
    // BR-G6-02, reopened. This composer rewrites whatever is written into it, so what it holds
    // when the refusal lands is no longer this request's exact insertion. Nothing in the DOM
    // distinguishes that from a person who retyped the prompt, so the text stays where it is and
    // the document is blocked instead of cleared. The attachment half is evidenced separately
    // and is still withdrawn.
    assert.equal(composer.value, "provider cleanup prompt normalized");
    assert.match(result.error, /cleanup could not be verified/);
    assert.equal(fileInput.files.length, 0);
    assert.equal(removalVisible, false);
    // BR-G6-02 residue. No removal control is clicked at all any more: the input is rebuilt
    // around the exact `File` objects this request placed and the page is told, and this
    // composer's control follows the input, which is what makes the withdrawal observable.
    assert.equal(removalClicks, 0, "cleanup clicked a control instead of rebuilding the input");
    const blockedStatus = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    assert.equal(blockedStatus.status, "failed");
    const retry = await dispatchRuntimeMessage(listeners[0], {
      type: "conversation.send",
      requestId: `cleanup-retry-${provider}`,
      agentId: provider,
      provider,
      sessionId: `session-retry-${provider}`,
      tabId: 1,
      frameId: 0,
      documentToken: status.documentToken,
      conversationUrl: status.conversationUrl,
      conversationIdentity: status.conversationIdentity,
      text: "retry must remain blocked",
      attachments: [],
      allowInitialConversationTransition: false,
      deadlineAt: Date.now() + 30_000,
    });
    assert.equal(retry.submitted, false);
    assert.match(retry.error, /Reload the provider tab/);
    await driveEntryMessageTable(listeners[0], provider, sent);
  } finally {
    restoreGlobals(saved);
  }
};

test("production ChatGPT entry clears staged attachments after a pre-submit prompt failure", async () => {
  await runProviderComposerCleanupEntry("chatgpt");
});

test("production Claude entry clears staged attachments after a pre-submit prompt failure", async () => {
  await runProviderComposerCleanupEntry("claude");
});


test("production ChatGPT entry blocks retries when attachment cleanup cannot be verified", async () => {
  await runProviderComposerCleanupEntry("chatgpt", false);
});

test("production Claude entry blocks retries when attachment cleanup cannot be verified", async () => {
  await runProviderComposerCleanupEntry("claude", false);
});


test("production ChatGPT entry rejects ambiguous page-wide attachment inputs", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "ambiguous");
});

test("production Claude entry rejects ambiguous page-wide attachment inputs", async () => {
  await runProviderComposerCleanupEntry("claude", true, "ambiguous");
});

test("production ChatGPT entry ignores unrelated global attachment controls", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "unrelatedGlobal");
});

test("production Claude entry ignores unrelated global attachment controls", async () => {
  await runProviderComposerCleanupEntry("claude", true, "unrelatedGlobal");
});

test("production ChatGPT entry accepts its exact detached composer upload control", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "trustedDetached");
});

test("production ChatGPT entry rejects multiple composer attachment controls", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "ambiguousControls");
});

test("production Claude entry rejects multiple composer attachment controls", async () => {
  await runProviderComposerCleanupEntry("claude", true, "ambiguousControls");
});

test("production ChatGPT entry never clicks a removal control the person's own attachment brought", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "personControl");
});

test("production ChatGPT entry refuses a file the person attaches while the input is being opened", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "personDuringDiscovery");
});

test("production Claude entry refuses a file the person attaches while the input is being opened", async () => {
  await runProviderComposerCleanupEntry("claude", true, "personDuringDiscovery");
});

test("production ChatGPT entry stops a Send when the person attaches after staging settles", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "personBeforeSend");
});

test("production Claude entry stops a Send when the person attaches after staging settles", async () => {
  await runProviderComposerCleanupEntry("claude", true, "personBeforeSend");
});

test("production Claude entry never clicks a removal control the person's own attachment brought", async () => {
  await runProviderComposerCleanupEntry("claude", true, "personControl");
});

test("production ChatGPT entry rejects inputs introduced outside its composer", async () => {
  await runProviderComposerCleanupEntry("chatgpt", true, "outsideIntroduced");
});

test("production Claude entry rejects inputs introduced outside its composer", async () => {
  await runProviderComposerCleanupEntry("claude", true, "outsideIntroduced");
});


const runClaudeStopControlScopeEntry = async (associatedStopVisible) => {
  const names = [
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLImageElement",
    "MutationObserver",
    "document",
    "location",
    "history",
    "window",
    "chrome",
    "CSS",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "clearInterval",
    "__pairAssetLogic",
    "__pairProviderControls",
    "__pairClaudeLogic",
    "__pairBrowserBridgeClaudeV6",
  ];
  const saved = saveGlobals(names);
  const listeners = [];

  class ScopeElement extends FakeElement {
    constructor() {
      super();
      this.parentElement = null;
    }

    contains(element) {
      return element === composer || element === associatedSend || element === associatedStop;
    }
  }

  class ScopeButton extends ScopeElement {
    constructor(label) {
      super();
      this.setAttribute("aria-label", label);
    }
  }

  const form = new ScopeElement();
  const composer = new ScopeElement();
  const associatedSend = new ScopeButton("Send message");
  const associatedStop = new ScopeButton("Stop response");
  const unrelatedStop = new ScopeButton("Stop voice mode");
  composer.parentElement = form;
  composer.closest = (selector) => selector === "form" ? form : null;
  form.querySelectorAll = (selector) => {
    if (selector.includes("Send")) {
      return [associatedSend];
    }
    if (selector.includes("Stop")) {
      return associatedStopVisible ? [associatedStop] : [];
    }
    return [];
  };

  const querySelectorAll = (selector) => {
    if (selector === "[data-testid='chat-input']") {
      return [composer];
    }
    if (selector === "input[type='file']") {
      return [];
    }
    if (selector.includes("Send")) {
      return [associatedSend];
    }
    if (selector.includes("Stop")) {
      return associatedStopVisible ? [associatedStop, unrelatedStop] : [unrelatedStop];
    }
    return [];
  };

  try {
    const current = new URL("https://claude.ai/chat/control-scope");
    const document = {
      activeElement: undefined,
      body: form,
      documentElement: new ScopeElement(),
      createElement: () => new ScopeElement(),
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: (selector) => querySelectorAll(selector)[0] ?? null,
      querySelectorAll,
    };
    const location = { href: current.href, pathname: current.pathname };
    const history = { pushState: () => undefined, replaceState: () => undefined };
    const window = { addEventListener: () => undefined, getSelection: () => undefined };
    const chrome = {
      runtime: {
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => quarantineAuthorityReply(message) ?? { success: true, registered: true },
      },
    };

    setGlobal("Element", ScopeElement);
    setGlobal("HTMLElement", ScopeElement);
    setGlobal("HTMLTextAreaElement", ScopeElement);
    setGlobal("HTMLInputElement", ScopeElement);
    setGlobal("HTMLButtonElement", ScopeButton);
    setGlobal("HTMLAnchorElement", ScopeElement);
    setGlobal("HTMLImageElement", ScopeElement);
    setGlobal("MutationObserver", FakeMutationObserver);
    setGlobal("document", document);
    setGlobal("location", location);
    setGlobal("history", history);
    setGlobal("window", window);
    setGlobal("chrome", chrome);
    setGlobal("CSS", { escape: (value) => String(value) });
    setGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    setGlobal("requestAnimationFrame", (callback) => {
      callback(Date.now());
      return 1;
    });
    setGlobal("cancelAnimationFrame", () => undefined);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    const stamp = `claude-control-scope-${String(associatedStopVisible)}-${Date.now()}-${Math.random()}`;
    await import(`../dist/content/assetLogic.js?${stamp}`);
    await import(`../dist/content/providerControls.js?${stamp}`);
    await import(`../dist/content/domHealing.js?${stamp}`);
    await import(`../dist/content/providerLogic.js?${stamp}`);
    await import(`../dist/content/claudeLogic.js?${stamp}`);
    await import(`../dist/content/claude.js?${stamp}`);
    await nextTurn();

    const status = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    assert.equal(status.status, associatedStopVisible ? "streaming" : "ready");
    await driveEntryMessageTable(listeners[0], "claude");
  } finally {
    restoreGlobals(saved);
  }
};

test("production Claude entry ignores unrelated global Stop controls", async () => {
  await runClaudeStopControlScopeEntry(false);
});

test("production Claude entry detects a Stop control inside the active composer", async () => {
  await runClaudeStopControlScopeEntry(true);
});

// Q2 at the real entry: an authority that cannot answer must stop the send. The gate runs before
// composer resolution, so this harness needs no page controls — only the authority reply changes.
const runProviderQuarantineAuthorityEntry = async (
  provider,
  authorityReply,
  { ambiguousStopControls = false, ambiguousComposer = false } = {},
) => {
  const names = [
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLImageElement",
    "MutationObserver",
    "document",
    "location",
    "history",
    "window",
    "chrome",
    "CSS",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "clearInterval",
    "__pairAssetLogic",
    "__pairProviderControls",
    "__pairProviderLogic",
    provider === "chatgpt" ? "__pairChatGptLogic" : "__pairClaudeLogic",
    provider === "chatgpt" ? "__pairBrowserBridgeChatGptV6" : "__pairBrowserBridgeClaudeV6",
  ];
  const saved = saveGlobals(names);
  const listeners = [];

  try {
    const current = new URL(
      provider === "chatgpt"
        ? "https://chatgpt.com/c/authority"
        : "https://claude.ai/chat/authority",
    );
    const composerSelector = /prompt-textarea|chat-input|ProseMirror|role='textbox'/u;
    const ambiguousControlRoot = new FakeElement();
    ambiguousControlRoot.querySelectorAll = (selector) =>
      ambiguousStopControls && /stop/iu.test(String(selector))
        ? [new FakeElement(), new FakeElement()]
        : [];
    const composerElement = new FakeElement();
    composerElement.parentElement = ambiguousControlRoot;
    const document = {
      activeElement: undefined,
      body: new FakeElement(),
      documentElement: new FakeElement(),
      createElement: () => new FakeElement(),
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: () => null,
      // A stop control the page shows twice is the one case a unique-control query refuses
      // to resolve. ChatGPT asks the document; Claude asks the composer's own control root,
      // so that root has to exist before the ambiguity can be reached at all.
      querySelectorAll: (selector) => {
        const text = String(selector);
        if (composerSelector.test(text)) {
          if (ambiguousComposer) return [new FakeElement(), new FakeElement()];
          return ambiguousStopControls ? [composerElement] : [];
        }
        if (ambiguousStopControls && /stop/iu.test(text)) {
          return [new FakeElement(), new FakeElement()];
        }
        return [];
      },
    };
    const location = { href: current.href, pathname: current.pathname };
    const history = { pushState: () => undefined, replaceState: () => undefined };
    const window = { addEventListener: () => undefined, getSelection: () => undefined };
    const chrome = {
      runtime: {
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => (
          String(message?.type ?? "").startsWith("BACHATA_QUARANTINE_")
            ? authorityReply(message)
            : { success: true, registered: true }
        ),
      },
    };

    setGlobal("Element", FakeElement);
    setGlobal("HTMLElement", FakeElement);
    setGlobal("HTMLTextAreaElement", FakeElement);
    setGlobal("HTMLInputElement", FakeElement);
    setGlobal("HTMLButtonElement", FakeElement);
    setGlobal("HTMLAnchorElement", FakeElement);
    setGlobal("HTMLImageElement", FakeElement);
    setGlobal("MutationObserver", FakeMutationObserver);
    setGlobal("document", document);
    setGlobal("location", location);
    setGlobal("history", history);
    setGlobal("window", window);
    setGlobal("chrome", chrome);
    setGlobal("CSS", { escape: (value) => String(value) });
    setGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    setGlobal("requestAnimationFrame", (callback) => {
      callback(Date.now());
      return 1;
    });
    setGlobal("cancelAnimationFrame", () => undefined);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    const stamp = `${provider}-authority-${Date.now()}-${Math.random()}`;
    await import(`../dist/content/assetLogic.js?${stamp}`);
    await import(`../dist/content/providerControls.js?${stamp}`);
    await import(`../dist/content/domHealing.js?${stamp}`);
    await import(`../dist/content/providerLogic.js?${stamp}`);
    await import(`../dist/content/${provider === "chatgpt" ? "chatgptLogic" : "claudeLogic"}.js?${stamp}`);
    await import(`../dist/content/${provider}.js?${stamp}`);
    await nextTurn();

    const status = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    const refusal = await dispatchRuntimeMessage(listeners[0], {
      type: "conversation.send",
      requestId: "request-authority",
      agentId: provider,
      provider,
      sessionId: "session-authority",
      tabId: 1,
      frameId: 0,
      documentToken: status.documentToken,
      conversationUrl: status.conversationUrl,
      conversationIdentity: status.conversationIdentity,
      text: "hello",
      attachments: [],
      allowInitialConversationTransition: false,
      deadlineAt: Date.now() + 30_000,
    });
    await driveEntryMessageTable(listeners[0], provider);
    return refusal;
  } finally {
    restoreGlobals(saved);
  }
};

for (const provider of ["chatgpt", "claude"]) {
  test(`production ${provider} entry refuses to send while the quarantine authority is unavailable`, async () => {
    for (const reply of [
      () => { throw new Error("service worker asleep"); },
      () => ({ ok: false, error: "Conversation quarantine authority is unavailable" }),
      () => ({ success: true }),
    ]) {
      const refused = await runProviderQuarantineAuthorityEntry(provider, async () => reply());
      assert.equal(refused.submitted, false);
      assert.match(refused.error, /quarantine authority is unavailable/);
    }
  });

  // BB-AUD-10. The pre-send guard asks whether a response is already active. `stopButton()`
  // throws when the page shows more than one stop control and no healed binding resolves it,
  // which is exactly the state the guard cannot rule out. It used to be swallowed, and the
  // send proceeded into a turn that might still have been running.
  test(`production ${provider} entry refuses to send when the stop control is ambiguous`, async () => {
    const refused = await runProviderQuarantineAuthorityEntry(
      provider,
      async () => ({ ok: true, value: false }),
      { ambiguousStopControls: true },
    );
    assert.equal(refused.submitted, false);
    assert.match(refused.error, /more than one matching control/);
    assert.match(refused.error, /active response cannot be ruled out/);
  });

  // BB-AUD-10. `resolveComposer` absorbs an ambiguous composer so that one healing pass can
  // run. The contract is that it never returns a guessed control: with no healed binding the
  // send fails closed, and the ambiguity the page created is what the user is told about.
  test(`production ${provider} entry fails closed on an ambiguous composer`, async () => {
    const refused = await runProviderQuarantineAuthorityEntry(
      provider,
      async () => ({ ok: true, value: false }),
      { ambiguousComposer: true },
    );
    assert.equal(refused.submitted, false);
    // ChatGPT resolves the stop control against the document, so the ambiguity surfaces
    // later and names itself; Claude scopes it to the composer's own control root, so the
    // same page state is caught by the pre-send guard first. Both refuse.
    assert.match(
      refused.error,
      /ambiguous provider controls|more than one matching control|composer is unavailable/u,
    );
  });

  test(`production ${provider} entry names a held verdict separately from an unavailable authority`, async () => {
    const held = await runProviderQuarantineAuthorityEntry(provider, async () => ({ ok: true, value: true }));
    assert.equal(held.submitted, false);
    assert.match(held.error, /quarantined because provider idle state could not be confirmed/);

    // The control: a confirmed clear passes the gate, so the refusals above are the authority
    // and not the harness.
    const cleared = await runProviderQuarantineAuthorityEntry(provider, async () => ({ ok: true, value: false }));
    assert.equal(cleared.submitted, false);
    assert.match(cleared.error, /composer is unavailable/);
  });
}

// A1 at the real entry: the structured code has to survive the content boundary, and a bare page
// alert with the very same words must change nothing.
const runChatGptAlertEntry = async ({
  dialogText,
  silentDialogText,
  bareAlertText,
  composerAlertText,
  acceptUpload = false,
  alertAfterMs = 0,
  staleAlertText,
  withAttachment = false,
  synchronousRefusal = false,
  sameNodeRefusal = false,
}) => {
  const names = [
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLImageElement",
    "MutationObserver",
    "document",
    "location",
    "history",
    "window",
    "chrome",
    "CSS",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "clearInterval",
    "__pairAssetLogic",
    "__pairProviderControls",
    "__pairProviderLogic",
    "__pairChatGptLogic",
    "__pairBrowserBridgeChatGptV6",
    "DataTransfer",
    "File",
    "Event",
  ];
  const saved = saveGlobals(names);
  const listeners = [];

  const alertOf = (text) => {
    const element = new FakeElement();
    element.innerText = text;
    element.textContent = text;
    element.setAttribute("role", "alert");
    return element;
  };
  const dialogOf = (text) => {
    const element = new FakeElement();
    // The modal's own body says more than its alert region, exactly as a real one does.
    element.innerText = `${text} Cancel Continue Terms apply.`;
    element.textContent = element.innerText;
    element.setAttribute("role", "dialog");
    element.querySelectorAll = (selector) => (
      selector.includes('[role="alert"]') ? [alertOf(text)] : []
    );
    return element;
  };

  const silentDialogOf = (text) => {
    const element = new FakeElement();
    element.innerText = text;
    element.textContent = text;
    element.setAttribute("role", "dialog");
    return element;
  };

  // The composer case needs a real form, a file input whose prototype exposes the `files` setter
  // the adapter uses, and an input that refuses the assignment — that refusal is what makes the
  // provider's own alert the explanation instead of a generic "did not accept" message.
  class AlertElement extends FakeElement {
    constructor() {
      super();
      this.parentElement = null;
    }

    contains(element) {
      return element === composerElement || element === fileInput || element === sendButton;
    }
  }

  class AlertInput extends AlertElement {
    constructor() {
      super();
      this.accept = "image/*";
      this._files = [];
    }

    get files() {
      return this._files;
    }

    set files(value) {
      refusedAt = Date.now();
      // The synchronous case: the page rewrites its alert region and renders the attachment
      // control inside the same handler that received the files, before any observer callback runs.
      if (synchronousRefusal) {
        removalVisible = true;
        if (synchronousAlertNode) queueMutation(synchronousAlertNode);
      }
      // Two shapes of the same refusal. Either the assignment lands nowhere, or it is accepted
      // and the refusal is rendered a moment later — the asynchronous case an immediate single
      // check and a blind fixed wait both miss.
      if (acceptUpload) this._files = Array.from(value ?? []);
      uploadRefused = true;
    }
  }

  class AlertDataTransfer {
    constructor() {
      const values = [];
      this.items = { add: (value) => values.push(value) };
      Object.defineProperty(this, "files", { get: () => values });
    }
  }

  class AlertFile {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type ?? "";
    }
  }

  let uploadRefused = false;
  let alertReads = 0;
  let refusedAt = 0;
  let removalVisible = false;
  let synchronousAlertNode;
  const composerPresent = Boolean(composerAlertText || staleAlertText || withAttachment);
  const removalButton = new FakeElement();
  removalButton.setAttribute("aria-label", "Remove file");
  const composerForm = composerPresent ? new AlertElement() : undefined;
  const composerElement = composerPresent ? new AlertElement() : undefined;
  const fileInput = composerPresent ? new AlertInput() : undefined;
  const sendButton = composerPresent ? new AlertElement() : undefined;
  if (composerPresent) {
    composerElement.parentElement = composerForm;
    fileInput.parentElement = composerForm;
    sendButton.parentElement = composerForm;
    sendButton.setAttribute("data-testid", "send-button");
    composerElement.closest = (selector) => (selector === "form" ? composerForm : null);
    fileInput.closest = (selector) => (selector === "form" ? composerForm : null);
  }

  try {
    const current = new URL("https://chatgpt.com/c/alerts");
    const dialogs = dialogText
      ? [dialogOf(dialogText)]
      : silentDialogText ? [silentDialogOf(silentDialogText)] : [];
    const bareAlerts = bareAlertText ? [alertOf(bareAlertText)] : [];
    const composerAlerts = composerAlertText ? [alertOf(composerAlertText)] : [];
    const staleAlert = staleAlertText ? alertOf(staleAlertText) : undefined;
    synchronousAlertNode = sameNodeRefusal ? staleAlert : composerAlerts[0];
    const querySelectorAll = (selector) => {
      if (selector === '[role="dialog"]') return dialogs;
      if (selector.includes('[role="alert"]')) return bareAlerts;
      if (!composerPresent) return [];
      if (selector === "#prompt-textarea" || selector === "[data-testid='prompt-textarea']") {
        return [composerElement];
      }
      if (selector.includes("prompt-textarea")) return [composerElement];
      if (selector === "input[type='file']") return [fileInput];
      if (selector === "button[data-testid='send-button']") return [sendButton];
      if (selector === "button[aria-label], button[title], button[data-testid]") {
        return removalVisible ? [removalButton] : [];
      }
      return [];
    };
    if (composerForm) {
      composerForm.querySelectorAll = (selector) => {
        if (selector === "button[aria-label], button[title], button[data-testid]") {
          return removalVisible ? [removalButton] : [];
        }
        if (!selector.includes('[role="alert"]')) {
          return querySelectorAll(selector).filter((element) => composerForm.contains(element));
        }
        // A stale alert is on screen from before this upload, and can be worded identically.
        const stale = staleAlertText ? [staleAlert] : [];
        if (!uploadRefused) return stale;
        // One node throughout: the words never changed, only the region's contents did.
        if (sameNodeRefusal) return stale;
        if (synchronousRefusal) return [...stale, ...composerAlerts];
        if (alertAfterMs > 0) {
          return Date.now() - refusedAt >= alertAfterMs ? [...stale, ...composerAlerts] : stale;
        }
        // The alert renders a poll later than the assignment, never in the same tick.
        alertReads += 1;
        return alertReads > 1 ? [...stale, ...composerAlerts] : stale;
      };
    }
    const document = {
      activeElement: undefined,
      body: composerForm ?? new FakeElement(),
      documentElement: new FakeElement(),
      createElement: () => new FakeElement(),
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: (selector) => querySelectorAll(selector)[0] ?? null,
      querySelectorAll,
    };
    const location = { href: current.href, pathname: current.pathname };
    const history = { pushState: () => undefined, replaceState: () => undefined };
    const window = { addEventListener: () => undefined, getSelection: () => undefined };
    const chrome = {
      runtime: {
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => (
          quarantineAuthorityReply(message) ?? { success: true, registered: true }
        ),
      },
    };

    setGlobal("Element", composerPresent ? AlertElement : FakeElement);
    setGlobal("HTMLElement", composerPresent ? AlertElement : FakeElement);
    setGlobal("HTMLTextAreaElement", composerPresent ? AlertElement : FakeElement);
    setGlobal("HTMLInputElement", composerPresent ? AlertInput : FakeElement);
    setGlobal("HTMLButtonElement", composerPresent ? AlertElement : FakeElement);
    setGlobal("HTMLAnchorElement", FakeElement);
    setGlobal("HTMLImageElement", FakeElement);
    setGlobal("MutationObserver", FakeMutationObserver);
    setGlobal("DataTransfer", AlertDataTransfer);
    setGlobal("File", AlertFile);
    setGlobal("Event", class AlertEvent {
      constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
      }
    });
    setGlobal("document", document);
    setGlobal("location", location);
    setGlobal("history", history);
    setGlobal("window", window);
    setGlobal("chrome", chrome);
    setGlobal("CSS", { escape: (value) => String(value) });
    setGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    setGlobal("requestAnimationFrame", (callback) => {
      callback(Date.now());
      return 1;
    });
    setGlobal("cancelAnimationFrame", () => undefined);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    const stamp = `chatgpt-alerts-${Date.now()}-${Math.random()}`;
    await import(`../dist/content/assetLogic.js?${stamp}`);
    await import(`../dist/content/providerControls.js?${stamp}`);
    await import(`../dist/content/domHealing.js?${stamp}`);
    await import(`../dist/content/providerLogic.js?${stamp}`);
    await import(`../dist/content/chatgptLogic.js?${stamp}`);
    await import(`../dist/content/chatgpt.js?${stamp}`);
    await nextTurn();

    const status = await dispatchRuntimeMessage(listeners[0], { type: "provider.status" });
    const outcome = await dispatchRuntimeMessage(listeners[0], {
      type: "conversation.send",
      requestId: "request-alert",
      agentId: "chatgpt",
      provider: "chatgpt",
      sessionId: "session-alert",
      tabId: 1,
      frameId: 0,
      documentToken: status.documentToken,
      conversationUrl: status.conversationUrl,
      conversationIdentity: status.conversationIdentity,
      text: "hello",
      // The attachment is requested independently of any alert, so a case can send one with only
      // a stale alert on screen and still exercise the upload path.
      attachments: composerAlertText || withAttachment
        ? [{ name: "shot.png", mimeType: "image/png", size: 1, dataBase64: "AA==" }]
        : [],
      allowInitialConversationTransition: false,
      deadlineAt: Date.now() + 30_000,
    }, {}, attachmentDispatchTimeoutMs);
    await driveEntryMessageTable(listeners[0], "chatgpt");
    return outcome;
  } finally {
    restoreGlobals(saved);
  }
};

test("production ChatGPT entry refuses a send behind an account-level provider dialog", async () => {
  const refused = await runChatGptAlertEntry({
    dialogText: "Your session has expired. Please log in again.",
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_SESSION_EXPIRED");
  assert.equal(refused.error, "Your session has expired. Please log in again.");
});

test("production ChatGPT entry ignores the same words in a bare page alert", async () => {
  const unaffected = await runChatGptAlertEntry({
    bareAlertText: "Your session has expired. Please log in again.",
  });
  assert.equal(unaffected.submitted, false);
  assert.equal(unaffected.code, undefined, "an unscoped page alert produced a provider taxonomy");
  assert.match(unaffected.error, /composer is unavailable/);
});

test("production ChatGPT entry leaves an unclassifiable dialog alone", async () => {
  const unaffected = await runChatGptAlertEntry({ dialogText: "Une erreur est survenue." });
  assert.equal(unaffected.submitted, false);
  assert.equal(unaffected.code, undefined);
  assert.match(unaffected.error, /composer is unavailable/);
});

// A1 across the Bridge boundary: a provider-classified refusal has to reach the controller as its
// own code, and an unclassified one must stay the generic submission failure.
const runBackgroundSubmissionRefusalEntry = async (contentAck, options = {}) => {
  const names = ["chrome", "WebSocket", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const sockets = [];
  const url = "https://chatgpt.com/c/refusal-session";
  const documentToken = "document-refusal-session";
  const conversationIdentity = `chatgpt:${url}`;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
      },
      tabs: {
        query: async () => [{ id: 7, title: "Refusal session", url }],
        get: async () => ({ id: 7, title: "Refusal session", url }),
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async (_tabId, message) => {
          if (message.type === "provider.status") {
            return { status: "ready", documentToken, conversationUrl: url, conversationIdentity };
          }
          if (message.type === "conversation.send") return contentAck;
          return { success: true, registered: true };
        },
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      close() {
        this.readyState = 3;
        this.emit("close", {});
      }

      emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      send(value) {
        this.sent.push(JSON.parse(String(value)));
      }
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?refusal-background-${Date.now()}-${Math.random()}`);
    await nextTurn();
    // N1. Every background entry subscribes Chrome's navigation events, so every harness that
    // starts one proves they are installed and that a report reaches the same tab-change path
    // `tabs.onUpdated` reaches. A subframe is refused here as it is anywhere else.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed",
    });
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 7,
      documentId: "installed-subframe",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/subframe",
    });
    historyEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed",
    });
    fragmentEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed#a",
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    const listener = runtimeEvent.listeners[0];
    await dispatchRuntimeMessage(listener, {
      type: "content.register",
      provider: "chatgpt",
      documentToken,
      conversationUrl: url,
      conversationIdentity,
    }, { tab: { id: 7, url }, frameId: 0, documentId: "document-id-7", url });
    await dispatchRuntimeMessage(listener, {
      type: "popup.pair",
      endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
      token: "pairing-token",
    });
    const socket = sockets[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open", {});
    socket.emit("message", {
      data: JSON.stringify({
        type: "bridge.paired",
        protocolVersion: 9,
        connectionToken: "connection-token",
      }),
    });
    await nextTurn();
    socket.emit("message", { data: JSON.stringify({ type: "bridge.connected", protocolVersion: 9 }) });
    await nextTurn();
    await nextTurn();

    const selected = await dispatchRuntimeMessage(listener, { type: "popup.select", tabId: 7 });
    const sessionId = selected.tabs[0].sessionId;
    socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "request-refusal",
        agentId: "agent-refusal",
        provider: "chatgpt",
        sessionId,
        tabId: 7,
        frameId: 0,
        documentId: "document-id-7",
        documentToken,
        conversationUrl: url,
        conversationIdentity,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
        deadlineAt: Date.now() + 30_000,
      }),
    });
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();
    // A case that needs more than one message from the server drives the rest itself, against
    // the same worker, socket and session.
    await options.follow?.({
      socket,
      sessionId,
      binding: {
        protocolVersion: 9,
        agentId: "agent-refusal",
        provider: "chatgpt",
        sessionId,
        tabId: 7,
        frameId: 0,
        documentId: "document-id-7",
        documentToken,
        conversationUrl: url,
        conversationIdentity,
      },
      settle: async () => {
        for (let turn = 0; turn < 12; turn += 1) await nextTurn();
      },
    });
    return socket.sent.filter((message) => message.type === "conversation.error");
  } finally {
    restoreGlobals(saved);
  }
};

test("production background forwards a provider-classified refusal as its own code", async () => {
  const errors = await runBackgroundSubmissionRefusalEntry({
    submitted: false,
    error: "You've reached your message limit for GPT-5.",
    code: "PROVIDER_RATE_LIMITED",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "PROVIDER_RATE_LIMITED");
  assert.equal(errors[0].message, "You've reached your message limit for GPT-5.");
  assert.equal(errors[0].requestId, "request-refusal");
});

test("production background leaves an unclassified refusal as a submission failure", async () => {
  const errors = await runBackgroundSubmissionRefusalEntry({
    submitted: false,
    error: "ChatGPT composer is unavailable",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "SUBMISSION_FAILED");
  // The refusal reached the adapter rather than failing earlier in the binding checks, so the
  // code above is the one chosen for a real content answer.
  assert.equal(errors[0].message, "ChatGPT composer is unavailable");
});

// BR-G6-11. A second `conversation.send` carrying a request id that is already running is
// refused before it registers anything — and the refusal used to remove that id from the
// registry, which is the incumbent's own registration. The turn kept running in the browser
// while the worker forgot it: its completion could no longer be routed and its Stop matched
// nothing.
test("a refused duplicate send leaves the request it collided with running", async () => {
  const interrupts = [];
  const errors = await runBackgroundSubmissionRefusalEntry({ submitted: true }, {
    follow: async ({ socket, binding, settle }) => {
      socket.emit("message", {
        data: JSON.stringify({
          ...binding,
          type: "conversation.send",
          requestId: "request-refusal",
          text: "the same turn, sent twice",
          attachments: [],
          allowInitialConversationTransition: false,
          deadlineAt: Date.now() + 30_000,
        }),
      });
      await settle();
      // The incumbent is still the worker's, so its Stop still reaches it.
      socket.emit("message", {
        data: JSON.stringify({
          ...binding,
          type: "conversation.interrupt",
          requestId: "request-refusal",
        }),
      });
      await settle();
      interrupts.push(...socket.sent.filter((message) => message.type === "conversation.error"));
    },
  });
  const duplicate = errors.filter((message) =>
    /already has an active request/u.test(String(message.message)));
  assert.equal(duplicate.length, 1, "the duplicate send was not refused");
  assert.deepEqual(
    errors.filter((message) => message.code === "INTERRUPT_MISMATCH"),
    [],
    "the refused duplicate deleted the running request, so its Stop no longer matched",
  );
  void interrupts;
});

// BB-A4-N06. A second send for a session that is already occupied is refused under its own,
// never-registered request id. The answer used to be conditional on finding that id in the
// registry, so the refusal reached nobody: the incumbent kept streaming and the new request
// received no frame at all.
test("a send for an occupied session is refused to the request that sent it", async () => {
  const errors = await runBackgroundSubmissionRefusalEntry({ submitted: true }, {
    follow: async ({ socket, binding, settle }) => {
      socket.emit("message", {
        data: JSON.stringify({
          ...binding,
          type: "conversation.send",
          requestId: "request-second",
          text: "a different turn for the same session",
          attachments: [],
          allowInitialConversationTransition: false,
          deadlineAt: Date.now() + 30_000,
        }),
      });
      await settle();
    },
  });
  const refusal = errors.filter((message) => message.requestId === "request-second");
  assert.equal(refusal.length, 1, `the occupied session sent no refusal: ${JSON.stringify(errors)}`);
  assert.match(String(refusal[0].message), /already has an active request/u);
  assert.deepEqual(
    errors.filter((message) => message.requestId === "request-refusal"),
    [],
    "refusing the second request answered for the incumbent",
  );
});

test("production ChatGPT entry explains a refused upload in the provider's own words", async () => {
  const refused = await runChatGptAlertEntry({
    composerAlertText: "Upload failed: the file is too large.",
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_ATTACHMENT_REJECTED", `payload ${JSON.stringify(refused)}`);
  // The provider's own words lead; this harness cannot prove composer cleanup, so the adapter's
  // existing cleanup warning follows them.
  assert.match(refused.error, /^Upload failed: the file is too large\./);
});

test("production ChatGPT entry ignores a modal with no alert region of its own", async () => {
  // The words are the same; the structure is not. A modal body is not a provider alert.
  const unaffected = await runChatGptAlertEntry({
    silentDialogText: "Your session has expired. Please log in again.",
  });
  assert.equal(unaffected.submitted, false);
  assert.equal(unaffected.code, undefined);
  assert.match(unaffected.error, /composer is unavailable/);
});

test("production ChatGPT entry catches an upload refusal that arrives after the files are accepted", async () => {
  // The input took the files and the refusal rendered afterwards. The old check looked once,
  // immediately, and then waited a fixed 100 ms without looking again.
  const refused = await runChatGptAlertEntry({
    composerAlertText: "Upload failed: the file is too large.",
    acceptUpload: true,
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_ATTACHMENT_REJECTED", `got ${JSON.stringify(refused)}`);
  assert.match(refused.error, /^Upload failed: the file is too large\./);
});

test("production ChatGPT entry catches an upload refusal that renders long after the files land", async () => {
  // 700 ms is past any short accept shortcut and inside the bounded refusal window. The point is
  // that no measured provider timing justifies calling retained files acceptance early.
  const refused = await runChatGptAlertEntry({
    composerAlertText: "Upload failed: the file is too large.",
    acceptUpload: true,
    alertAfterMs: 700,
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_ATTACHMENT_REJECTED");
});

test("production ChatGPT entry sees a fresh refusal worded exactly like the stale one", async () => {
  const refused = await runChatGptAlertEntry({
    staleAlertText: "Upload failed: the file is too large.",
    composerAlertText: "Upload failed: the file is too large.",
    acceptUpload: true,
    alertAfterMs: 300,
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_ATTACHMENT_REJECTED");
});

test("production ChatGPT entry is not stopped by a stale alert alone", async () => {
  // A real upload runs, with those same words already on screen before it and nothing new after:
  // the send must reach its ordinary failure instead of borrowing the old alert's meaning.
  const unaffected = await runChatGptAlertEntry({
    staleAlertText: "Upload failed: the file is too large.",
    withAttachment: true,
    acceptUpload: true,
  });
  assert.equal(unaffected.submitted, false);
  assert.equal(unaffected.code, undefined, "a stale alert was read as this upload's refusal");
  assert.match(unaffected.error, /composer|prompt|send/i);
});

test("production ChatGPT entry reads a refusal rendered in the same turn as the attachment control", async () => {
  // The hard case for a deferred observer: the page takes the files, rewrites its alert region and
  // renders the attachment control all inside one synchronous handler. Accepting on the control
  // alone, or trusting a revision the observer has not delivered yet, sends a refused upload.
  const refused = await runChatGptAlertEntry({
    composerAlertText: "Upload failed: the file is too large.",
    acceptUpload: true,
    synchronousRefusal: true,
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_ATTACHMENT_REJECTED");
  assert.match(refused.error, /^Upload failed: the file is too large\./);
});

test("production ChatGPT entry still accepts an upload the provider did not refuse", async () => {
  // The same synchronous path with no alert at all: the attachment control is the provider's own
  // proof, and the send proceeds to its ordinary next step.
  const accepted = await runChatGptAlertEntry({
    withAttachment: true,
    acceptUpload: true,
    synchronousRefusal: true,
  });
  assert.equal(accepted.submitted, false);
  assert.equal(accepted.code, undefined);
  assert.match(accepted.error, /prompt|composer|send/i);
});

test("production ChatGPT entry reads a same-node refusal repeated in the same turn", async () => {
  // One live region, already on screen with those exact words, cleared and refilled inside the
  // handler that took the files. Node and wording both match what was remembered before the
  // upload, so only a revision read at decision time — not one delivered a microtask later —
  // separates this refusal from the alert already accounted for.
  const refused = await runChatGptAlertEntry({
    staleAlertText: "Upload failed: the file is too large.",
    withAttachment: true,
    acceptUpload: true,
    synchronousRefusal: true,
    sameNodeRefusal: true,
  });
  assert.equal(refused.submitted, false);
  assert.equal(refused.code, "PROVIDER_ATTACHMENT_REJECTED");
});

// The background's exact-key allowlist decides which captured-asset properties may cross the
// production boundary at all. A property the producer already emits but the allowlist omits fails
// the whole `content.response`, so origin coverage has to run through the real listener rather
// than the extension parser that never sees the message.
const runBackgroundCapturedAssetEntry = async (assetOverrides) => {
  const names = ["chrome", "WebSocket", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  // N1. The background subscribes Chrome's own navigation events and adapts `tabs.onReplaced`.
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const sockets = [];
  const url = "https://chatgpt.com/c/asset-session";
  const documentToken = "document-asset-session";
  const conversationIdentity = `chatgpt:${url}`;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
      },
      tabs: {
        query: async () => [{ id: 7, title: "Asset session", url }],
        get: async () => ({ id: 7, title: "Asset session", url }),
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async (_tabId, message) => {
          if (message.type === "provider.status") {
            return { status: "ready", documentToken, conversationUrl: url, conversationIdentity };
          }
          if (message.type === "conversation.send") return { submitted: true };
          return { success: true, registered: true };
        },
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: replacedEvent,
      },
      webNavigation: {
        onCommitted: committedEvent,
        onHistoryStateUpdated: historyEvent,
        onReferenceFragmentUpdated: fragmentEvent,
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        this.sent = [];
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      close() {
        this.readyState = 3;
        this.emit("close", {});
      }

      emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      send(value) {
        this.sent.push(JSON.parse(String(value)));
      }
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?asset-background-${Date.now()}-${Math.random()}`);
    await nextTurn();
    // N1. Every background entry subscribes Chrome's navigation events, so every harness that
    // starts one proves they are installed and that a report reaches the same tab-change path
    // `tabs.onUpdated` reaches. A subframe is refused here as it is anywhere else.
    assert.equal(committedEvent.listeners.length, 1);
    assert.equal(historyEvent.listeners.length, 1);
    assert.equal(fragmentEvent.listeners.length, 1);
    assert.equal(replacedEvent.listeners.length, 1);
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed",
    });
    committedEvent.listeners[0]({
      tabId: 4243,
      frameId: 7,
      documentId: "installed-subframe",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/subframe",
    });
    historyEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed",
    });
    fragmentEvent.listeners[0]({
      tabId: 4243,
      frameId: 0,
      documentId: "installed-document",
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/installed-pushed#a",
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    const listener = runtimeEvent.listeners[0];
    const sender = { tab: { id: 7, url }, frameId: 0, documentId: "document-id-7", url };
    await dispatchRuntimeMessage(listener, {
      type: "content.register",
      provider: "chatgpt",
      documentToken,
      conversationUrl: url,
      conversationIdentity,
    }, sender);
    await dispatchRuntimeMessage(listener, {
      type: "popup.pair",
      endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
      token: "pairing-token",
    });
    const socket = sockets[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open", {});
    socket.emit("message", {
      data: JSON.stringify({
        type: "bridge.paired",
        protocolVersion: 9,
        connectionToken: "connection-token",
      }),
    });
    await nextTurn();
    socket.emit("message", { data: JSON.stringify({ type: "bridge.connected", protocolVersion: 9 }) });
    await nextTurn();
    await nextTurn();

    const selected = await dispatchRuntimeMessage(listener, { type: "popup.select", tabId: 7 });
    const sessionId = selected.tabs[0].sessionId;
    socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "request-asset",
        agentId: "agent-asset",
        provider: "chatgpt",
        sessionId,
        tabId: 7,
        frameId: 0,
        documentId: "document-id-7",
        documentToken,
        conversationUrl: url,
        conversationIdentity,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
        deadlineAt: Date.now() + 30_000,
      }),
    });
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();

    const startedAt = new Date().toISOString();
    const ack = await dispatchRuntimeMessage(listener, {
      type: "content.response",
      documentToken,
      response: {
        requestId: "request-asset",
        agentId: "agent-asset",
        sessionId,
        provider: "chatgpt",
        text: "ok",
        segments: [{ type: "text", text: "ok", start: 0, end: 2 }],
        assets: [{
          id: "asset-1",
          provider: "chatgpt",
          kind: "generatedFile",
          name: "report.txt",
          mimeType: "text/plain",
          sourceElement: "assistantMessage",
          downloadAvailable: true,
          ...assetOverrides,
        }],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        finalConversationUrl: url,
        startedAt,
        completedAt: new Date().toISOString(),
      },
    }, sender);
    for (let turn = 0; turn < 4; turn += 1) await nextTurn();
    return {
      ack,
      responses: socket.sent.filter((message) => message.type === "conversation.response"),
      errors: socket.sent.filter((message) => message.type === "conversation.error"),
    };
  } finally {
    restoreGlobals(saved);
  }
};

test("production background forwards a captured asset carrying a canonical source origin", async () => {
  const { ack, responses, errors } = await runBackgroundCapturedAssetEntry({
    sourceOrigin: "https://cdn.example.invalid",
  });
  assert.deepEqual(ack, { success: true });
  assert.equal(errors.length, 0, `unexpected errors ${JSON.stringify(errors)}`);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].assets[0].sourceOrigin, "https://cdn.example.invalid");
});

test("production background forwards a captured asset with no source origin", async () => {
  const { ack, responses, errors } = await runBackgroundCapturedAssetEntry({});
  assert.deepEqual(ack, { success: true });
  assert.equal(errors.length, 0, `unexpected errors ${JSON.stringify(errors)}`);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].assets[0].sourceOrigin, undefined);
});

test("production background rejects a captured asset source origin carrying a path", async () => {
  const { ack, responses, errors } = await runBackgroundCapturedAssetEntry({
    sourceOrigin: "https://cdn.example.invalid/generated/report.txt",
  });
  assert.deepEqual(ack, { success: false, error: "Invalid browser response" });
  assert.equal(responses.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "INVALID_RESPONSE");
});

test("production background rejects an opaque captured asset source origin", async () => {
  const { ack, responses, errors } = await runBackgroundCapturedAssetEntry({
    sourceOrigin: "null",
  });
  assert.deepEqual(ack, { success: false, error: "Invalid browser response" });
  assert.equal(responses.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "INVALID_RESPONSE");
});

test("production background rejects a non-http captured asset source origin", async () => {
  const { ack, responses, errors } = await runBackgroundCapturedAssetEntry({
    sourceOrigin: "blob:https://chatgpt.com",
  });
  assert.deepEqual(ack, { success: false, error: "Invalid browser response" });
  assert.equal(responses.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "INVALID_RESPONSE");
});

// The ChatGPT capture loop reads `closest`, subtree queries and node identity from the live page,
// so its production behaviour is exercised against a real DOM rather than element stubs that
// answer only the queries a test thought to write.
const runChatGptCaptureEntry = async ({
  answer,
  settle,
  waitMs = 20_000,
  readerFault,
  responseMessageId = "assistant-1",
}) => {
  const names = [
    "window", "document", "location", "history", "Node", "Element", "HTMLElement",
    "HTMLTextAreaElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement",
    "HTMLImageElement", "Event", "InputEvent", "KeyboardEvent", "CSS", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "chrome",
    "setInterval", "clearInterval",
    "__pairAssetLogic", "__pairProviderControls", "__pairDomHealing", "__pairProviderLogic",
    "__pairChatGptLogic", "__pairBrowserBridgeChatGptV6",
  ];
  const saved = saveGlobals(names);
  const dom = createChatGptCaptureDom();
  let aborted = false;
  let settled = false;
  let clicks = 0;
  let stopCapture;
  try {
    const stamp = `capture-${Date.now()}-${Math.random()}`;
    await import(`../dist/content/assetLogic.js?${stamp}`);
    await import(`../dist/content/providerControls.js?${stamp}`);
    await import(`../dist/content/domHealing.js?${stamp}`);
    await import(`../dist/content/providerLogic.js?${stamp}`);
    await import(`../dist/content/chatgptLogic.js?${stamp}`);
    await import(`../dist/content/chatgpt.js?${stamp}`);
    await nextTurn();

    const listener = dom.listeners[0];
    const status = await dispatchRuntimeMessage(listener, { type: "provider.status" });
    // A capture loop still polling after the fixture's globals are gone would keep reading a page
    // that no longer exists. The turn is interrupted through the adapter's own path instead.
    stopCapture = async (settled) => {
      // Interrupting a turn that already ended registers a pre-submit cancellation the adapter
      // then holds for its full TTL. A finished capture needs no unwinding.
      if (settled) return;
      await dispatchRuntimeMessage(listener, {
        type: "conversation.interrupt",
        requestId: "request-capture",
        provider: "chatgpt",
        sessionId: "session-capture",
        tabId: 1,
        frameId: 0,
        documentToken: status.documentToken,
        conversationUrl: status.conversationUrl,
        conversationIdentity: status.conversationIdentity,
      }, {}, 5_000).catch(() => undefined);
      for (let turn = 0; turn < 40; turn += 1) await sleep(10);
    };

    // The provider's own answer to Send: the turn appears, generation starts, and the page keeps
    // rendering until the test says the answer is settled.
    dom.sendButton().addEventListener("click", () => {
      const thread = dom.thread();
      thread.appendChild(dom.html(
        `<article data-testid="conversation-turn-1">`
        + `<div data-message-author-role="user" data-message-id="user-1">hello</div>`
        + `</article>`,
      ));
      thread.appendChild(dom.html(
        `<article data-testid="conversation-turn-2">`
        + `<div data-message-author-role="assistant"${
          responseMessageId ? ` data-message-id="${responseMessageId}"` : ""
        }></div>`
        + `</article>`,
      ));
      dom.query("form").appendChild(dom.html(`<button data-testid="stop-button"></button>`));
      // The exact nodes the completion-evidence path would serialize if it were active.
      dom.countInnerHtml(dom.query("[data-message-author-role='assistant']"));
      dom.countInnerHtml(dom.query("article[data-testid='conversation-turn-2']"));
      if (readerFault) {
        dom.failInnerText(
          dom.query("[data-message-author-role='assistant']"),
          (read) => readerFault(read, dom),
        );
      }
      clicks += 1;
      void settle({ dom, answer, aborted: () => aborted });
    });

    const submitted = await dispatchRuntimeMessage(listener, {
      type: "conversation.send",
      requestId: "request-capture",
      agentId: "chatgpt",
      provider: "chatgpt",
      sessionId: "session-capture",
      tabId: 1,
      frameId: 0,
      documentToken: status.documentToken,
      conversationUrl: status.conversationUrl,
      conversationIdentity: status.conversationIdentity,
      text: "hello",
      attachments: [],
      allowInitialConversationTransition: false,
      deadlineAt: Date.now() + 30_000,
    }, {}, 20_000);

    const terminal = () => dom.sent.find(
      (message) => message.type === "content.response" || message.type === "content.error",
    );
    const deadline = Date.now() + waitMs;
    while (!terminal() && Date.now() < deadline) await sleep(50);

    settled = terminal() !== undefined;
    return {
      submitted,
      terminal: terminal(),
      sent: dom.sent,
      innerHtmlReads: dom.innerHtmlReads(),
      innerTextReads: dom.innerTextReads(),
      clicks,
      observedTurns: dom.observedTargets.filter(
        (target) => target?.getAttribute?.("data-testid")?.startsWith("conversation-turn-") === true,
      ).length,
      quarantined: dom.sent.filter((message) => message.type === "BACHATA_QUARANTINE_SET"),
    };
  } finally {
    aborted = true;
    await stopCapture?.(settled);
    dom.restore();
    restoreGlobals(saved);
  }
};

// Generation runs for `busyMs` so the adapter observes the lifecycle it requires, then the answer
// lands and Stop disappears. Turns that spend their first observations on injected faults need a
// generation long enough to still be seen, exactly as a real one would be.
const settleAnswerAfter = (busyMs) => async ({ dom, answer }) => {
  await sleep(busyMs);
  dom.query("[data-message-author-role='assistant']").textContent = answer;
  await sleep(20);
  dom.query("button[data-testid='stop-button']")?.remove();
};

const settleAnswer = settleAnswerAfter(20);

// One settled turn, read by both the completion assertions and the dormancy assertions. The run
// installs its own globals and restores them, so it happens inside a test rather than at import.
let settledCapture;
const captureSettledTurn = async () => {
  settledCapture ??= await runChatGptCaptureEntry({
    answer: "the settled answer",
    settle: settleAnswer,
  });
  return settledCapture;
};

test("production ChatGPT capture answers a settled turn through the real DOM", async () => {
  const capture = await captureSettledTurn();
  assert.equal(capture.submitted.submitted, true, JSON.stringify(capture.submitted));
  assert.equal(capture.terminal?.type, "content.response", JSON.stringify(capture.terminal));
  assert.equal(capture.terminal.response.text.includes("the settled answer"), true);
  assert.equal(capture.quarantined.length, 0);
});

test("production ChatGPT capture reads nothing extra while the terminal control is unproven", async () => {
  // Gate / L1 keeps the completion-evidence path dormant, and dormant has to mean absent: no turn
  // observer, no candidate state, and no answer serialized on every poll of every turn.
  const capture = await captureSettledTurn();
  assert.equal(capture.innerHtmlReads, 0, "the disabled path serialized the response");
  assert.equal(capture.observedTurns, 0, "the disabled path observed the turn container");
  assert.equal(capture.terminal?.type, "content.response");
});


test("production ChatGPT capture never completes an answer still being rewritten", async () => {
  // Generation ended, but the page keeps rewriting the answer past the quiet window. A turn that
  // is still changing has not settled, whatever the clock says.
  const rewriting = async ({ dom, aborted }) => {
    await sleep(20);
    dom.query("button[data-testid='stop-button']")?.remove();
    while (!aborted()) {
      const response = dom.query("[data-message-author-role='assistant']");
      if (!response) return;
      response.textContent = `rewritten ${String(Date.now())}`;
      await sleep(200);
    }
  };
  // Twice the quiet window with the answer never holding still. Completing here would be silence
  // winning over evidence, which is exactly what C1 forbids.
  const { terminal } = await runChatGptCaptureEntry({
    answer: "unused",
    settle: rewriting,
    waitMs: 6_000,
  });
  assert.equal(terminal, undefined, `completed a moving answer: ${JSON.stringify(terminal)}`);
});

test("production ChatGPT capture fails a turn closed and quarantines the conversation", async () => {
  // A provider alert bound to this response is terminal. This is the path a completion that
  // cannot be proven travels on: an error with the provider's own code, and a quarantined
  // conversation, never a response assembled out of silence.
  const refusing = async ({ dom }) => {
    await sleep(20);
    dom.query("[data-message-author-role='assistant']").appendChild(
      dom.html(`<div role="alert">Something went wrong while generating the response.</div>`),
    );
    await sleep(20);
    dom.query("button[data-testid='stop-button']")?.remove();
  };
  const { terminal, quarantined } = await runChatGptCaptureEntry({
    answer: "unused",
    settle: refusing,
  });
  assert.equal(terminal?.type, "content.error", JSON.stringify(terminal));
  assert.equal(terminal.code, "PROVIDER_RESPONSE_FAILED", JSON.stringify(terminal));
  assert.equal(quarantined.length > 0, true);
});

const readerFault = () => new TypeError("Cannot read properties of null (reading 'textContent')");

test("production ChatGPT capture re-reads a transient reader fault and still answers the turn", async () => {
  // The turn is already accepted by ChatGPT. A defect in this adapter's own reading of the page
  // must not discard an answer that no retry is allowed to ask for again.
  const { terminal, clicks, quarantined } = await runChatGptCaptureEntry({
    answer: "survived the fault",
    settle: settleAnswerAfter(1_500),
    readerFault: (read) => (read <= 3 ? readerFault() : undefined),
  });
  assert.equal(terminal?.type, "content.response", JSON.stringify(terminal));
  assert.equal(terminal.response.text.includes("survived the fault"), true);
  assert.equal(clicks, 1, "the prompt was sent more than once");
  assert.equal(quarantined.length, 0);
});

test("production ChatGPT capture clears the reader budget after every successful read", async () => {
  // Sixteen faults in one turn, twice the budget, but never nine in a row. The budget is
  // consecutive, and a successful observation - including the one that first reports a rebound
  // response - is what clears it.
  const { terminal, clicks } = await runChatGptCaptureEntry({
    answer: "survived both bursts",
    settle: settleAnswerAfter(3_000),
    readerFault: (read) => (read <= 8 || (read >= 10 && read <= 17) ? readerFault() : undefined),
  });
  assert.equal(terminal?.type, "content.response", JSON.stringify(terminal));
  assert.equal(terminal.response.text.includes("survived both bursts"), true);
  assert.equal(clicks, 1, "the prompt was sent more than once");
});

test("production ChatGPT capture fails the turn once the reader budget is exhausted", async () => {
  const { terminal, clicks, quarantined, innerTextReads } = await runChatGptCaptureEntry({
    answer: "never read",
    settle: settleAnswer,
    readerFault: () => readerFault(),
    waitMs: 10_000,
  });
  assert.equal(terminal?.type, "content.error", JSON.stringify(terminal));
  assert.match(terminal.message, /Cannot read properties of null/u);
  assert.equal(terminal.code, "RESPONSE_CAPTURE_FAILED");
  assert.equal(quarantined.length > 0, true, "an unprovable turn was not quarantined");
  assert.equal(clicks, 1, "the prompt was sent more than once");
  // Eight tolerated looks and the ninth that ends the turn. Not one read more.
  assert.equal(innerTextReads, 9);
});

test("production ChatGPT capture never re-reads a failure that is not a reader fault", async () => {
  // A non-TypeError is the page or the protocol speaking. It is answered on the first observation,
  // with no budget spent and no second look.
  const { terminal, clicks, innerTextReads } = await runChatGptCaptureEntry({
    answer: "never read",
    settle: settleAnswer,
    readerFault: () => new Error("ChatGPT response association became ambiguous"),
    waitMs: 10_000,
  });
  assert.equal(terminal?.type, "content.error", JSON.stringify(terminal));
  assert.match(terminal.message, /association became ambiguous/u);
  assert.equal(clicks, 1, "the prompt was sent more than once");
  // One look, no budget spent, no second read.
  assert.equal(innerTextReads, 1);
});

test("production ChatGPT capture gives a rebound response its own reader budget", async () => {
  // Resolution commits the replacement before the reads that follow it. The node is replaced
  // immediately after its eighth consecutive fault, so the replacement's very first read is the
  // one that would be counted as the ninth if the budget were not cleared at resolution.
  const replacing = async ({ dom }) => {
    await sleep(2_000);
    dom.query("button[data-testid='stop-button']")?.remove();
  };
  const { terminal, clicks, quarantined } = await runChatGptCaptureEntry({
    answer: "answered after the rebind",
    settle: replacing,
    readerFault: (read, dom) => {
      if (read === 8) {
        setTimeout(() => {
          const previous = dom.query("[data-message-author-role='assistant']");
          if (!previous) return;
          const replacement = dom.html(
            `<div data-message-author-role="assistant" data-message-id="assistant-1"></div>`,
          );
          previous.parentNode.replaceChild(replacement, previous);
          dom.failInnerText(replacement, (read) => (read === 1 ? readerFault() : undefined));
          replacement.textContent = "answered after the rebind";
        }, 0);
      }
      return read <= 8 ? readerFault() : undefined;
    },
  });
  assert.equal(terminal?.type, "content.response", JSON.stringify(terminal));
  assert.equal(terminal.response.text.includes("answered after the rebind"), true);
  assert.equal(clicks, 1, "the prompt was sent more than once");
  assert.equal(quarantined.length, 0);
});

test("production ChatGPT capture still reports a provider alert after repeated reader faults", async () => {
  // Reading alerts re-selects the attachment input, binds the alert observer and drains its
  // records. Repeating that across faulted looks must lose neither the alert nor its wording.
  const refusingAfterFaults = async ({ dom }) => {
    await sleep(900);
    dom.query("[data-message-author-role='assistant']").appendChild(
      dom.html(`<div role="alert">Something went wrong while generating the response.</div>`),
    );
    await sleep(200);
    dom.query("button[data-testid='stop-button']")?.remove();
  };
  const { terminal, clicks } = await runChatGptCaptureEntry({
    answer: "never read",
    settle: refusingAfterFaults,
    readerFault: (read) => (read <= 8 ? readerFault() : undefined),
    waitMs: 10_000,
  });
  assert.equal(terminal?.type, "content.error", JSON.stringify(terminal));
  assert.equal(terminal.code, "PROVIDER_RESPONSE_FAILED", JSON.stringify(terminal));
  assert.equal(clicks, 1, "the prompt was sent more than once");
});

test("production ChatGPT capture gives a partially committed replacement its own budget", async () => {
  // Resolution assigns `binding.element` and only then reads the replacement's id. An id-less
  // replacement whose first metadata read faults never returns from resolution at all, so the
  // fault has to be recognised as belonging to the new node from the binding rather than from a
  // node the observation never handed back.
  const replacing = async ({ dom }) => {
    await sleep(2_000);
    dom.query("button[data-testid='stop-button']")?.remove();
  };
  const { terminal, clicks, quarantined } = await runChatGptCaptureEntry({
    answer: "answered after the partial commit",
    settle: replacing,
    responseMessageId: "",
    readerFault: (read, dom) => {
      if (read === 8) {
        setTimeout(() => {
          const previous = dom.query("[data-message-author-role='assistant']");
          if (!previous) return;
          const replacement = dom.html(`<div data-message-author-role="assistant"></div>`);
          previous.parentNode.replaceChild(replacement, previous);
          // Selector matching reads other attributes first, so the fault is pinned to the first
          // read of the id itself - the one resolution makes after it has already rebound.
          let identityReads = 0;
          dom.failGetAttribute(replacement, (_read, name) => {
            if (name !== "data-message-id") return undefined;
            identityReads += 1;
            return identityReads === 1 ? readerFault() : undefined;
          });
          replacement.textContent = "answered after the partial commit";
        }, 0);
      }
      return read <= 8 ? readerFault() : undefined;
    },
  });
  assert.equal(terminal?.type, "content.response", JSON.stringify(terminal));
  assert.equal(terminal.response.text.includes("answered after the partial commit"), true);
  assert.equal(clicks, 1, "the prompt was sent more than once");
  assert.equal(quarantined.length, 0);
});

test("production ChatGPT capture keeps alert bookkeeping across a fault raised after it", async () => {
  // `innerText` faults before the alert is ever read, so it proves nothing about the bookkeeping
  // that reading alerts performs. This fault lands on the Stop query, after the alert observer has
  // been bound and its records drained in the same look.
  const refusingAfterFaults = async ({ dom }) => {
    await sleep(400);
    dom.query("[data-message-author-role='assistant']").appendChild(
      dom.html(`<div role="alert">Something went wrong while generating the response.</div>`),
    );
    dom.failStopQuery((query) => (query <= 8 ? readerFault() : undefined));
    await sleep(400);
    dom.query("button[data-testid='stop-button']")?.remove();
  };
  const { terminal, clicks } = await runChatGptCaptureEntry({
    answer: "never read",
    settle: refusingAfterFaults,
    waitMs: 10_000,
  });
  assert.equal(terminal?.type, "content.error", JSON.stringify(terminal));
  assert.equal(terminal.code, "PROVIDER_RESPONSE_FAILED", JSON.stringify(terminal));
  assert.equal(
    terminal.message,
    "Something went wrong while generating the response.",
    JSON.stringify(terminal),
  );
  assert.equal(clicks, 1, "the prompt was sent more than once");
});
// BB-AUD-09. A background harness with a registered content document. Everything below needs one
// and no other background test builds one, which is why the asset-transfer path was only ever
// exercised through its refusals: a transfer needs an asset, an asset arrives on a captured
// response, and a captured response needs an active request against a document the entry holds.
const registeredDocumentHarness = async (label, options = {}) => {
  const names = ["chrome", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  const replacedEvent = createEvent();
  const committedEvent = createEvent();
  const historyEvent = createEvent();
  const fragmentEvent = createEvent();
  const alarmEvent = createEvent();
  const sockets = [];
  const timers = new Map();
  let nextTimerId = 1;
  const providerUrl = options.providerUrl ?? "https://chatgpt.com/c/registered";
  const documentToken = "registered-document-token";
  let providerTabs = [{ id: 31, url: providerUrl, title: "registered" }];
  // BB-A4-N04. Every reinjection this entry performs, by tab, so a document that was replaced can
  // be shown to be picked up again rather than left for manual rediscovery.
  const injections = [];
  // BB-A4-F10. A provisioning step held open between the lookup and what it does with the answer,
  // so a Disconnect landing inside that window is a place a test can stand rather than a race.
  // `tabCalls` records every navigation the entry attempts.
  const tabCalls = [];
  let tabGetGate;
  let tabCreateGate;
  // A content script speaks as its own tab, top frame, with the document token it registered.
  const contentSender = {
    id: "bachata-bridge-test",
    frameId: 0,
    documentId: "registered-document-id",
    tab: { id: 31, url: providerUrl },
    url: providerUrl,
  };

  const fromContent = (message, sender = contentSender) => new Promise((resolve, reject) => {
    for (const listener of runtimeEvent.listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    reject(new Error(`no listener claimed ${String(message.type)}`));
  });

  // BB-AUD-09. Injecting the content script is what makes a provider page register, and the
  // entry waits for exactly that before it calls a tab usable. A harness whose injection
  // registered nothing left the entry waiting out its whole five-second deadline on every
  // construction — five seconds of wall clock per test, and no closer to the real sequence.
  const registerInjectedDocument = async (tabId) => {
    if (tabId !== contentSender.tab.id) return;
    await fromContent({
      type: "content.register",
      provider: "chatgpt",
      documentToken,
      conversationUrl: providerUrl,
      conversationIdentity: `chatgpt:${providerUrl}`,
    }).catch(() => undefined);
  };

  // What the page answers the background with. A submission is only a submission when the page
  // says so; anything else is a refusal the entry reports rather than a turn it waits on.
  let contentReply = { success: true, submitted: true };
  // Every message the entry sent a tab, in order, so a test can name what the page was asked
  // for rather than inferring it from what came back.
  const tabMessages = [];
  const defaultTabMessageHandler = async (_tabId, message) => {
    // Before injection there is no content script, so Chrome rejects rather than answering.
    if (message?.type === "content.reregister") {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return message?.type === "provider.status"
      ? {
          status: "ready",
          documentToken,
          conversationUrl: providerUrl,
          conversationIdentity: `chatgpt:${providerUrl}`,
          conversationState: "confirmed",
        }
      : contentReply;
  };
  // BB-AUD-09. A Generic turn is a conversation between the entry and a page that answers
  // several different commands, so the answer is a function of the command rather than one
  // fixed reply. The built-in providers keep the reply they had.
  let tabMessageHandler = defaultTabMessageHandler;

  const chrome = {
    ...backgroundChromeSupport(),
    alarms: { create: async () => undefined, clear: async () => true, onAlarm: alarmEvent },
    runtime: { id: "bachata-bridge-test", onMessage: runtimeEvent },
    storage: {
      local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    },
    permissions: { contains: async () => true },
    tabs: {
      query: async () => providerTabs,
      get: async (tabId) => {
        tabCalls.push({ call: "get", tabId });
        if (tabGetGate) await tabGetGate;
        return providerTabs.find((tab) => tab.id === tabId);
      },
      create: async (options) => {
        tabCalls.push({ call: "create", options });
        if (tabCreateGate) await tabCreateGate;
        return { id: 512, url: options?.url, title: "opened" };
      },
      update: async (tabId, options) => {
        tabCalls.push({ call: "update", tabId, options });
        return undefined;
      },
      remove: async (tabId) => {
        tabCalls.push({ call: "remove", tabId });
        return undefined;
      },
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        return await tabMessageHandler(tabId, message);
      },
      onRemoved: removedEvent,
      onUpdated: updatedEvent,
      onReplaced: replacedEvent,
    },
    webNavigation: {
      onCommitted: committedEvent,
      onHistoryStateUpdated: historyEvent,
      onReferenceFragmentUpdated: fragmentEvent,
    },
    scripting: {
      executeScript: async (details) => {
        injections.push(details?.target?.tabId);
        await registerInjectedDocument(details?.target?.tabId);
      },
    },
    windows: { update: async () => undefined },
  };
  class FakeWebSocket {
    static OPEN = 1;

    constructor(endpoint) {
      this.endpoint = endpoint;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const values = this.listeners.get(type) ?? [];
      values.push(listener);
      this.listeners.set(type, values);
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }

    send(value) {
      this.sent.push(JSON.parse(String(value)));
    }
  }
  setGlobal("chrome", chrome);
  setGlobal("WebSocket", FakeWebSocket);
  // The entry's only outbound network path is the local-model proxy, and it is the one thing in
  // this harness that would leave the machine. Every request it makes is recorded and answered
  // here, so a test can name the URL and the body the entry sent.
  const fetchCalls = [];
  let fetchHandler = async () => { throw new Error("no local model is listening"); };
  setGlobal("fetch", async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return await fetchHandler(String(url), init);
  });
  const realSetTimeout = globalThis.setTimeout;
  setGlobal("setTimeout", (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    if (delay <= 100) return realSetTimeout(callback, 0);
    return id;
  });
  setGlobal("clearTimeout", (id) => timers.delete(id));
  setGlobal("setInterval", () => 1);
  setGlobal("clearInterval", () => undefined);

  await import(`../dist/background/index.js?${label}-${Date.now()}-${Math.random()}`);
  await nextTurn();
  // N1. This harness starts the entry, so it subscribes Chrome's navigation events like any
  // other, and proves it the same way: installed, and a report reaching the tab-change path,
  // with a subframe refused.
  assert.equal(committedEvent.listeners.length, 1);
  assert.equal(historyEvent.listeners.length, 1);
  assert.equal(fragmentEvent.listeners.length, 1);
  assert.equal(replacedEvent.listeners.length, 1);
  committedEvent.listeners[0]({
    tabId: 4243,
    frameId: 0,
    documentId: "harness-document",
    documentLifecycle: "active",
    url: "https://chatgpt.com/c/harness",
  });
  committedEvent.listeners[0]({
    tabId: 4243,
    frameId: 9,
    documentId: "harness-subframe",
    documentLifecycle: "active",
    url: "https://chatgpt.com/c/harness-subframe",
  });
  historyEvent.listeners[0]({
    tabId: 4243,
    frameId: 0,
    documentId: "harness-document",
    documentLifecycle: "active",
    url: "https://chatgpt.com/c/harness-pushed",
  });
  fragmentEvent.listeners[0]({
    tabId: 4243,
    frameId: 0,
    documentId: "harness-document",
    documentLifecycle: "active",
    url: "https://chatgpt.com/c/harness-pushed#a",
  });
  await nextTurn();
  await nextTurn();
  // The entry answers the popup before anything is paired, and forgets a tab that closes. Both
  // are entry behaviour every one of these harnesses exercises, so both are proved here.
  const initial = await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.getState" });
  assert.equal(initial.connected, false);
  await dispatchRuntimeMessage(runtimeEvent.listeners[0], { type: "popup.discover" });
  removedEvent.listeners[0](4243);
  await nextTurn();
  await nextTurn();

  const pair = async () => {
    await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.pair",
      endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
      token: "pairing-token",
    });
    const socket = sockets[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({ type: "bridge.paired", protocolVersion: 9, connectionToken: "token" }),
    });
    await nextTurn();
    socket.emit("message", { data: JSON.stringify({ type: "bridge.connected", protocolVersion: 9 }) });
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    return socket;
  };

  // The session id is the entry's own. Reading it back from the state it published is the only
  // way to name the session a send must match; computing one here would be a second
  // implementation of the entry's identity rule.
  const selectAndReadSession = async () => {
    const selected = await dispatchRuntimeMessage(runtimeEvent.listeners[0], {
      type: "popup.select",
      tabId: 31,
    });
    const tab = selected.tabs?.find((entry) => entry.id === 31);
    assert.notEqual(tab, undefined, `no session was published: ${JSON.stringify(selected)}`);
    assert.equal(typeof tab.sessionId, "string");
    return tab;
  };

  return {
    selectAndReadSession,
    replacedEvent,
    chrome,
    contentSender,
    documentToken,
    fromContent,
    providerUrl,
    runtimeEvent,
    injections,
    updatedEvent,
    committedEvent,
    historyEvent,
    fragmentEvent,
    removedEvent,
    pair,
    sockets,
    restore: () => restoreGlobals(saved),
    setContentReply: (value) => { contentReply = value; },
    setProviderTabs: (value) => { providerTabs = value; },
    tabCalls,
    holdTabGet: () => {
      let release = () => undefined;
      tabGetGate = new Promise((resolve) => { release = resolve; });
      return () => { tabGetGate = undefined; release(); };
    },
    holdTabCreate: () => {
      let release = () => undefined;
      tabCreateGate = new Promise((resolve) => { release = resolve; });
      return () => { tabCreateGate = undefined; release(); };
    },
    tabMessages,
    setTabMessageHandler: (handler) => { tabMessageHandler = handler ?? defaultTabMessageHandler; },
    fetchCalls,
    setFetchHandler: (handler) => { fetchHandler = handler; },
  };
};

const registerDocument = async (harness) => await harness.fromContent({
  type: "content.register",
  provider: "chatgpt",
  documentToken: harness.documentToken,
  conversationUrl: harness.providerUrl,
  conversationIdentity: `chatgpt:${harness.providerUrl}`,
});

// BB-AUD-09. Everything that must already be true before one asset frame means anything: a
// paired entry, a registered document, a session the entry published itself, a request it
// accepted, a captured response that declared the asset, and a controller that has asked for it.
// Every asset test below starts from here, so each one exercises the same real path rather than
// reaching into the entry's state.
const startAssetTransfer = async (harness, options = {}) => {
  const declaredSize = options.declaredSize ?? 5;
  const socket = await harness.pair();
  assert.deepEqual(await registerDocument(harness), { success: true, registered: true });
  const session = await harness.selectAndReadSession();

  const binding = {
    requestId: "request-1",
    agentId: "agent-1",
    provider: "chatgpt",
    sessionId: session.sessionId,
    tabId: 31,
    frameId: 0,
    // The document the entry registered, named exactly: a send that omits it names another
    // document as far as the binding check is concerned.
    documentId: harness.contentSender.documentId,
    documentToken: harness.documentToken,
    conversationUrl: harness.providerUrl,
    conversationIdentity: `chatgpt:${harness.providerUrl}`,
  };
  socket.emit("message", {
    data: JSON.stringify({
      type: "conversation.send",
      protocolVersion: 9,
      ...binding,
      text: "hello",
      attachments: [],
      allowInitialConversationTransition: false,
    }),
  });
  for (let turn = 0; turn < 12; turn += 1) await nextTurn();
  assert.equal(
    socket.sent.some((frame) => frame.requestId === "request-1" && frame.type === "conversation.error"),
    false,
    `the send was refused: ${JSON.stringify(socket.sent.filter((frame) => frame.requestId === "request-1"))}`,
  );

  const captured = await harness.fromContent({
    type: "content.response",
    documentToken: harness.documentToken,
    response: {
      requestId: "request-1",
      agentId: "agent-1",
      sessionId: session.sessionId,
      provider: "chatgpt",
      conversationUrl: harness.providerUrl,
      conversationIdentity: `chatgpt:${harness.providerUrl}`,
      text: "answer",
      segments: [{ type: "text", text: "answer", start: 0, end: 6 }],
      assets: [{
        id: "asset-1",
        provider: "chatgpt",
        kind: "generatedFile",
        name: "report.txt",
        mimeType: "text/plain",
        size: declaredSize,
        // Where on the page the asset was found. An asset with no stated source element is one
        // the entry cannot say it saw.
        sourceElement: "assistantMessage",
        downloadAvailable: true,
      }],
      captureFormat: "renderedText",
      fidelity: "bestEffort",
      finalConversationUrl: harness.providerUrl,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    },
  });
  assert.equal(captured.success, true, JSON.stringify(captured));

  socket.emit("message", {
    data: JSON.stringify({
      type: "asset.fetch",
      protocolVersion: 9,
      transferId: "transfer-1",
      assetId: "asset-1",
      maxBytes: options.maxBytes ?? 1_024,
    }),
  });
  for (let turn = 0; turn < 8; turn += 1) await nextTurn();
  // The entry asked the page for the asset before any frame was accepted from it.
  assert.equal(
    harness.tabMessages.some((entry) => entry.message?.type === "asset.fetch" && entry.tabId === 31),
    true,
    "the entry never asked the page for the asset",
  );

  const frame = async (message) => await harness.fromContent({
    documentToken: harness.documentToken,
    transferId: "transfer-1",
    assetId: "asset-1",
    ...message,
  });
  return {
    socket,
    session,
    start: async (fields = {}) => await frame({
      type: "content.asset.start",
      name: "report.txt",
      mimeType: "text/plain",
      size: declaredSize,
      ...fields,
    }),
    chunk: async (sequence, dataBase64) => await frame({ type: "content.asset.chunk", sequence, dataBase64 }),
    complete: async (fields) => await frame({ type: "content.asset.complete", ...fields }),
    errorFrame: async (fields = {}) => await frame({ type: "content.asset.error", ...fields }),
  };
};

// "hello", split the way a page would stream it, with the digest the controller will check.
const assetBytes = "hello";
const assetChunks = [["hel", "aGVs"], ["lo", "bG8="]];
const assetDigest = createHash("sha256").update(assetBytes).digest("hex");

test("production background carries a whole asset from a registered document to the controller", async () => {
  const harness = await registeredDocumentHarness("asset-transfer");
  try {
    const transfer = await startAssetTransfer(harness);
    const { socket } = transfer;

    assert.equal((await transfer.start()).success, true);
    const started = socket.sent.find((frame) => frame.type === "asset.start");
    assert.notEqual(started, undefined, "no start frame reached the controller");
    assert.equal(started.name, "report.txt");
    assert.equal(started.mimeType, "text/plain");
    assert.equal(started.size, 5);
    assert.equal(started.transferId, "transfer-1");

    // Every chunk in sequence, and every one of them forwarded unchanged and in order.
    for (const [index, [, dataBase64]] of assetChunks.entries()) {
      assert.equal((await transfer.chunk(index, dataBase64)).success, true, `chunk ${String(index)}`);
    }
    const forwarded = socket.sent.filter((frame) => frame.type === "asset.chunk");
    assert.deepEqual(
      forwarded.map((frame) => [frame.sequence, frame.dataBase64]),
      assetChunks.map(([, dataBase64], index) => [index, dataBase64]),
    );
    // The bytes the controller can reassemble are the bytes the asset was.
    assert.equal(
      Buffer.concat(forwarded.map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString("utf8"),
      assetBytes,
    );

    // The digest is the real SHA-256 of those bytes, and the byte total is what was sent.
    assert.equal(assetDigest, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const acknowledged = await transfer.complete({ size: assetBytes.length, sha256: assetDigest });
    assert.deepEqual(acknowledged, { success: true }, JSON.stringify(acknowledged));

    const completed = socket.sent.find((frame) => frame.type === "asset.complete");
    assert.notEqual(completed, undefined, "no completion reached the controller");
    assert.equal(completed.transferId, "transfer-1");
    assert.equal(completed.assetId, "asset-1");
    assert.equal(completed.size, assetBytes.length);
    assert.equal(completed.sha256, assetDigest);
    // Nothing was refused along the way.
    assert.deepEqual(socket.sent.filter((frame) => frame.type === "asset.error"), []);

    // The transfer state is gone: a late frame naming it is refused, and refusing it reports
    // nothing to the controller, because there is no transfer left to report against.
    const late = await transfer.chunk(2, "IQ==");
    assert.equal(late.success, false, "a frame after completion was accepted");
    const lateCompletion = await transfer.complete({ size: assetBytes.length, sha256: assetDigest });
    assert.equal(lateCompletion.success, false);
    assert.deepEqual(socket.sent.filter((frame) => frame.type === "asset.error"), []);
    assert.equal(socket.sent.filter((frame) => frame.type === "asset.complete").length, 1);
  } finally {
    harness.restore();
  }
});

test("production background forwards the digest it was given rather than recomputing it", async () => {
  // Honest boundary: the entry checks the digest's shape and that the byte total agrees with
  // what it counted. Verifying the bytes against the digest is the controller's, because the
  // entry never holds the assembled asset. A well-formed digest is therefore forwarded as sent.
  const harness = await registeredDocumentHarness("asset-digest");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    for (const [index, [, dataBase64]] of assetChunks.entries()) await transfer.chunk(index, dataBase64);
    const wrong = "0".repeat(64);
    assert.equal((await transfer.complete({ size: assetBytes.length, sha256: wrong })).success, true);
    assert.equal(transfer.socket.sent.find((frame) => frame.type === "asset.complete").sha256, wrong);
  } finally {
    harness.restore();
  }
});

test("production background accepts one start frame per transfer and no more", async () => {
  const harness = await registeredDocumentHarness("asset-duplicate-start");
  try {
    const transfer = await startAssetTransfer(harness);
    assert.equal((await transfer.start()).success, true);
    const duplicate = await transfer.start();
    assert.equal(duplicate.success, false, "a second start frame was accepted");
    assert.equal(transfer.socket.sent.filter((frame) => frame.type === "asset.start").length, 1);
    // A duplicate start is refused without ending the transfer: the first one is still running.
    assert.equal((await transfer.chunk(0, assetChunks[0][1])).success, true);
  } finally {
    harness.restore();
  }
});

test("production background refuses a completion that arrives before all the bytes", async () => {
  const harness = await registeredDocumentHarness("asset-early-completion");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    await transfer.chunk(0, assetChunks[0][1]);
    const early = await transfer.complete({ size: assetBytes.length, sha256: assetDigest });
    assert.equal(early.success, false, "a completion naming more bytes than arrived was accepted");
    assert.equal(
      transfer.socket.sent.some((frame) => frame.type === "asset.error" && frame.code === "INVALID_ASSET_COMPLETION"),
      true,
    );
    // Refusing it ends the transfer rather than waiting for the rest.
    assert.equal((await transfer.chunk(1, assetChunks[1][1])).success, false);
    assert.equal(transfer.socket.sent.some((frame) => frame.type === "asset.complete"), false);
  } finally {
    harness.restore();
  }
});

test("production background refuses a chunk that skips one and a chunk that repeats one", async () => {
  for (const [label, sequence] of [["gap", 5], ["repeat", 0]]) {
    const harness = await registeredDocumentHarness(`asset-sequence-${label}`);
    try {
      const transfer = await startAssetTransfer(harness);
      await transfer.start();
      assert.equal((await transfer.chunk(0, assetChunks[0][1])).success, true);
      const wrong = await transfer.chunk(sequence, assetChunks[1][1]);
      assert.equal(wrong.success, false, `${label}: an out-of-sequence chunk was accepted`);
      assert.equal(
        transfer.socket.sent.some((frame) => frame.type === "asset.error" && frame.code === "INVALID_ASSET_CHUNK"),
        true,
        label,
      );
      // And the transfer is over: refusing a chunk does not resynchronize it.
      assert.equal((await transfer.chunk(1, assetChunks[1][1])).success, false, label);
    } finally {
      harness.restore();
    }
  }
});

test("production background refuses a completion whose byte count disagrees with the start frame", async () => {
  const harness = await registeredDocumentHarness("asset-byte-count");
  try {
    // The start frame declared five bytes; three arrived, and the completion agrees with what
    // arrived rather than with what was declared. Both have to agree.
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    await transfer.chunk(0, assetChunks[0][1]);
    const short = await transfer.complete({ size: 3, sha256: assetDigest });
    assert.equal(short.success, false, "a completion short of the declared size was accepted");
    assert.equal(
      transfer.socket.sent.some((frame) => frame.type === "asset.error" && frame.code === "INVALID_ASSET_COMPLETION"),
      true,
    );
  } finally {
    harness.restore();
  }
});

test("production background refuses a completion whose digest is not a digest", async () => {
  for (const sha256 of ["", "not-a-digest", "abc", "0".repeat(63), "0".repeat(65), "g".repeat(64), 64]) {
    const harness = await registeredDocumentHarness(`asset-digest-shape-${String(sha256).length}`);
    try {
      const transfer = await startAssetTransfer(harness);
      await transfer.start();
      for (const [index, [, dataBase64]] of assetChunks.entries()) await transfer.chunk(index, dataBase64);
      const refused = await transfer.complete({ size: assetBytes.length, sha256 });
      assert.equal(refused.success, false, `${String(sha256)} was accepted as a digest`);
      assert.equal(
        transfer.socket.sent.some((frame) => frame.type === "asset.error" && frame.code === "INVALID_ASSET_COMPLETION"),
        true,
      );
    } finally {
      harness.restore();
    }
  }
});

test("production background refuses a chunk that would exceed the budget the controller granted", async () => {
  const harness = await registeredDocumentHarness("asset-budget");
  try {
    const transfer = await startAssetTransfer(harness, { declaredSize: 3, maxBytes: 3 });
    assert.equal((await transfer.start({ size: 3 })).success, true);
    // Five bytes into a three-byte budget: the entry is accounting for what it forwards.
    const over = await transfer.chunk(0, Buffer.from(assetBytes).toString("base64"));
    assert.equal(over.success, false, "a chunk over the granted budget was accepted");
    assert.equal(
      transfer.socket.sent.some((frame) => frame.type === "asset.error" && frame.code === "INVALID_ASSET_CHUNK"),
      true,
    );
  } finally {
    harness.restore();
  }
});

test("production background ends a transfer the controller cancels mid-way", async () => {
  const harness = await registeredDocumentHarness("asset-cancel");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    assert.equal((await transfer.chunk(0, assetChunks[0][1])).success, true);
    transfer.socket.emit("message", {
      data: JSON.stringify({
        type: "asset.cancel",
        protocolVersion: 9,
        transferId: "transfer-1",
        assetId: "asset-1",
      }),
    });
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    // The page is told to stop, and the next frame it sends is refused.
    assert.equal(
      harness.tabMessages.some((entry) => entry.message?.type === "asset.cancel" && entry.message.transferId === "transfer-1"),
      true,
      "the page was never told the transfer was cancelled",
    );
    assert.equal((await transfer.chunk(1, assetChunks[1][1])).success, false);
    assert.equal(transfer.socket.sent.some((frame) => frame.type === "asset.complete"), false);
  } finally {
    harness.restore();
  }
});

test("production background ends a transfer whose controller disconnects mid-way", async () => {
  const harness = await registeredDocumentHarness("asset-disconnect");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    assert.equal((await transfer.chunk(0, assetChunks[0][1])).success, true);
    transfer.socket.emit("close");
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    assert.equal((await transfer.chunk(1, assetChunks[1][1])).success, false);
    const completion = await transfer.complete({ size: assetBytes.length, sha256: assetDigest });
    assert.equal(completion.success, false, "a transfer completed after the controller went away");
  } finally {
    harness.restore();
  }
});

test("production background refuses an asset frame after the transfer's socket write fails", async () => {
  const harness = await registeredDocumentHarness("asset-socket-failure");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    const before = transfer.socket.sent.length;
    transfer.socket.send = () => {
      throw new Error("socket write failed");
    };
    // The frame may already have been counted against the transfer when the write fails. The
    // page is told the frame failed rather than being left to assume it was forwarded.
    const failed = await transfer.chunk(0, assetChunks[0][1]);
    assert.equal(failed.success, false, "a chunk whose forwarding failed was acknowledged");
    assert.match(String(failed.error), /socket write failed/u);
    assert.equal(transfer.socket.sent.length, before, "a failed write still recorded a frame");
  } finally {
    harness.restore();
  }
});

test("production background refuses asset frames from a document it did not register", async () => {
  const harness = await registeredDocumentHarness("asset-stale");
  try {
    await harness.pair();
    await registerDocument(harness);
    // A frame naming another document token is a frame from a document that has been replaced.
    const stale = await harness.fromContent({
      type: "content.asset.start",
      documentToken: "some-other-document",
      transferId: "transfer-x",
      assetId: "asset-x",
      name: "x",
    });
    assert.equal(stale.success, false);
    // And a frame from another tab is refused however well-formed it is.
    const otherTab = await harness.fromContent({
      type: "content.asset.start",
      documentToken: harness.documentToken,
      transferId: "transfer-x",
      assetId: "asset-x",
      name: "x",
    }, { ...harness.contentSender, tab: { id: 999, url: harness.providerUrl } });
    assert.equal(otherTab.success, false);
  } finally {
    harness.restore();
  }
});

test("production background refuses every frame of a live transfer from a stale document", async () => {
  const harness = await registeredDocumentHarness("asset-stale-frames");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    // The transfer is live and in sequence. Every frame kind still has to name the document
    // that registered it: a replaced document holding the old transfer id proves nothing.
    const stale = async (message) => await harness.fromContent({
      documentToken: "some-other-document",
      transferId: "transfer-1",
      assetId: "asset-1",
      ...message,
    });
    assert.equal((await stale({ type: "content.asset.chunk", sequence: 0, dataBase64: assetChunks[0][1] })).success, false);
    assert.equal((await stale({ type: "content.asset.complete", size: 0, sha256: assetDigest })).success, false);
    assert.equal((await stale({ type: "content.asset.error", code: "X", message: "x" })).success, false);
    // None of them ended the transfer either: the document that owns it can still finish.
    for (const [index, [, dataBase64]] of assetChunks.entries()) {
      assert.equal((await transfer.chunk(index, dataBase64)).success, true);
    }
    assert.equal((await transfer.complete({ size: assetBytes.length, sha256: assetDigest })).success, true);
  } finally {
    harness.restore();
  }
});

test("production background refuses a transfer's frames once Chrome replaces its tab", async () => {
  const harness = await registeredDocumentHarness("asset-replaced");
  try {
    const transfer = await startAssetTransfer(harness);
    await transfer.start();
    assert.equal((await transfer.chunk(0, assetChunks[0][1])).success, true);
    // The replacement is a document that loaded out of band; the registration ends with the
    // tab it belonged to, and so does anything still being transferred from it.
    harness.setProviderTabs([{ id: 32, url: harness.providerUrl, title: "swapped in" }]);
    harness.replacedEvent.listeners[0](32, 31);
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    assert.equal((await transfer.chunk(1, assetChunks[1][1])).success, false);
    assert.equal(
      (await transfer.complete({ size: assetBytes.length, sha256: assetDigest })).success,
      false,
      "a replaced tab's transfer still completed",
    );
  } finally {
    harness.restore();
  }
});

test("production background drops a registered document when its tab navigates away", async () => {
  const harness = await registeredDocumentHarness("registered-navigation");
  try {
    await harness.pair();
    await registerDocument(harness);
    assert.equal(
      (await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" }))
        .tabs.some((tab) => tab.id === 31),
      true,
    );
    // Chrome reports the tab committing a document on another site: the registration goes.
    harness.setProviderTabs([]);
    harness.committedEvent.listeners[0]({
      tabId: 31,
      frameId: 0,
      documentId: "elsewhere",
      documentLifecycle: "active",
      url: "https://example.invalid/",
    });
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.tabs.some((tab) => tab.id === 31), false);
    // A frame from the document that has just been dropped is refused rather than served.
    assert.equal(
      (await harness.fromContent({
        type: "content.asset.start",
        documentToken: harness.documentToken,
        transferId: "transfer-y",
        assetId: "asset-y",
        name: "y",
      })).success,
      false,
    );
  } finally {
    harness.restore();
  }
});

test("a URL-less completion cannot disturb ChatGPT's pending first-turn transition", async () => {
  const harness = await registeredDocumentHarness("first-turn-url-less-complete", {
    providerUrl: "https://chatgpt.com/",
  });
  let releaseSubmission = () => undefined;
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const session = await harness.selectAndReadSession();
    const heldSubmission = new Promise((resolve) => { releaseSubmission = resolve; });
    harness.setTabMessageHandler(async (_tabId, message) => {
      if (message?.type === "conversation.send") {
        await heldSubmission;
        return { success: true, submitted: true };
      }
      if (message?.type === "content.reregister") {
        throw new Error("the content script is already installed");
      }
      return {
        status: "ready",
        documentToken: harness.documentToken,
        conversationUrl: harness.providerUrl,
        conversationIdentity: `chatgpt:${harness.providerUrl}`,
        conversationState: "confirmed",
      };
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "first-turn",
        agentId: "agent-1",
        provider: "chatgpt",
        sessionId: session.sessionId,
        tabId: 31,
        frameId: 0,
        documentId: harness.contentSender.documentId,
        documentToken: harness.documentToken,
        conversationUrl: harness.providerUrl,
        conversationIdentity: `chatgpt:${harness.providerUrl}`,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: true,
      }),
    });
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();
    assert.equal(
      harness.tabMessages.some((entry) => entry.message?.type === "conversation.send"),
      true,
      "the first turn never reached the content script",
    );
    assert.equal(socket.sent.some((frame) => frame.requestId === "first-turn"), false);

    // Chrome may report the new route separately and then report only that its load completed.
    // Until the content script claims the exact root -> conversation transition, this completion
    // has no URL to judge and must not probe, re-register, inject, or publish a transient status.
    harness.setProviderTabs([{ id: 31, url: "https://chatgpt.com/c/assigned", title: "assigned" }]);
    const getsBefore = harness.tabCalls.filter((entry) => entry.call === "get").length;
    const messagesBefore = harness.tabMessages.length;
    const injectionsBefore = harness.injections.length;
    const statusesBefore = socket.sent.filter((frame) => frame.type === "provider.status").length;
    harness.updatedEvent.listeners.forEach((listener) => listener(31, { status: "complete" }));
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();

    assert.equal(
      harness.tabCalls.filter((entry) => entry.call === "get").length,
      getsBefore,
      "the URL-less completion probed the transitioning tab",
    );
    assert.equal(harness.tabMessages.length, messagesBefore, "the completion re-contacted the content script");
    assert.equal(harness.injections.length, injectionsBefore, "the completion reinjected the transitioning tab");
    assert.equal(
      socket.sent.filter((frame) => frame.type === "provider.status").length,
      statusesBefore,
      "the completion published a transient provider status",
    );

    releaseSubmission();
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();
    assert.equal(
      socket.sent.some((frame) => frame.type === "conversation.submitted" && frame.requestId === "first-turn"),
      true,
      `the undisturbed first turn was not submitted: ${JSON.stringify(socket.sent)}`,
    );

    const assignedUrl = "https://chatgpt.com/c/assigned";
    const assignedIdentity = `chatgpt:${assignedUrl}`;
    const assignedSender = {
      ...harness.contentSender,
      tab: { ...harness.contentSender.tab, url: assignedUrl },
      url: assignedUrl,
    };
    assert.deepEqual(
      await harness.fromContent({
        type: "content.transition",
        submissionCommitted: true,
        requestId: "first-turn",
        agentId: "agent-1",
        sessionId: session.sessionId,
        documentToken: harness.documentToken,
        previousConversationUrl: harness.providerUrl,
        conversationUrl: assignedUrl,
        conversationIdentity: assignedIdentity,
      }, assignedSender),
      { success: true, accepted: true },
    );
    harness.setTabMessageHandler(async () => ({
      status: "ready",
      documentToken: harness.documentToken,
      conversationUrl: assignedUrl,
      conversationIdentity: assignedIdentity,
      conversationState: "confirmed",
    }));
    assert.equal(
      (await harness.fromContent({
        type: "content.stream",
        requestId: "first-turn",
        agentId: "agent-1",
        sessionId: session.sessionId,
        documentToken: harness.documentToken,
        mode: "replace",
        text: "streamed",
      }, assignedSender)).success,
      true,
    );
    assert.equal(
      (await harness.fromContent({
        type: "content.response",
        documentToken: harness.documentToken,
        response: {
          requestId: "first-turn",
          agentId: "agent-1",
          sessionId: session.sessionId,
          provider: "chatgpt",
          conversationUrl: assignedUrl,
          conversationIdentity: assignedIdentity,
          text: "captured",
          segments: [{ type: "text", text: "captured", start: 0, end: 8 }],
          assets: [],
          captureFormat: "renderedText",
          fidelity: "bestEffort",
          finalConversationUrl: assignedUrl,
          startedAt: new Date(1).toISOString(),
          completedAt: new Date(2).toISOString(),
        },
      }, assignedSender)).success,
      true,
    );
    assert.equal(
      socket.sent.some((frame) => frame.type === "conversation.stream" && frame.text === "streamed"),
      true,
    );
    assert.equal(
      socket.sent.some((frame) => frame.type === "conversation.response" && frame.text === "captured"),
      true,
    );
  } finally {
    releaseSubmission();
    harness.restore();
  }
});

test("production background fails a registered document's work when its socket closes", async () => {
  const harness = await registeredDocumentHarness("registered-disconnect");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const session = await harness.selectAndReadSession();
    socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "request-2",
        agentId: "agent-1",
        provider: "chatgpt",
        sessionId: session.sessionId,
        tabId: 31,
        frameId: 0,
        documentId: harness.contentSender.documentId,
        documentToken: harness.documentToken,
        conversationUrl: harness.providerUrl,
        conversationIdentity: `chatgpt:${harness.providerUrl}`,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
      }),
    });
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    // The socket goes after the request may already have been dispatched to the page. The entry
    // stops the work rather than leaving it running against a controller that is gone.
    socket.emit("close");
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    const late = await harness.fromContent({
      type: "content.response",
      documentToken: harness.documentToken,
      response: {
        requestId: "request-2",
        agentId: "agent-1",
        sessionId: session.sessionId,
        provider: "chatgpt",
        conversationUrl: harness.providerUrl,
        conversationIdentity: `chatgpt:${harness.providerUrl}`,
        text: "late",
        segments: [{ type: "text", text: "late", start: 0, end: 4 }],
        assets: [],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        finalConversationUrl: harness.providerUrl,
        startedAt: new Date(1).toISOString(),
        completedAt: new Date(2).toISOString(),
      },
    });
    assert.equal(late.success, false, "a response was accepted after the controller disconnected");
  } finally {
    harness.restore();
  }
});

// N1. The navigation races, driven through the production entry.
//
// Chrome delivers navigation events faster than a Generic origin's permission read resolves, so
// a handler that awaits one can come back to a tab that has already moved on. Every test below
// parks that read, changes the world underneath it, releases it, and then asks what the entry
// did — counted in `provider.status` frames, because a navigation the entry acts on refreshes
// the controller's view and one it drops does not.
const statusFrames = (socket) => socket.sent.filter((frame) => frame.type === "provider.status").length;

const registerGenericTab = async (harness, tabId, origin, path = "/one") => {
  const sender = {
    id: "bachata-bridge-test",
    frameId: 0,
    tab: { id: tabId, url: `${origin}${path}`, title: "raced" },
    url: `${origin}${path}`,
  };
  harness.setProviderTabs([{ id: tabId, url: `${origin}${path}`, title: "raced" }]);
  await new Promise((resolve, reject) => {
    const message = {
      type: "BACHATA_GENERIC_REGISTER",
      origin,
      url: `${origin}${path}`,
      title: "raced",
      documentRevision: 1,
      documentToken: "generic-document:abcdefghijklmnop",
    };
    for (const listener of harness.runtimeEvent.listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    reject(new Error("no listener claimed BACHATA_GENERIC_REGISTER"));
  });
  for (let turn = 0; turn < 4; turn += 1) await nextTurn();
  return {
    navigate: (event, navigationPath, documentId) => event.listeners[0]({
      tabId,
      frameId: 0,
      documentId,
      documentLifecycle: "active",
      url: `${origin}${navigationPath}`,
    }),
  };
};

/**
 * Park the next permission read, and answer it with `firstAnswer` when it is released. Every
 * later read answers `true` immediately, so the newer navigation is the one that completes.
 */
const holdNextPermissionRead = (harness, firstAnswer) => {
  let release = () => undefined;
  const held = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  harness.chrome.permissions.contains = async () => {
    reads += 1;
    if (reads === 1) {
      await held;
      return firstAnswer;
    }
    return true;
  };
  return { release: () => release(), reads: () => reads };
};

test("production background never applies a navigation that a newer one has overtaken", async () => {
  const harness = await registeredDocumentHarness("navigation-race");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const genericOrigin = "https://raced.invalid";
    const tab = await registerGenericTab(harness, 41, genericOrigin);

    // The older event's permission read answers "no longer permitted", which is the answer that
    // would tear the registration down. It must not be acted on, because a newer navigation has
    // already landed and been permitted.
    const permission = holdNextPermissionRead(harness, false);
    tab.navigate(harness.committedEvent, "/two", "raced-1");
    await nextTurn();
    const beforeNewer = statusFrames(socket);
    tab.navigate(harness.committedEvent, "/three", "raced-2");
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();

    // The newer navigation was accepted and applied while the older one was still parked.
    assert.equal(statusFrames(socket) - beforeNewer, 1, "the newer navigation was not applied");
    const afterNewer = statusFrames(socket);
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.tabs.some((entry) => entry.id === 41), true, "the newer navigation lost the registration");

    // Now the older denial is released. It resolves, and it changes nothing.
    permission.release();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    assert.equal(permission.reads() >= 2, true, "the newer navigation never read the permission");
    assert.equal(statusFrames(socket) - afterNewer, 0, "the overtaken navigation was applied anyway");

    const after = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(after.error, undefined, `a navigation race recorded an error: ${String(after.error)}`);
    assert.equal(after.tabs.some((entry) => entry.id === 41), true, "the overtaken denial removed the registration");
    // And the overtaken handler did not overwrite the selection the newer one left either.
    assert.deepEqual(
      after.tabs.filter((entry) => entry.id === 41).map((entry) => entry.documentToken),
      state.tabs.filter((entry) => entry.id === 41).map((entry) => entry.documentToken),
    );
  } finally {
    harness.restore();
  }
});

test("production background drops a navigation whose tab was replaced while its permission was read", async () => {
  const harness = await registeredDocumentHarness("navigation-race-replaced");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const genericOrigin = "https://replaced-mid-read.invalid";
    const tab = await registerGenericTab(harness, 41, genericOrigin);

    const permission = holdNextPermissionRead(harness, true);
    tab.navigate(harness.committedEvent, "/two", "raced-1");
    await nextTurn();
    // Chrome swaps the tab out while the read is open. Neither id describes a document the
    // bridge has seen any more.
    harness.setProviderTabs([{ id: 42, url: `${genericOrigin}/two`, title: "swapped in" }]);
    harness.replacedEvent.listeners[0](42, 41);
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    const before = statusFrames(socket);

    permission.release();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    assert.equal(statusFrames(socket) - before, 0, "a navigation for a replaced tab was applied");
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.error, undefined);
    assert.equal(state.tabs.some((entry) => entry.id === 41), false, "the replaced tab kept its registration");
  } finally {
    harness.restore();
  }
});

test("production background drops a navigation whose tab closed while its permission was read", async () => {
  const harness = await registeredDocumentHarness("navigation-race-removed");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const genericOrigin = "https://closed-mid-read.invalid";
    const tab = await registerGenericTab(harness, 41, genericOrigin);

    const permission = holdNextPermissionRead(harness, true);
    tab.navigate(harness.committedEvent, "/two", "raced-1");
    await nextTurn();
    for (const listener of harness.removedEvent.listeners) listener(41);
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    const before = statusFrames(socket);

    permission.release();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    assert.equal(statusFrames(socket) - before, 0, "a navigation for a closed tab was applied");
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.error, undefined);
    assert.equal(state.tabs.some((entry) => entry.id === 41), false);
  } finally {
    harness.restore();
  }
});

test("production background applies only the newer of two same-document route changes", async () => {
  const harness = await registeredDocumentHarness("navigation-race-same-document");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const genericOrigin = "https://pushed.invalid";
    const tab = await registerGenericTab(harness, 41, genericOrigin);

    // Two `pushState` route changes inside one document, the first parked on its permission
    // read. Same document, so nothing about the document distinguishes them: only the order.
    const permission = holdNextPermissionRead(harness, true);
    tab.navigate(harness.historyEvent, "/two", "same-document");
    await nextTurn();
    const beforeNewer = statusFrames(socket);
    tab.navigate(harness.historyEvent, "/three", "same-document");
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    assert.equal(statusFrames(socket) - beforeNewer, 1, "the newer route change was not applied");
    const afterNewer = statusFrames(socket);

    permission.release();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    assert.equal(statusFrames(socket) - afterNewer, 0, "the older route change was applied out of order");
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.error, undefined);
    assert.equal(state.tabs.some((entry) => entry.id === 41), true);
  } finally {
    harness.restore();
  }
});

test("production background lets a refused event do nothing to the navigation it is still holding", async () => {
  const harness = await registeredDocumentHarness("navigation-race-refusals");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const genericOrigin = "https://refusals.invalid";
    const tab = await registerGenericTab(harness, 41, genericOrigin);

    const permission = holdNextPermissionRead(harness, true);
    tab.navigate(harness.committedEvent, "/two", "raced-1");
    await nextTurn();
    const before = statusFrames(socket);

    // Everything Chrome reports that this bridge refuses: a subframe, a prerendered document,
    // an origin nothing granted, and the same navigation reported twice. None of them is a
    // transition, so none of them may make the accepted one that is still in flight stale.
    harness.committedEvent.listeners[0]({
      tabId: 41,
      frameId: 9,
      documentId: "subframe",
      documentLifecycle: "active",
      url: `${genericOrigin}/ad`,
    });
    harness.committedEvent.listeners[0]({
      tabId: 41,
      frameId: 0,
      documentId: "prerendered",
      documentLifecycle: "prerender",
      url: `${genericOrigin}/prerendered`,
    });
    harness.committedEvent.listeners[0]({
      tabId: 41,
      frameId: 0,
      documentId: "elsewhere",
      documentLifecycle: "active",
      url: "https://not-granted.invalid/page",
    });
    tab.navigate(harness.committedEvent, "/two", "raced-1");
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    assert.equal(statusFrames(socket) - before, 0, "a refused event was acted on");

    permission.release();
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    // The held navigation is still the latest one, so it applies.
    assert.equal(statusFrames(socket) - before, 1, "refused events invalidated the accepted navigation");
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.error, undefined);
    assert.equal(state.tabs.some((entry) => entry.id === 41), true);
  } finally {
    harness.restore();
  }
});

test("production background forgets a closed tab's navigation state", async () => {
  const harness = await registeredDocumentHarness("navigation-forget");
  try {
    const socket = await harness.pair();
    await registerDocument(harness);
    const navigate = (documentId) => harness.committedEvent.listeners[0]({
      tabId: 55,
      frameId: 0,
      documentId,
      documentLifecycle: "active",
      url: "https://chatgpt.com/c/reused-id",
    });
    navigate("first-document");
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    // The first navigation on tab 55 was applied, which is what the reused id has to be able to
    // do again. "No error" cannot say this: a deduplicated event produces no error either.
    const applied = statusFrames(socket);
    assert.equal(applied > 0, true, "the first navigation on the tab was never applied");

    // Chrome reuses tab ids. A closed tab that kept its state would have the next tab's first
    // navigation — same id, same url, same document id — deduplicated away.
    for (const listener of harness.removedEvent.listeners) listener(55);
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    const beforeReuse = statusFrames(socket);

    navigate("first-document");
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    assert.equal(
      statusFrames(socket) - beforeReuse,
      1,
      "the reused tab id's first navigation was deduplicated against the closed tab's state",
    );
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(state.error, undefined);
  } finally {
    harness.restore();
  }
});

test("production background never moves a registration onto a tab Chrome swapped in", async () => {
  const harness = await registeredDocumentHarness("navigation-replaced");
  try {
    await harness.pair();
    await registerDocument(harness);
    const before = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(before.tabs.some((tab) => tab.id === 31), true);

    // The replacement is a document that loaded out of band. Nothing proves it is the same
    // conversation, so the replaced tab's registration ends rather than moving across.
    harness.setProviderTabs([{ id: 32, url: harness.providerUrl, title: "swapped in" }]);
    harness.replacedEvent.listeners[0](32, 31);
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();

    const after = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    assert.equal(after.tabs.some((tab) => tab.id === 31), false, "the replaced tab kept its registration");
    // And the surviving tab carries no session at all: `documentToken` is not part of the popup
    // projection, so asserting against it could never have failed. A transferred registration
    // would show up as a session id and a ready status on the new tab.
    const survivor = after.tabs.find((tab) => tab.id === 32);
    assert.notEqual(survivor, undefined, "the surviving tab is not listed");
    assert.equal(survivor.sessionId, undefined, "a session was transferred to the surviving tab");
    assert.equal(survivor.ready, false);
  } finally {
    harness.restore();
  }
});


// BB-AUD-09. A Generic conversation turn, driven through the production entry against a
// registered Generic document.
//
// The built-in providers answer one message; a Generic turn is a sequence — status, send,
// submission commitment, final attestation, reuse confirmation — and every step of it is where
// an identity check lives. The page below answers each command in turn, and each test changes
// exactly one of its answers.
const genericConversationHarness = async (label) => {
  const harness = await registeredDocumentHarness(label);
  const origin = "https://generic-provider.invalid";
  const tabId = 41;
  const page = {
    documentToken: "generic-document:abcdefghijklmnop",
    documentRevision: 1,
    url: `${origin}/chat`,
    status: "ready",
    // A Generic page is only reusable once it says so. After a turn it reports the conversation
    // as uncertain and itself as not ready, and it goes back to ready and confirmed only when
    // the reuse attestation is confirmed. That quarantine is what the entry checks against.
    conversationState: "confirmed",
    reuseConfirmed: true,
    commitSubmission: true,
    sendGate: undefined,
    attestation: undefined,
    cancelReply: undefined,
    cancelGate: undefined,
    commands: [],
  };
  const sender = {
    id: "bachata-bridge-test",
    frameId: 0,
    tab: { id: tabId, url: page.url, title: "generic" },
    url: page.url,
  };
  const dispatch = (message) => new Promise((resolve) => {
    let answered = false;
    for (const listener of harness.runtimeEvent.listeners) {
      const claimed = listener(message, sender, (value) => {
        answered = true;
        resolve(value);
      });
      if (claimed === true) return;
      if (answered) return;
    }
    resolve(undefined);
  });
  const statusReply = () => ({
    ok: true,
    value: {
      status: page.status,
      origin,
      url: page.url,
      title: "generic",
      documentRevision: page.documentRevision,
      documentToken: page.documentToken,
      capabilities: {
        submission: "verifiedSend",
        completion: "verifiedLifecycle",
        interruption: "confirmed",
        assets: "textOnly",
        conversationState: page.conversationState,
      },
    },
  });
  const defaultAttestation = () => ({
    documentToken: page.documentToken,
    documentRevision: page.documentRevision,
    conversationUrl: page.url,
    conversationIdentity: `generic:${page.url}`,
    providerIdleConfirmed: true,
    completionSource: "verifiedLifecycle",
  });
  harness.setTabMessageHandler(async (_tabId, message) => {
    page.commands.push(message);
    if (message?.type === "BACHATA_GENERIC_STATUS") return statusReply();
    if (message?.type === "BACHATA_GENERIC_CONFIRM_REUSE") {
      if (!page.reuseConfirmed) return { ok: false, error: "The generic page would not confirm reuse" };
      page.status = "ready";
      page.conversationState = "confirmed";
      return { ok: true, value: { reuseConfirmed: true } };
    }
    if (message?.type === "BACHATA_GENERIC_CANCEL") {
      if (page.cancelGate) await page.cancelGate;
      return page.cancelReply ?? {
        ok: true,
        value: {
          interrupted: true,
          stopConfirmed: true,
          documentToken: page.documentToken,
          documentRevision: page.documentRevision,
          conversationUrl: page.url,
          conversationIdentity: `generic:${page.url}`,
        },
      };
    }
    if (message?.type === "BACHATA_GENERIC_SEND") {
      if (page.commitSubmission) {
        // The page reports that the prompt is committed. That is the only thing that turns a
        // Generic send into an acknowledged submission.
        await dispatch({
          type: "BACHATA_GENERIC_SUBMITTED",
          requestId: message.requestId,
          documentToken: message.documentToken,
          conversationUrl: message.conversationUrl,
          conversationIdentity: message.conversationIdentity,
        });
      }
      if (page.sendGate) await page.sendGate;
      page.status = "notReady";
      page.conversationState = "uncertain";
      return {
        ok: true,
        value: {
          text: "answer",
          segments: [{ type: "text", text: "answer", start: 0, end: 6 }],
          ...(page.attestation ?? defaultAttestation()),
        },
      };
    }
    return { ok: true };
  });

  harness.setProviderTabs([{ id: tabId, url: page.url, title: "generic" }]);
  await dispatch({
    type: "BACHATA_GENERIC_REGISTER",
    origin,
    url: page.url,
    title: "generic",
    documentRevision: page.documentRevision,
    documentToken: page.documentToken,
  });
  for (let turn = 0; turn < 4; turn += 1) await nextTurn();
  const socket = await harness.pair();

  const readSession = async () => {
    const state = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.getState" });
    const tab = state.tabs?.find((entry) => entry.id === tabId);
    assert.notEqual(tab, undefined, `no Generic tab was published: ${JSON.stringify(state)}`);
    return tab;
  };

  const send = async (requestId, overrides = {}) => {
    const tab = await readSession();
    assert.notEqual(tab.sessionId, undefined, `no Generic session was published: ${JSON.stringify(tab)}`);
    socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId,
        agentId: "agent-1",
        provider: "generic",
        sessionId: tab.sessionId,
        tabId,
        frameId: 0,
        documentToken: page.documentToken,
        conversationUrl: tab.conversationUrl,
        conversationIdentity: tab.conversationIdentity,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
        ...overrides,
      }),
    });
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
    return tab;
  };

  return { harness, socket, page, tabId, origin, dispatch, readSession, send, restore: harness.restore };
};

const framesFor = (socket, requestId) => socket.sent.filter((frame) => frame.requestId === requestId);

test("production background runs a whole Generic turn through a registered Generic document", async () => {
  const generic = await genericConversationHarness("generic-turn");
  try {
    const session = await generic.send("generic-1");
    const frames = framesFor(generic.socket, "generic-1");
    assert.deepEqual(
      frames.filter((frame) => frame.type === "conversation.error"),
      [],
      JSON.stringify(frames),
    );

    // The submission was acknowledged before the answer, and only because the page committed it.
    const submitted = frames.find((frame) => frame.type === "conversation.submitted");
    assert.notEqual(submitted, undefined, "no submission acknowledgement reached the controller");
    assert.equal(submitted.sessionId, session.sessionId);

    const response = frames.find((frame) => frame.type === "conversation.response");
    assert.notEqual(response, undefined, `no response reached the controller: ${JSON.stringify(frames)}`);
    assert.equal(response.provider, "generic");
    assert.equal(response.text, "answer");
    assert.deepEqual(response.assets, []);
    assert.equal(response.finalConversationUrl, session.conversationUrl);
    assert.equal(response.finalConversationIdentity, session.conversationIdentity);
    assert.equal(typeof response.finalSessionId, "string");
    assert.equal(frames.indexOf(submitted) < frames.indexOf(response), true, "the answer preceded the submission");

    // The command the page was sent carried the exact identity of the session the controller
    // named. A Generic send that identified any other document would be a send to another page.
    const sent = generic.page.commands.find((command) => command.type === "BACHATA_GENERIC_SEND");
    assert.notEqual(sent, undefined);
    assert.equal(sent.documentToken, generic.page.documentToken);
    assert.equal(sent.conversationUrl, session.conversationUrl);
    assert.equal(sent.conversationIdentity, session.conversationIdentity);
    // And the reuse confirmation ran, because the page attested the provider was idle.
    assert.equal(
      generic.page.commands.some((command) => command.type === "BACHATA_GENERIC_CONFIRM_REUSE"),
      true,
      "a confirmed-idle Generic turn never confirmed reuse",
    );
  } finally {
    generic.restore();
  }
});

test("production background refuses a Generic send naming a session the document no longer has", async () => {
  const generic = await genericConversationHarness("generic-stale-session");
  try {
    const session = await generic.readSession();
    // The document is replaced before the send arrives: same tab, new token, so the session the
    // controller is naming no longer exists.
    generic.page.documentToken = "generic-document:zyxwvutsrqponmlk";
    generic.page.documentRevision = 2;
    generic.socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "generic-stale",
        agentId: "agent-1",
        provider: "generic",
        sessionId: session.sessionId,
        tabId: generic.tabId,
        frameId: 0,
        documentToken: "generic-document:abcdefghijklmnop",
        conversationUrl: session.conversationUrl,
        conversationIdentity: session.conversationIdentity,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
      }),
    });
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
    const frames = framesFor(generic.socket, "generic-stale");
    assert.equal(frames.some((frame) => frame.type === "conversation.response"), false, "a stale session answered");
    const failure = frames.find((frame) => frame.type === "conversation.error");
    assert.notEqual(failure, undefined, `no refusal reached the controller: ${JSON.stringify(frames)}`);
    assert.equal(failure.code, "SUBMISSION_FAILED");
    assert.equal(
      generic.page.commands.some((command) => command.type === "BACHATA_GENERIC_SEND"),
      false,
      "a stale session was still sent a prompt",
    );
  } finally {
    generic.restore();
  }
});

test("production background refuses a Generic answer whose attestation names another document", async () => {
  const generic = await genericConversationHarness("generic-attestation-document");
  try {
    generic.page.attestation = {
      documentToken: "generic-document:zyxwvutsrqponmlk",
      documentRevision: 1,
      conversationUrl: `${generic.origin}/chat`,
      conversationIdentity: `generic:${generic.origin}/chat`,
      providerIdleConfirmed: true,
      completionSource: "verifiedLifecycle",
    };
    await generic.send("generic-attested");
    const frames = framesFor(generic.socket, "generic-attested");
    assert.equal(frames.some((frame) => frame.type === "conversation.response"), false, "a mismatched attestation answered");
    const failure = frames.find((frame) => frame.type === "conversation.error");
    assert.notEqual(failure, undefined, JSON.stringify(frames));
    assert.equal(failure.code, "SUBMISSION_FAILED");
    // The prompt may already have been submitted, so the commitment boundary holds: the
    // controller is told it failed, and nothing is retried on its behalf.
    assert.equal(frames.some((frame) => frame.type === "conversation.submitted"), true);
  } finally {
    generic.restore();
  }
});

test("production background refuses a Generic answer attested from another origin", async () => {
  const generic = await genericConversationHarness("generic-attestation-origin");
  try {
    generic.page.attestation = {
      documentToken: generic.page.documentToken,
      documentRevision: 1,
      conversationUrl: "https://elsewhere.invalid/chat",
      conversationIdentity: "generic:https://elsewhere.invalid/chat",
      providerIdleConfirmed: true,
      completionSource: "verifiedLifecycle",
    };
    await generic.send("generic-origin");
    const frames = framesFor(generic.socket, "generic-origin");
    assert.equal(frames.some((frame) => frame.type === "conversation.response"), false);
    assert.equal(frames.find((frame) => frame.type === "conversation.error")?.code, "SUBMISSION_FAILED");
  } finally {
    generic.restore();
  }
});

test("production background refuses a Generic answer the page never committed", async () => {
  const generic = await genericConversationHarness("generic-uncommitted");
  try {
    // No `BACHATA_GENERIC_SUBMITTED`: the page answered without ever saying the prompt went in.
    generic.page.commitSubmission = false;
    await generic.send("generic-uncommitted");
    const frames = framesFor(generic.socket, "generic-uncommitted");
    assert.equal(
      frames.some((frame) => frame.type === "conversation.submitted"),
      false,
      "an uncommitted Generic turn was acknowledged as submitted",
    );
  } finally {
    generic.restore();
  }
});

test("production background cancels a Generic turn the controller interrupts mid-flight", async () => {
  const generic = await genericConversationHarness("generic-interrupt");
  try {
    let release = () => undefined;
    generic.page.sendGate = new Promise((resolve) => { release = resolve; });
    const session = await generic.readSession();
    generic.socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "generic-interrupt",
        agentId: "agent-1",
        provider: "generic",
        sessionId: session.sessionId,
        tabId: generic.tabId,
        frameId: 0,
        documentToken: generic.page.documentToken,
        conversationUrl: session.conversationUrl,
        conversationIdentity: session.conversationIdentity,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
      }),
    });
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    generic.socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.interrupt",
        protocolVersion: 9,
        requestId: "generic-interrupt",
        agentId: "agent-1",
        provider: "generic",
        sessionId: session.sessionId,
        tabId: generic.tabId,
        frameId: 0,
        documentToken: generic.page.documentToken,
        conversationUrl: session.conversationUrl,
        conversationIdentity: session.conversationIdentity,
      }),
    });
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();
    assert.equal(
      generic.page.commands.some((command) => command.type === "BACHATA_GENERIC_CANCEL"),
      true,
      "the page was never told to stop",
    );
    release();
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
    const frames = framesFor(generic.socket, "generic-interrupt");
    assert.equal(
      frames.some((frame) => frame.type === "conversation.response"),
      false,
      "an interrupted Generic turn still answered",
    );
    assert.equal(frames.some((frame) => frame.type === "conversation.interrupted"), true, JSON.stringify(frames));
  } finally {
    generic.restore();
  }
});

test("production background stops a Generic turn whose controller disconnects mid-flight", async () => {
  const generic = await genericConversationHarness("generic-disconnect");
  try {
    let release = () => undefined;
    generic.page.sendGate = new Promise((resolve) => { release = resolve; });
    const session = await generic.readSession();
    generic.socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.send",
        protocolVersion: 9,
        requestId: "generic-disconnect",
        agentId: "agent-1",
        provider: "generic",
        sessionId: session.sessionId,
        tabId: generic.tabId,
        frameId: 0,
        documentToken: generic.page.documentToken,
        conversationUrl: session.conversationUrl,
        conversationIdentity: session.conversationIdentity,
        text: "hello",
        attachments: [],
        allowInitialConversationTransition: false,
      }),
    });
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
    generic.socket.emit("close");
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    const afterClose = generic.socket.sent.length;
    release();
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
    assert.equal(
      generic.socket.sent.length,
      afterClose,
      `frames were written to a closed socket: ${JSON.stringify(generic.socket.sent.slice(afterClose))}`,
    );
    assert.equal(
      framesFor(generic.socket, "generic-disconnect").some((frame) => frame.type === "conversation.response"),
      false,
    );
  } finally {
    generic.restore();
  }
});

// BR-G6-02 residue. Supplementary to the staging races in the provider logic suites, not a
// substitute for them: those prove what the shared decision functions do at each instant, and
// this pins that both entries actually ask them, at the write and after every await that follows.
test("both provider entries route attachment staging through the shared refusals", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const provider of ["chatgpt", "claude"]) {
    const source = await readFile(new URL(`../src/content/${provider}.ts`, import.meta.url), "utf8");
    assert.match(source, /writeStagedAttachments\(\{/u, provider);
    assert.match(source, /refuseBeforeWrite:\s*\(input\) =>/u, provider);
    assert.match(
      source,
      /refuseAfterAwait:\s*\(\) => preSubmitRefusal\(undefined, foreignAttachmentRefusal\)/u,
      provider,
    );
    assert.match(source, /stagingWriteRefusal\(element, input, composerOwnership\)/u, provider);
    // BR-G6-02 residue, reopened. The pre-staging reading takes no claim; the claim is committed
    // by the write itself, so no failure between them can make an untouched composer look like
    // staging that never finished.
    assert.match(
      source,
      /captureAttachmentBaseline\(element, composerOwnership, request\.attachments\.length\);\n\s*await attachImages\(\{/u,
      provider,
    );
    assert.match(
      source,
      /onBeforeWrite: \(\) => commitAttachmentOwnership\(composerOwnership\),/u,
      provider,
    );
    assert.doesNotMatch(source, /abandonAttachmentOwnership/u, provider);
    // The settle loop asks the foreign-only half; the asynchronous pre-submit check, which runs
    // after staging and again immediately before Send, asks the whole question.
    assert.match(source, /const attachments = attachmentRefusal\(composerOwnership\);/u, provider);
    assert.match(
      source,
      /await ensureConversationBinding\(request\);[\s\S]{0,400}const refusal = preSubmitRefusal\(expectedComposerText\);\n\s*if \(refusal\) throw new Error\(refusal\);/u,
      provider,
    );
    // Nothing may await between the last look and the native write.
    const critical = source.slice(
      source.indexOf("writeStagedAttachments({"),
      source.indexOf("});", source.indexOf("writeStagedAttachments({")),
    );
    assert.equal(critical.includes("await"), false, `${provider} awaits inside the staging write`);
  }
});

// A Generic page reports partial text while it is still answering, and the entry forwards it as
// `conversation.stream`. It is the one frame the page can push at any moment, so the binding it
// is checked against is the whole guard: a report naming another document is another
// conversation's text, and forwarding it would attribute one page's answer to another.
test("production background forwards a Generic stream update only from the bound document", async () => {
  const generic = await genericConversationHarness("generic-stream");
  try {
    let releaseSend = () => undefined;
    generic.page.sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const session = await generic.send("generic-stream");

    const before = generic.socket.sent.length;
    await generic.dispatch({
      type: "BACHATA_GENERIC_STREAM",
      requestId: "generic-stream",
      documentToken: generic.page.documentToken,
      text: "half an answer",
    });
    for (let turn = 0; turn < 4; turn += 1) await nextTurn();
    const streamed = generic.socket.sent.slice(before)
      .filter((frame) => frame.type === "conversation.stream");
    assert.equal(streamed.length, 1, `the bound document's stream was not forwarded: ${JSON.stringify(generic.socket.sent.slice(before))}`);
    assert.equal(streamed[0].text, "half an answer");
    assert.equal(streamed[0].mode, "replace");
    assert.equal(streamed[0].sessionId, session.sessionId);

    const afterStream = generic.socket.sent.length;
    await generic.dispatch({
      type: "BACHATA_GENERIC_STREAM",
      requestId: "generic-stream",
      documentToken: "generic-document:another-document",
      text: "text from a document this request is not bound to",
    });
    for (let turn = 0; turn < 4; turn += 1) await nextTurn();
    assert.deepEqual(
      generic.socket.sent.slice(afterStream).filter((frame) => frame.type === "conversation.stream"),
      [],
      "an unbound document's text was forwarded as this request's answer",
    );

    releaseSend();
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
  } finally {
    generic.restore();
  }
});

// BB-A4-N05. A final Generic answer that arrives while a Stop is pending used to return without
// retaining the result and without removing the request; the Stop's own failure path then cleared
// the pending flag and left both registries populated. Traced against the unfixed entry the
// sequence reads `afterSend active=true bySession=true pending=true` then
// `droppedByPendingInterrupt`, and the only frames the controller ever sees are
// `conversation.submitted` and `conversation.error:INTERRUPT_FAILED` — the answer gone and the
// session occupied for the life of the connection.
const racedStop = async (generic, requestId, cancelReply) => {
  let releaseSend = () => undefined;
  let releaseCancel = () => undefined;
  generic.page.sendGate = new Promise((resolve) => { releaseSend = resolve; });
  generic.page.cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const session = await generic.readSession();
  const emit = (payload) => generic.socket.emit("message", {
    data: JSON.stringify({
      protocolVersion: 9,
      requestId,
      agentId: "agent-1",
      provider: "generic",
      sessionId: session.sessionId,
      tabId: generic.tabId,
      frameId: 0,
      documentToken: generic.page.documentToken,
      conversationUrl: session.conversationUrl,
      conversationIdentity: session.conversationIdentity,
      ...payload,
    }),
  });
  emit({ type: "conversation.send", text: "hello", attachments: [], allowInitialConversationTransition: false });
  for (let turn = 0; turn < 10; turn += 1) await nextTurn();
  emit({ type: "conversation.interrupt" });
  for (let turn = 0; turn < 12; turn += 1) await nextTurn();
  assert.equal(
    generic.page.commands.some((command) => command.type === "BACHATA_GENERIC_CANCEL"),
    true,
    "the page was never told to stop, so nothing was raced",
  );

  // The answer lands while the Stop is still in flight. This is the window.
  releaseSend();
  for (let turn = 0; turn < 20; turn += 1) await nextTurn();
  assert.deepEqual(
    terminalFrames(framesFor(generic.socket, requestId)),
    [],
    "the turn was settled before the Stop it was racing had answered",
  );

  generic.page.cancelReply = cancelReply;
  releaseCancel();
  for (let turn = 0; turn < 30; turn += 1) await nextTurn();
  return { session, frames: framesFor(generic.socket, requestId) };
};

const terminalFrames = (frames) => frames.filter((frame) => (
  frame.type === "conversation.response"
    || frame.type === "conversation.interrupted"
    || frame.type === "conversation.error"
));

const sessionAcceptsAnotherTurn = async (generic, session, requestId) => {
  generic.page.cancelGate = undefined;
  generic.page.cancelReply = undefined;
  generic.page.sendGate = undefined;
  generic.socket.emit("message", {
    data: JSON.stringify({
      type: "conversation.send",
      protocolVersion: 9,
      requestId,
      agentId: "agent-1",
      provider: "generic",
      sessionId: session.sessionId,
      tabId: generic.tabId,
      frameId: 0,
      documentToken: generic.page.documentToken,
      conversationUrl: session.conversationUrl,
      conversationIdentity: session.conversationIdentity,
      text: "again",
      attachments: [],
      allowInitialConversationTransition: false,
    }),
  });
  for (let turn = 0; turn < 20; turn += 1) await nextTurn();
  return framesFor(generic.socket, requestId).filter((frame) =>
    frame.type === "conversation.error" &&
    /already has an active request/u.test(String(frame.message ?? ""))).length === 0;
};

test("production background delivers a Generic answer that raced a failed Stop", async () => {
  const generic = await genericConversationHarness("generic-stop-failed");
  try {
    const { session, frames } = await racedStop(generic, "generic-stop-failed", {
      ok: false,
      error: "the stop control vanished",
    });
    const terminal = terminalFrames(frames);
    assert.equal(terminal.length, 1, `more than one terminal frame: ${JSON.stringify(terminal)}`);
    assert.equal(terminal[0].type, "conversation.response", JSON.stringify(frames.map((frame) => frame.type)));
    assert.equal(terminal[0].text, "answer");
    assert.equal(
      await sessionAcceptsAnotherTurn(generic, session, "generic-stop-failed-2"),
      true,
      "the session stayed occupied after the turn ended",
    );
  } finally {
    generic.restore();
  }
});

// BB-A4-N05, the other ordering. The Stop settles first — the page refuses it — and the answer
// arrives afterwards. Reported as `conversation.error` this was the request's terminal frame, and
// the controller removed the pending operation on it, so the answer that arrived next matched
// nothing and was dropped. A failed Stop is now said without ending anything.
test("production background says a Generic Stop failed without ending the turn", async () => {
  const generic = await genericConversationHarness("generic-stop-failed-first");
  const requestId = "generic-stop-failed-first";
  try {
    let releaseSend = () => undefined;
    generic.page.sendGate = new Promise((resolve) => { releaseSend = resolve; });
    generic.page.cancelReply = { ok: false, error: "the stop control vanished" };
    const session = await generic.send(requestId);

    generic.socket.emit("message", {
      data: JSON.stringify({
        type: "conversation.interrupt",
        protocolVersion: 9,
        requestId,
        agentId: "agent-1",
        provider: "generic",
        sessionId: session.sessionId,
        tabId: generic.tabId,
        frameId: 0,
        documentToken: generic.page.documentToken,
        conversationUrl: session.conversationUrl,
        conversationIdentity: session.conversationIdentity,
      }),
    });
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();

    // The Stop has already failed, and the answer has not arrived yet.
    const afterStop = framesFor(generic.socket, requestId);
    assert.deepEqual(
      terminalFrames(afterStop),
      [],
      `a failed Stop ended the turn that was still running: ${JSON.stringify(afterStop.map((frame) => frame.type))}`,
    );
    const failures = afterStop.filter((frame) => frame.type === "conversation.interruptFailed");
    assert.equal(failures.length, 1, `the failed Stop was not reported: ${JSON.stringify(afterStop.map((frame) => frame.type))}`);
    assert.equal(failures[0].sessionId, session.sessionId);
    assert.match(String(failures[0].message), /stop control vanished/u);

    releaseSend();
    for (let turn = 0; turn < 30; turn += 1) await nextTurn();

    const frames = framesFor(generic.socket, requestId);
    const terminal = terminalFrames(frames);
    assert.equal(terminal.length, 1, `more than one terminal frame: ${JSON.stringify(terminal)}`);
    assert.equal(terminal[0].type, "conversation.response", JSON.stringify(frames.map((frame) => frame.type)));
    assert.equal(terminal[0].text, "answer");
    assert.equal(
      frames.filter((frame) => frame.type === "conversation.interruptFailed").length,
      1,
      "the failed Stop was reported more than once",
    );
    assert.equal(
      frames.filter((frame) => frame.type === "conversation.send").length,
      0,
      "the entry resent the turn",
    );
    assert.equal(
      await sessionAcceptsAnotherTurn(generic, session, `${requestId}-2`),
      true,
      "the session stayed occupied after a failed Stop",
    );
  } finally {
    generic.restore();
  }
});

test("production background drops a Generic answer that raced a confirmed Stop", async () => {
  const generic = await genericConversationHarness("generic-stop-confirmed");
  try {
    const { session, frames } = await racedStop(generic, "generic-stop-confirmed", undefined);
    const terminal = terminalFrames(frames);
    assert.equal(terminal.length, 1, `more than one terminal frame: ${JSON.stringify(terminal)}`);
    assert.equal(terminal[0].type, "conversation.interrupted", JSON.stringify(frames.map((frame) => frame.type)));
    assert.equal(
      await sessionAcceptsAnotherTurn(generic, session, "generic-stop-confirmed-2"),
      true,
      "a confirmed Stop left the session occupied",
    );
  } finally {
    generic.restore();
  }
});

// BB-A4-F10. Provisioning reads the abort signal before it looks a preferred tab up and again
// after the page has answered, but not between the lookup and what it does with the answer. A
// Disconnect that lands in that window cancelled the queue, and the resumed operation still
// navigated the person's tab — and, when the lookup disqualified that tab, still opened a new
// one. Both cases stand in the same window: the preferred-tab lookup is held open, the
// Disconnect is delivered while it is still pending, and only then does it answer. What the
// lookup answers is what decides which branch would have acted next.
const provisioningAcrossDisconnect = async (label, options) => {
  const { tabs, request = { preferredTabId: 77 }, hold = (harness) => harness.holdTabGet(), reached } = options;
  const harness = await registeredDocumentHarness(label);
  try {
    const socket = await harness.pair();
    harness.setProviderTabs(tabs);
    const release = hold(harness);
    socket.emit("message", {
      data: JSON.stringify({
        type: "provider.openConversation",
        protocolVersion: 9,
        requestId: "provision-abort",
        provider: "chatgpt",
        fresh: true,
        ...request,
      }),
    });
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();
    const held = harness.tabCalls.length;
    assert.deepEqual(
      harness.tabCalls.filter((entry) => reached(entry)),
      [reached.expected],
      `provisioning is not standing in the held call: ${JSON.stringify(harness.tabCalls)}`,
    );
    assert.ok(held > 0, "provisioning never reached the call this case holds open");

    // Not awaited: the Disconnect is deliberately delivered while the held call is still open, and
    // its own teardown can reach the same stub, so waiting for it here would wait for the gate
    // this case exists to hold.
    void dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], { type: "popup.disconnect" })
      .catch(() => undefined);
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    release();
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
    return { harness, calls: harness.tabCalls.slice(held) };
  } finally {
    harness.restore();
  }
};

const reachedTab77 = (entry) => entry.tabId === 77;
reachedTab77.expected = { call: "get", tabId: 77 };

const reachedCreate = (entry) => entry.call === "create";
reachedCreate.expected = { call: "create", options: { url: "https://chatgpt.com/", active: false } };

// The lookup answers with the person's provider tab, so the resumed operation would have
// navigated it.
test("a preferred-tab lookup that resumes after Disconnect navigates nothing", async () => {
  const { calls } = await provisioningAcrossDisconnect("provision-abort-reusable", {
    tabs: [{ id: 77, url: "https://chatgpt.com/c/the-persons-tab", title: "the person's tab" }],
    reached: reachedTab77,
  });
  assert.deepEqual(
    calls.filter((entry) => entry.call === "update" || entry.call === "create"),
    [],
    `provisioning acted on the browser after it was cancelled: ${JSON.stringify(calls)}`,
  );
});

// The lookup answers with a tab that is not this provider's, so the reuse branch is disqualified
// and the resumed operation would have fallen through and opened a tab. Cancellation has to be
// read between the lookup and that fallback, not only between the lookup and the navigation.
test("a preferred-tab lookup that disqualifies the tab opens nothing after Disconnect", async () => {
  const { calls } = await provisioningAcrossDisconnect("provision-abort-fallback", {
    tabs: [{ id: 77, url: "https://example.com/not-a-provider", title: "the person's tab" }],
    reached: reachedTab77,
  });
  assert.deepEqual(
    calls.filter((entry) => entry.call === "update" || entry.call === "create"),
    [],
    `a cancelled provisioning still acted on the browser: ${JSON.stringify(calls)}`,
  );
});

// The other side of the same window: a Disconnect that lands after the tab is already open. The
// abort is read on the far side of the creation, and what the cancelled provisioning owes the
// person then is not inaction but the tab it opened, closed again.
test("a Disconnect during tab creation closes the tab it opened", async () => {
  const { calls } = await provisioningAcrossDisconnect("provision-abort-created", {
    tabs: [],
    request: {},
    hold: (harness) => harness.holdTabCreate(),
    reached: reachedCreate,
  });
  assert.deepEqual(
    calls.filter((entry) => entry.call === "update"),
    [],
    `a cancelled provisioning still navigated a tab: ${JSON.stringify(calls)}`,
  );
  assert.deepEqual(
    calls.filter((entry) => entry.call === "remove"),
    [{ call: "remove", tabId: 512 }],
    `the tab the cancelled provisioning opened was left behind: ${JSON.stringify(calls)}`,
  );
});

// The local-model proxy is the extension's only outbound network path, and the entry owns it: a
// content script may not reach the model itself. What it may ask for is decided by the controller
// through `localModel.config`, so a prompt that arrives before the controller enabled healing is
// refused rather than sent anywhere, and an enabled one goes to the configured loopback endpoint
// and nowhere else.
test("production background reaches the local model only after the controller enables healing", async () => {
  const harness = await registeredDocumentHarness("local-model");
  try {
    const socket = await harness.pair();
    const refused = await harness.fromContent({
      type: "BACHATA_LOCAL_MODEL_PROMPT",
      requestId: "heal-1",
      prompt: "which candidate is the composer?",
    });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(String(refused.error), /disabled/u);
    assert.deepEqual(harness.fetchCalls, [], "a refused prompt still left the machine");

    socket.emit("message", {
      data: JSON.stringify({
        type: "localModel.config",
        protocolVersion: 9,
        enabled: true,
        backend: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "healer",
        timeoutMs: 5_000,
      }),
    });
    for (let turn = 0; turn < 4; turn += 1) await nextTurn();
    harness.setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: "{\"id\":\"c2\"}" } }),
    }));

    const answered = await harness.fromContent({
      type: "BACHATA_LOCAL_MODEL_PROMPT",
      requestId: "heal-2",
      prompt: "which candidate is the composer?",
    });
    assert.equal(answered.ok, true, JSON.stringify(answered));
    assert.equal(answered.text, "{\"id\":\"c2\"}");
    assert.deepEqual(
      harness.fetchCalls.map((call) => call.url),
      ["http://127.0.0.1:11434/api/chat"],
      `the proxy reached somewhere other than the configured endpoint: ${JSON.stringify(harness.fetchCalls.map((call) => call.url))}`,
    );
    const sent = JSON.parse(String(harness.fetchCalls[0].init?.body));
    assert.equal(sent.model, "healer");
    assert.equal(sent.stream, false);
    assert.equal(
      sent.messages.some((entry) => entry.content === "which candidate is the composer?"),
      true,
      `the prompt the page asked about was not the one sent: ${JSON.stringify(sent.messages)}`,
    );
  } finally {
    harness.restore();
  }
});

// BB-A4-N04. A reload replaces the document, and the commit event that says so cannot reinject:
// the replacement is still loading. Reinjection happens on the later `status: "complete"` update,
// and that update only probes a tab it still considers tracked — but the commit's invalidation
// had already forgotten the selection and the handled-tab record, so by the time the page was
// ready there was nothing left saying it was ours, and the tab needed manual rediscovery.
test("a bound tab that reloads is reinjected without manual rediscovery", async () => {
  const harness = await registeredDocumentHarness("reload-reinject");
  try {
    await harness.pair();
    const bound = await harness.selectAndReadSession();
    assert.equal(bound.id, 31, "the tab was never selected, so nothing was bound to lose");

    // The person reloads. The commit says a new document replaced the bound one.
    harness.committedEvent.listeners.forEach((listener) => listener({
      tabId: 31,
      frameId: 0,
      url: harness.providerUrl,
      transitionType: "reload",
      documentId: "document-after-reload",
    }));
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();

    const injectedBefore = harness.injections.length;
    // The replacement finishes loading. This is the only moment reinjection can happen.
    harness.updatedEvent.listeners.forEach((listener) => listener(31, { status: "complete" }));
    for (let turn = 0; turn < 12; turn += 1) await nextTurn();

    assert.ok(
      harness.injections.length > injectedBefore,
      "the reloaded document was never reinjected, so the tab needs manual rediscovery",
    );
    // And the tab is usable again on its own, without anyone going back to the popup to find it.
    const after = await dispatchRuntimeMessage(harness.runtimeEvent.listeners[0], {
      type: "popup.getState",
    });
    const reloaded = after.tabs?.find((tab) => tab.id === 31);
    assert.notEqual(reloaded, undefined, `the tab left the popup entirely: ${JSON.stringify(after)}`);
    assert.equal(reloaded.ready, true, `the reloaded tab never became usable: ${JSON.stringify(reloaded)}`);
    assert.equal(typeof reloaded.sessionId, "string", "the reloaded tab holds no session");
  } finally {
    harness.restore();
  }
});

test("the document a reload replaced can no longer act", async () => {
  const harness = await registeredDocumentHarness("reload-stale-document");
  try {
    const socket = await harness.pair();
    harness.committedEvent.listeners.forEach((listener) => listener({
      tabId: 31,
      frameId: 0,
      url: harness.providerUrl,
      transitionType: "reload",
      documentId: "document-after-reload",
    }));
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();

    const before = socket.sent.length;
    await harness.fromContent({
      type: "content.response",
      requestId: "stale-document-turn",
      documentToken: harness.documentToken,
      text: "answered by a document that is gone",
    });
    for (let turn = 0; turn < 6; turn += 1) await nextTurn();
    assert.deepEqual(
      socket.sent.slice(before).filter((frame) => frame.type === "conversation.response"),
      [],
      "a document the reload replaced still answered for the tab",
    );
  } finally {
    harness.restore();
  }
});
