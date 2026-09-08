import assert from "node:assert/strict";
import test from "node:test";

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const createChrome = (tabUrls) => {
  const executed = [];
  const messages = [];
  const sessionStore = new Map();
  const localStore = new Map();
  return {
    executed,
    messages,
    stub: {
      runtime: { id: "bachata-bridge-test" },
      permissions: {
        contains: async () => true,
        request: async () => true,
      },
      scripting: {
        executeScript: async (details) => {
          executed.push(details.target.tabId);
          return [];
        },
      },
      tabs: {
        get: async (tabId) => {
          const url = tabUrls.get(tabId);
          if (url === undefined) throw new Error("No tab with that id");
          return { id: tabId, url };
        },
        query: async () => [...tabUrls].map(([id, url]) => ({ id, url })),
        sendMessage: async (tabId, message) => {
          messages.push({ tabId, message });
          if (message.type !== "BACHATA_GENERIC_STATUS") {
            return { ok: true, value: message.type };
          }
          return {
            ok: true,
            value: {
              status: "ready",
              origin: new URL(tabUrls.get(tabId) ?? "https://example.test").origin,
              url: tabUrls.get(tabId) ?? "https://example.test/c/1234",
              title: "conversation",
              documentRevision: 1,
              documentToken: "0123456789abcdef0123",
              capabilities: {
                submission: "verifiedSend",
                completion: "verifiedLifecycle",
                interruption: "confirmed",
                assets: "textOnly",
                conversationState: "confirmed",
              },
            },
          };
        },
      },
      storage: {
        session: {
          get: async (key) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
          set: async (value) => {
            for (const [key, entry] of Object.entries(value)) sessionStore.set(key, entry);
          },
        },
        local: {
          get: async () => Object.fromEntries(localStore),
          set: async (value) => {
            for (const [key, entry] of Object.entries(value)) localStore.set(key, entry);
          },
        },
      },
    },
  };
};

const loadProvider = async (tabUrls, stamp) => {
  const chrome = createChrome(tabUrls);
  setGlobal("chrome", chrome.stub);
  const provider = await import(`../dist/background/genericProvider.js?instance=${stamp}`);
  return { chrome, provider };
};

const registerMessage = (origin) => ({
  type: "BACHATA_GENERIC_REGISTER",
  origin,
  url: `${origin}/c/1234`,
  title: "conversation",
  documentRevision: 1,
  documentToken: "0123456789abcdef0123",
});

const sender = (tabId, url) => ({ id: "bachata-bridge-test", frameId: 0, tab: { id: tabId, url } });

test("built-in provider locations are matched by hostname across scheme and www variants", async () => {
  const { provider } = await loadProvider(new Map(), "hostname");
  for (const value of [
    "https://chatgpt.com",
    "http://chatgpt.com",
    "https://www.chatgpt.com",
    "https://claude.ai/c/1234",
    "https://www.claude.ai",
    "https://CHATGPT.com",
  ]) {
    assert.equal(provider.isBuiltInProviderLocation(value), true, value);
  }
  for (const value of [
    "https://example.test",
    "https://chatgpt.com.example.test",
    "https://notchatgpt.com",
    "https://claude.ai.example.test",
    "not-a-url",
  ]) {
    assert.equal(provider.isBuiltInProviderLocation(value), false, value);
  }
});

test("generic registration is refused on built-in provider origins and accepted elsewhere", async () => {
  const { provider } = await loadProvider(new Map(), "register");

  assert.equal(
    await provider.handleGenericContentMessage(
      registerMessage("https://chatgpt.com"),
      sender(11, "https://chatgpt.com/c/1234"),
    ),
    false,
  );
  assert.equal(provider.isGenericTab(11), false);

  assert.equal(
    await provider.handleGenericContentMessage(
      registerMessage("https://claude.ai"),
      sender(12, "https://claude.ai/chat/1234"),
    ),
    false,
  );
  assert.equal(provider.isGenericTab(12), false);

  assert.equal(
    await provider.handleGenericContentMessage(
      registerMessage("https://example.test"),
      sender(13, "https://example.test/c/1234"),
    ),
    true,
  );
  assert.equal(provider.isGenericTab(13), true);
});

test("generic send targeting a built-in provider tab is refused before any injection", async () => {
  const tabUrls = new Map([[21, "https://chatgpt.com/c/1234"], [22, "https://example.test/c/1234"]]);
  const { chrome, provider } = await loadProvider(tabUrls, "send");

  await assert.rejects(
    provider.sendGenericCommand(21, { type: "conversation.send", prompt: "hello", requestId: "r1" }),
    /not available on built-in provider origins/,
  );
  assert.equal(chrome.executed.length, 0);
  assert.equal(chrome.messages.length, 0);

  await provider.sendGenericCommand(22, { type: "conversation.send", prompt: "hello", requestId: "r2" });
  assert.equal(chrome.messages.some((entry) => entry.message.type === "BACHATA_GENERIC_SEND"), true);
});

test("read-only generic commands remain available on built-in provider tabs", async () => {
  const tabUrls = new Map([[31, "https://claude.ai/chat/1234"]]);
  const { chrome, provider } = await loadProvider(tabUrls, "readonly");

  await provider.sendGenericCommand(31, { type: "BACHATA_GENERIC_READABLE" });
  await provider.sendGenericCommand(31, { type: "BACHATA_GENERIC_SELECTED_TEXT" });
  const delivered = chrome.messages.map((entry) => entry.message.type);
  assert.equal(delivered.includes("BACHATA_GENERIC_READABLE"), true);
  assert.equal(delivered.includes("BACHATA_GENERIC_SELECTED_TEXT"), true);
});

test("generic bind and auto-heal menu actions are refused on built-in provider tabs", async () => {
  const tabUrls = new Map([[41, "https://chatgpt.com/c/1234"]]);
  const { chrome, provider } = await loadProvider(tabUrls, "menu");
  const tab = { id: 41, url: "https://chatgpt.com/c/1234" };

  for (const menuItemId of [
    "bachata-generic-bind-composer",
    "bachata-generic-bind-response",
    "bachata-generic-bind-send",
    "bachata-generic-auto-heal",
    "bachata-generic-validate",
  ]) {
    await assert.rejects(
      provider.handleGenericContextMenu({ menuItemId }, tab),
      /not available on built-in provider origins/,
      menuItemId,
    );
  }
  assert.equal(chrome.executed.length, 0);
  assert.equal(chrome.messages.length, 0);

  await provider.handleGenericContextMenu({ menuItemId: "bachata-generic-readable" }, tab);
  assert.equal(chrome.messages.some((entry) => entry.message.type === "BACHATA_GENERIC_READABLE"), true);
});

test("binding the current tab is refused on built-in provider origins", async () => {
  const tabUrls = new Map([[51, "https://claude.ai/chat/1234"]]);
  const { chrome, provider } = await loadProvider(tabUrls, "bind");
  await assert.rejects(
    provider.bindCurrentGenericTab(),
    /not available on built-in provider origins/,
  );
  assert.equal(chrome.executed.length, 0);
});

test("stored registrations on built-in provider origins are dropped on restore", async () => {
  const tabUrls = new Map([[61, "https://chatgpt.com/c/1234"], [62, "https://example.test/c/1234"]]);
  const { provider } = await loadProvider(tabUrls, "restore");

  await globalThis.chrome.storage.session.set({
    "bachataGenericRegistrations.v1": [
      {
        tabId: 61,
        frameId: 0,
        origin: "https://chatgpt.com",
        url: "https://chatgpt.com/c/1234",
        title: "conversation",
        documentRevision: 1,
        documentToken: "0123456789abcdef0123",
        registeredAt: 1,
      },
      {
        tabId: 62,
        frameId: 0,
        origin: "https://example.test",
        url: "https://example.test/c/1234",
        title: "conversation",
        documentRevision: 1,
        documentToken: "0123456789abcdef0123",
        registeredAt: 2,
      },
    ],
  });

  await provider.restoreGenericRegistrations();
  assert.equal(provider.isGenericTab(61), false);
  assert.equal(provider.isGenericTab(62), true);
});
