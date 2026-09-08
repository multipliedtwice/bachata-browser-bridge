import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const createChrome = (tabUrls, options = {}) => {
  const messages = [];
  const executed = [];
  const removed = [];
  const sessionStore = new Map();
  const localStore = new Map(Object.entries(options.local ?? {}));
  const contextMenus = [];
  return {
    messages,
    executed,
    removed,
    localStore,
    sessionStore,
    contextMenus,
    stub: {
      runtime: { id: "bachata-bridge-test", lastError: undefined, getURL: (path) => `chrome-extension://bachata-bridge-test/${path}` },
      webNavigation: { getFrame: async ({ tabId }) => ({ documentId: options.frameDocumentId ?? "document-1", documentLifecycle: "active", url: options.frameUrl ?? tabUrls.get(tabId) }) },
      permissions: {
        getAll: async () => ({ origins: options.origins ?? [] }),
        contains: async () => options.permissionGranted ?? true,
        request: async () => options.permissionRequestGranted ?? true,
        remove: async () => {
          if (options.revokeFails) return false;
          options.permissionGranted = false;
          return true;
        },
      },
      scripting: {
        executeScript: async (details) => {
          if (options.injectionFails) throw new Error("injection refused");
          executed.push(details.target.tabId);
          return [];
        },
      },
      contextMenus: {
        remove: async (id) => { removed.push(id); },
        create: (definition) => { contextMenus.push(definition); },
      },
      tabs: {
        get: async (tabId) => {
          const url = tabUrls.get(tabId);
          if (url === undefined) throw new Error("No tab with that id");
          return { id: tabId, url };
        },
        query: async () => [...tabUrls].map(([id, url]) => ({ id, url })),
        sendMessage: async (tabId, message, target) => {
          messages.push({ tabId, message, ...(target?.documentId ? { target } : {}) });
          if (options.sendFails) throw new Error("tab is gone");
          if (message.type !== "BACHATA_GENERIC_STATUS") return { ok: true, value: message.type };
          return {
            ok: true,
            value: {
              status: options.status ?? "ready",
              origin: new URL(tabUrls.get(tabId) ?? "https://llm.test").origin,
              url: tabUrls.get(tabId) ?? "https://llm.test/c/1",
              title: "conversation",
              documentRevision: options.documentRevision ?? 1,
              documentToken: options.documentToken ?? "0123456789abcdef0123",
              capabilities: options.capabilities ?? {
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
          remove: async (key) => { localStore.delete(key); },
        },
      },
    },
  };
};

// One module instance for the whole file: re-importing per test would split coverage across
// instances and hide the behaviour these tests exercise. State is reset between tests.
setGlobal("chrome", createChrome(new Map()).stub);
const provider = await import("../dist/background/genericProvider.js");

const loadProvider = async (tabUrls, options) => {
  const chrome = createChrome(tabUrls, options);
  setGlobal("chrome", chrome.stub);
  provider.genericRegistrations().forEach((entry) => provider.removeGenericRegistration(entry.tabId));
  return { chrome, provider };
};

const sender = (tabId, url) => ({ id: "bachata-bridge-test", frameId: 0, tab: { id: tabId, url } });

const registerMessage = (origin, overrides = {}) => ({
  type: "BACHATA_GENERIC_REGISTER",
  origin,
  url: `${origin}/c/1`,
  title: "conversation",
  documentRevision: 1,
  documentToken: "0123456789abcdef0123",
  ...overrides,
});

const popupSender = { id: "bachata-bridge-test", url: "chrome-extension://bachata-bridge-test/popup/index.html" };
const storedProfile = (origin, routePattern = "/private/conversation") => ({
  protocol: "bachata-generic-binding-v1", origin, routePattern, framePath: [],
  composer: { tag: "textarea", stableAttributes: {}, structuralPath: [] },
  conversationRoot: { tag: "main", stableAttributes: {}, structuralPath: [] },
  createdBy: "user", validated: true, consecutiveFailures: 0, documentRevision: 1,
});

test("saved binding management hides private paths and removes only the unchanged selected profile", async () => {
  const origin = "https://llm.test";
  const key = `bachata.generic.profile.${origin}`;
  const first = storedProfile(origin);
  const second = storedProfile(origin, "/another-private-conversation");
  const { chrome, provider } = await loadProvider(new Map(), { local: {
    [key]: { protocol: "bachata-generic-binding-store-v1", profiles: [first, second] },
  } });
  const manage = (message) => provider.handleGenericManagementMessage(message, popupSender, () => false);
  const listed = await manage({ action: "list" });
  assert.equal(listed.entries.length, 2);
  assert.doesNotMatch(JSON.stringify(listed), /private|textarea|structuralPath/);
  await manage({ action: "remove", origin, id: listed.entries[0].id });
  assert.deepEqual(chrome.localStore.get(key).profiles, [second]);
  await assert.rejects(manage({ action: "remove", origin, id: listed.entries[0].id }), /changed/);
  await manage({ action: "remove", origin, id: listed.entries[1].id });
  assert.equal(chrome.localStore.has(key), false);
  assert.equal(await chrome.stub.permissions.contains(), true);
});

test("management lists explicit access without a profile and reports broader grants", async () => {
  const { provider } = await loadProvider(new Map(), { origins: ["https://orphan.test/*", "https://chatgpt.com/*", "http://localhost/*", "https://*.broad.test/*"] });
  const response = await provider.handleGenericManagementMessage({ action: "list" }, popupSender, () => false);
  assert.deepEqual(response.entries, [{ origin: "https://orphan.test", validated: false, permitted: true }]);
  assert.equal(response.broaderPermissions, true);
});

test("Generic management requires an authentic popup and exact granted origin", async () => {
  const origin = "https://llm.test";
  const { provider, chrome } = await loadProvider(new Map([[11, `${origin}/chat`]]), { permissionGranted: false });
  const manage = (message, identity = popupSender) => provider.handleGenericManagementMessage(message, identity, () => false);
  for (const identity of [{}, { ...popupSender, tab: { id: 11 } }, { ...popupSender, id: "other" }, { ...popupSender, url: `${popupSender.url}?other` }]) {
    await assert.rejects(manage({ action: "list" }, identity), /popup/);
  }
  for (const invalid of ["https://chatgpt.com", "https://www.claude.ai", `${origin}/chat`, "file:///tmp/page"]) {
    await assert.rejects(manage({ action: "setup", origin: invalid, tabId: 11 }), /exact Generic/);
  }
  await assert.rejects(manage({ action: "setup", origin, tabId: 11 }), /Allow access/);
  await assert.rejects(manage({ action: "setup", origin: "https://other.test", tabId: 11 }), /changed/);
  await assert.rejects(manage({ action: "setup", origin, tabId: -1 }), /Select/);
  await assert.rejects(manage({ action: "remove", origin, id: "bad" }), /Invalid/);
  await assert.rejects(manage({ action: "unknown", origin }), /Unknown/);
  assert.equal(chrome.messages.length, 0);
});

test("setup dispatches no prompt and active requests prevent management", async () => {
  const origin = "https://llm.test";
  const { provider, chrome } = await loadProvider(new Map([[11, `${origin}/chat`]]));
  const manage = (message, busy = false) => provider.handleGenericManagementMessage(message, popupSender, () => busy);
  await manage({ action: "setup", origin, tabId: 11 });
  assert.equal(chrome.messages.at(-1).message.type, "BACHATA_GENERIC_SETUP");
  assert.deepEqual(chrome.messages.at(-1).target, { documentId: "document-1" });
  assert.equal(chrome.messages.some(({ message }) => message.type === "BACHATA_GENERIC_SEND"), false);
  await provider.handleGenericContentMessage(registerMessage(origin), sender(11, `${origin}/chat`));
  await assert.rejects(manage({ action: "revoke", origin, confirmed: true }, true), /active request/);
});

test("revocation requires confirmation, preserves profiles and reports browser refusal", async () => {
  const origin = "https://llm.test";
  const key = `bachata.generic.profile.${origin}`;
  const options = { revokeFails: true, local: { [key]: storedProfile(origin) } };
  const { provider, chrome } = await loadProvider(new Map([[11, `${origin}/chat`]]), options);
  const manage = (message) => provider.handleGenericManagementMessage(message, popupSender, () => false);
  await assert.rejects(manage({ action: "revoke", origin }), /Confirm/);
  await assert.rejects(manage({ action: "revoke", origin, confirmed: true }), /did not revoke/);
  assert.ok(chrome.localStore.has(key));
  options.revokeFails = false;
  await provider.handleGenericContentMessage(registerMessage(origin), sender(11, `${origin}/chat`));
  await manage({ action: "revoke", origin, confirmed: true });
  assert.deepEqual(provider.genericRegistrations(), []);
  assert.ok(chrome.localStore.has(key));
});

test("setup refuses document replacement and targets injection by document identity", async () => {
  const origin = "https://llm.test";
  const options = {};
  const { provider, chrome } = await loadProvider(new Map([[11, `${origin}/chat`]]), options);
  let reads = 0;
  chrome.stub.webNavigation.getFrame = async () => ({
    url: `${origin}/chat`, documentLifecycle: "active", documentId: ++reads === 1 ? "first" : "replacement",
  });
  await assert.rejects(provider.handleGenericManagementMessage({ action: "setup", origin, tabId: 11 }, popupSender, () => false), /document changed/);
  assert.equal(chrome.messages.some(({ message }) => message.type === "BACHATA_GENERIC_SETUP"), false);
  let injection;
  chrome.stub.webNavigation.getFrame = async () => ({ url: `${origin}/chat`, documentLifecycle: "active", documentId: "stable" });
  chrome.stub.tabs.sendMessage = async (_tabId, message) => {
    if (message.type === "BACHATA_GENERIC_STATUS") throw new Error("No receiver");
    return { ok: true };
  };
  chrome.stub.scripting.executeScript = async (details) => { injection = details; return []; };
  await provider.handleGenericManagementMessage({ action: "setup", origin, tabId: 11 }, popupSender, () => false);
  assert.deepEqual(injection.target, { tabId: 11, documentIds: ["stable"] });
});

test("management serializes site changes and rejects a concurrent prompt before dispatch", async () => {
  const origin = "https://llm.test";
  const { provider, chrome } = await loadProvider(new Map([[11, `${origin}/chat`]]));
  await provider.handleGenericContentMessage(registerMessage(origin), sender(11, `${origin}/chat`));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  chrome.stub.tabs.get = async () => { await held; return { id: 11, url: `${origin}/chat` }; };
  const pending = provider.handleGenericManagementMessage({ action: "setup", origin, tabId: 11 }, popupSender, () => false);
  await assert.rejects(provider.handleGenericManagementMessage({ action: "setup", origin, tabId: 11 }, popupSender, () => false), /already being changed/);
  await assert.rejects(provider.sendGenericCommand(11, { type: "BACHATA_GENERIC_SEND", prompt: "must not send" }), /No prompt was sent/);
  assert.equal(chrome.messages.some(({ message }) => message.type === "BACHATA_GENERIC_SEND"), false);
  release();
  await pending;
});

test("registering a generic conversation binds it and reports its capabilities", async () => {
  const tabs = new Map([[11, "https://llm.test/c/1"]]);
  const { provider } = await loadProvider(tabs);
  const outcome = await provider.handleGenericContentMessage(
    registerMessage("https://llm.test"),
    sender(11, "https://llm.test/c/1"),
  );
  assert.ok(outcome, "registration returned nothing");
  const registrations = provider.genericRegistrations();
  assert.equal(registrations.length, 1, "the conversation was not bound");
  assert.equal(registrations[0].origin, "https://llm.test");

  const status = await provider.genericStatus(11);
  assert.equal(status.status, "ready");
  assert.equal(
    status.capabilities.completion,
    "verifiedLifecycle",
    "capability verification did not reach the caller",
  );
});

test("a message from an unregistered or foreign sender is refused", async () => {
  const tabs = new Map([[11, "https://llm.test/c/1"]]);
  const { provider } = await loadProvider(tabs);
  // The sender's own tab URL is what binds a conversation; a mismatched origin is refused.
  const mismatched = await provider.handleGenericContentMessage(
    registerMessage("https://llm.test"),
    sender(11, "https://elsewhere.test/c/1"),
  );
  assert.equal(mismatched, false, "a registration whose origin did not match its tab was accepted");
  assert.deepEqual(provider.genericRegistrations(), [], "a mismatched registration bound a conversation");

  const noTab = await provider.handleGenericContentMessage(
    registerMessage("https://llm.test"),
    { id: "bachata-bridge-test", frameId: 0 },
  );
  assert.equal(noTab, false, "a message with no tab was accepted");
});

test("a built-in provider origin is never taken over by the generic path", async () => {
  const tabs = new Map([[12, "https://chatgpt.com/c/1"]]);
  const { provider } = await loadProvider(tabs);
  const outcome = await provider.handleGenericContentMessage(
    registerMessage("https://chatgpt.com"),
    sender(12, "https://chatgpt.com/c/1"),
  );
  assert.equal(outcome, false, "generic registration claimed a built-in provider origin");
  assert.deepEqual(provider.genericRegistrations(), []);
});

test("registrations are isolated per tab, and removing one keeps the others", async () => {
  const tabs = new Map([[11, "https://a.test/c/1"], [12, "https://b.test/c/1"]]);
  const { provider } = await loadProvider(tabs);
  await provider.handleGenericContentMessage(registerMessage("https://a.test"), sender(11, "https://a.test/c/1"));
  await provider.handleGenericContentMessage(registerMessage("https://b.test"), sender(12, "https://b.test/c/1"));
  assert.equal(provider.genericRegistrations().length, 2);

  provider.removeGenericRegistration(11);
  const left = provider.genericRegistrations();
  assert.equal(left.length, 1, "removing one tab's binding disturbed another");
  assert.equal(left[0].origin, "https://b.test");
});

test("a tab that is gone surfaces the failure instead of inventing a status", async () => {
  const tabs = new Map([[11, "https://llm.test/c/1"]]);
  const { provider } = await loadProvider(tabs, { sendFails: true });
  const failure = await provider.genericStatus(11).then(() => undefined, (error) => error);
  assert.ok(failure, "an unreachable tab produced a status anyway");
  assert.match(String(failure.message), /tab is gone/u);
});

test("a closed tab's binding is removed and the others survive", async () => {
  const tabs = new Map([[11, "https://a.test/c/1"], [12, "https://b.test/c/1"]]);
  const { provider } = await loadProvider(tabs);
  await provider.handleGenericContentMessage(registerMessage("https://a.test"), sender(11, "https://a.test/c/1"));
  await provider.handleGenericContentMessage(registerMessage("https://b.test"), sender(12, "https://b.test/c/1"));
  provider.removeGenericRegistration(11);
  assert.deepEqual(
    provider.genericRegistrations().map((entry) => entry.origin),
    ["https://b.test"],
    "closing one tab disturbed another conversation's binding",
  );
});

test("stored profile origins survive a restart and are restored", async () => {
  const { provider, chrome } = await loadProvider(
    new Map([[11, "https://llm.test/c/1"]]),
    {
      local: {
        "bachata.generic.profile.https://llm.test": {
          protocol: "bachata-generic-binding-store-v1",
          profiles: [],
        },
      },
    },
  );
  const stored = await provider.storedGenericProfileOrigins();
  assert.deepEqual(stored, ["https://llm.test"], "a stored profile origin was lost");
  await provider.restoreGenericRegistrations();
  assert.ok(chrome.stub.runtime.id, "restoration threw rather than restoring");
});

test("a profile is only stored when its origin permission is actually granted", async () => {
  const granted = await loadProvider(new Map(), { permissionGranted: true });
  assert.equal(await granted.provider.ensureGenericOriginPermission("https://llm.test"), true);

  const refused = await loadProvider(new Map(), {
    permissionGranted: false,
    permissionRequestGranted: false,
  });
  assert.equal(
    await refused.provider.ensureGenericOriginPermission("https://llm.test"),
    false,
    "a refused permission was reported as granted",
  );
});

test("malformed generic messages are refused without disturbing bindings", async () => {
  const tabs = new Map([[11, "https://llm.test/c/1"]]);
  const { provider } = await loadProvider(tabs);
  await provider.handleGenericContentMessage(registerMessage("https://llm.test"), sender(11, "https://llm.test/c/1"));
  const before = provider.genericRegistrations().length;

  for (const hostile of [
    undefined,
    null,
    "BACHATA_GENERIC_REGISTER",
    { type: "BACHATA_GENERIC_REGISTER" },
    { type: "BACHATA_GENERIC_REGISTER", origin: "not a url" },
    { type: "BACHATA_GENERIC_REGISTER", origin: "javascript:alert(1)", url: "javascript:alert(1)" },
    { type: "BACHATA_UNKNOWN", origin: "https://llm.test" },
    registerMessage("https://llm.test", { documentToken: "" }),
  ]) {
    const outcome = await provider.handleGenericContentMessage(hostile, sender(11, "https://llm.test/c/1"));
    assert.equal(outcome, false, `hostile input was accepted: ${JSON.stringify(hostile)}`);
  }
  assert.equal(
    provider.genericRegistrations().length,
    before,
    "hostile input changed the set of bound conversations",
  );
});

test("context menus are rebuilt rather than duplicated", async () => {
  const { provider, chrome } = await loadProvider(new Map());
  await provider.registerGenericContextMenus();
  await provider.registerGenericContextMenus();
  assert.ok(chrome.removed.length >= 1, "context menus were added without clearing the previous set");
  assert.ok(chrome.contextMenus.length >= 1, "no context menu was registered");
});

// BB-3. The generic content script patched history.pushState in the isolated world, where the
// page's own calls never reach it, so a same-origin route change during a submitted request
// went unobserved. The replacement is an href poll plus the real cross-world events.
test("the generic navigation observer notices a pushState-style route change", async () => {
  const source = await readFile(
    new URL("../src/content/generic/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    /history\.pushState\s*=/u.test(source),
    false,
    "the isolated-world history patch is back; page navigations do not reach it",
  );
  // N1. The 250 ms href poll is gone: Chrome's `webNavigation` events are the authority now,
  // and a permanent interval in a content script is also what made this entry impossible to
  // drive in a test. popstate and hashchange stay as the immediate local signal — they are real
  // events that cross into an isolated world, and they cost nothing when nothing navigates.
  assert.doesNotMatch(source, /setInterval\(/u);
  assert.match(source, /addEventListener\("popstate", changedSoon\)/u);
  assert.match(source, /addEventListener\("hashchange", changedSoon\)/u);

  // Behavioural: the observer's own logic must fire on a URL change with no event at all,
  // which is exactly the pushState case the patch used to miss.
  let href = "https://llm.test/chat/a";
  let advanced = 0;
  let lastUrl = href;
  const changed = () => {
    if (href === lastUrl) return;
    lastUrl = href;
    advanced += 1;
  };
  changed();
  assert.equal(advanced, 0, "an unchanged URL advanced the document revision");
  href = "https://llm.test/chat/b";
  changed();
  assert.equal(advanced, 1, "a silent route change did not advance the document revision");
  changed();
  assert.equal(advanced, 1, "the same route change advanced the revision twice");
});

// BB-12. Registration read the top-level tab URL and never checked which frame sent the
// message, while senderHttpOrigin in the same module already required this extension and the
// main frame. allFrames:false makes a subframe unreachable today, but the two paths must not
// disagree about what a trusted sender is.
test("registration refuses a sender the profile store would also refuse", async () => {
  await loadProvider(new Map([[23, "https://llm.test/c/1"]]));
  const message = registerMessage("https://llm.test");

  const foreignExtension = await provider.handleGenericContentMessage(message, {
    id: "some-other-extension",
    frameId: 0,
    tab: { id: 21, url: "https://llm.test/c/1" },
  });
  assert.equal(foreignExtension, false, "a message from another extension registered a tab");

  const subframe = await provider.handleGenericContentMessage(message, {
    id: "bachata-bridge-test",
    frameId: 3,
    tab: { id: 22, url: "https://llm.test/c/1" },
  });
  assert.equal(subframe, false, "a subframe registered under the top-level origin");

  assert.equal(provider.genericRegistrations().length, 0, "a refused sender still bound a tab");

  const mainFrame = await provider.handleGenericContentMessage(
    message,
    sender(23, "https://llm.test/c/1"),
  );
  assert.equal(mainFrame, true, "the main frame was refused");
  assert.equal(provider.genericRegistrations().length, 1);
});

test("registration keys the origin to the sending frame, not the tab", async () => {
  await loadProvider(new Map([[31, "https://llm.test/c/9"]]));
  // sender.url is the frame's own URL and takes precedence over the tab's.
  const outcome = await provider.handleGenericContentMessage(
    registerMessage("https://llm.test"),
    { id: "bachata-bridge-test", frameId: 0, url: "https://llm.test/c/9", tab: { id: 31, url: "https://other.test/x" } },
  );
  assert.equal(outcome, true);
  assert.equal(provider.genericRegistrations()[0].origin, "https://llm.test");
});

// BB-AUD-10. Three best-effort paths whose contract is "the caller carries on with what it
// could prove", and which therefore have to be exercised rather than assumed.

const storedRegistration = (overrides = {}) => ({
  tabId: 11,
  frameId: 0,
  origin: "https://llm.test",
  url: "https://llm.test/c/1",
  title: "conversation",
  documentRevision: 1,
  documentToken: "0123456789abcdef0123",
  registeredAt: 1,
  ...overrides,
});

// The loader clears bindings, which rewrites the stored list, so the record under test is
// seeded after that rather than through the initial store.
const seedStoredRegistration = async (tabUrl, record = storedRegistration()) => {
  const loaded = await loadProvider(new Map([[11, tabUrl]]));
  loaded.chrome.sessionStore.set("bachataGenericRegistrations.v1", [record]);
  return loaded;
};

test("a stored registration is restored only while its tab still proves the origin", async () => {
  const restored = await seedStoredRegistration("https://llm.test/c/2");
  await restored.provider.restoreGenericRegistrations();
  assert.deepEqual(
    restored.provider.genericRegistrations().map((entry) => entry.origin),
    ["https://llm.test"],
  );

  const moved = await seedStoredRegistration("https://other.test/c/1");
  await moved.provider.restoreGenericRegistrations();
  assert.deepEqual(
    moved.provider.genericRegistrations(),
    [],
    "a tab that moved origin kept a binding granted for the old one",
  );
});

test("a tab whose current URL will not parse is left unrestored", async () => {
  const { provider } = await seedStoredRegistration("not a url");
  await provider.restoreGenericRegistrations();
  assert.deepEqual(
    provider.genericRegistrations(),
    [],
    "an unprovable tab URL restored a binding anyway",
  );
});

test("a status probe that cannot be delivered still injects the content script", async () => {
  const { provider, chrome } = await loadProvider(new Map([[11, "https://llm.test/c/1"]]), {
    sendFails: true,
  });
  await provider.ensureGenericContentScript(11);
  assert.deepEqual(chrome.executed, [11], "a failed probe skipped injection");
});

test("a registration URL the page cannot form leaves the browser's own tab URL standing", async () => {
  const { provider } = await loadProvider(new Map([[11, "https://llm.test/c/1"]]));
  await provider.handleGenericContentMessage(
    registerMessage("https://llm.test", { url: "not a url" }),
    sender(11, "https://llm.test/c/1"),
  );
  assert.deepEqual(
    provider.genericRegistrations().map((entry) => entry.url),
    ["https://llm.test/c/1"],
  );
});

test("a registration URL from another origin never replaces the tab URL", async () => {
  const { provider } = await loadProvider(new Map([[11, "https://llm.test/c/1"]]));
  await provider.handleGenericContentMessage(
    registerMessage("https://llm.test", { url: "https://other.test/c/9" }),
    sender(11, "https://llm.test/c/1"),
  );
  assert.deepEqual(
    provider.genericRegistrations().map((entry) => entry.url),
    ["https://llm.test/c/1"],
  );
});

test("removed and concurrently edited profiles reject stale repairs without resurrecting bindings", async () => {
  const origin = "https://llm.test";
  const key = `bachata.generic.profile.${origin}`;
  const original = storedProfile(origin);
  const { chrome, provider } = await loadProvider(new Map(), { local: { [key]: original } });
  const storageSender = sender(11, `${origin}/private/conversation`);
  const storage = (message) => provider.handleGenericProfileStorageMessage(message, storageSender);
  const snapshot = await storage({ type: "BACHATA_GENERIC_PROFILE_LIST" });
  assert.deepEqual(snapshot.value, [original], "legacy single-profile storage stays readable");
  const write = {
    type: "BACHATA_GENERIC_PROFILE_UPSERT",
    profile: { ...original, documentRevision: 2 },
    expectedTargetHash: snapshot.fingerprints[0],
    expectedSource: { routePattern: original.routePattern, fingerprint: snapshot.fingerprints[0] },
  };
  const updated = await storage(write);
  assert.equal(updated.ok, true);
  assert.notEqual(updated.fingerprint, snapshot.fingerprints[0]);
  const staleEdit = await storage({ ...write, profile: { ...original, documentRevision: 3 } });
  assert.equal(staleEdit.ok, false);
  assert.match(staleEdit.error, /changed or was removed/);
  assert.equal(chrome.localStore.get(key).profiles[0].documentRevision, 2);
  await provider.handleGenericManagementMessage({ action: "remove", origin, id: updated.fingerprint }, popupSender, () => false);
  const delayed = await storage(write);
  assert.equal(delayed.ok, false);
  assert.equal(chrome.localStore.has(key), false);
  const adoption = await storage({ ...write, profile: { ...original, routePattern: "/new-route" }, expectedTargetHash: null });
  assert.equal(adoption.ok, false, "deleted source cannot be adopted into a new route");
  assert.equal(chrome.localStore.has(key), false);
  const rebound = await storage({ type: "BACHATA_GENERIC_PROFILE_UPSERT", profile: original, expectedTargetHash: null });
  assert.equal(rebound.ok, true, "a fresh explicit binding can be created after removal");
});

test("conditional profile writes preserve unrelated routes and refuse missing or malformed versions", async () => {
  const origin = "https://llm.test";
  const { chrome, provider } = await loadProvider(new Map());
  const storage = (message) => provider.handleGenericProfileStorageMessage(message, sender(11, `${origin}/chat`));
  const original = storedProfile(origin, "/first");
  for (const fields of [{}, { expectedTargetHash: "bad" }, { expectedTargetHash: null, expectedSource: [] }]) {
    assert.equal((await storage({ type: "BACHATA_GENERIC_PROFILE_UPSERT", profile: original, ...fields })).ok, false);
  }
  assert.equal(chrome.localStore.size, 0);
  const first = await storage({ type: "BACHATA_GENERIC_PROFILE_UPSERT", profile: original, expectedTargetHash: null });
  assert.equal(first.ok, true);
  assert.equal((await storage({ type: "BACHATA_GENERIC_PROFILE_UPSERT", profile: storedProfile(origin, "/second"), expectedTargetHash: null })).ok, true);
  assert.equal((await storage({ type: "BACHATA_GENERIC_PROFILE_UPSERT", profile: { ...original, documentRevision: 2 }, expectedTargetHash: first.fingerprint,
    expectedSource: { routePattern: "/first", fingerprint: first.fingerprint } })).ok, true);
  const listed = await storage({ type: "BACHATA_GENERIC_PROFILE_LIST" });
  assert.equal(listed.value.length, 2);
  assert.equal(listed.value.find((entry) => entry.routePattern === "/second").documentRevision, 1);
});

test("revoking access blocks an already injected page from registering or sending", async () => {
  const origin = "https://llm.test";
  const options = { permissionGranted: true };
  const { provider, chrome } = await loadProvider(new Map([[11, `${origin}/chat`]]), options);
  assert.equal(await provider.handleGenericContentMessage(registerMessage(origin), sender(11, `${origin}/chat`)), true);
  const registration = provider.genericRegistrations()[0];
  await provider.handleGenericManagementMessage({ action: "revoke", origin, confirmed: true }, popupSender, () => false);
  assert.equal(await provider.handleGenericContentMessage(registerMessage(origin), sender(11, `${origin}/chat`)), false);
  assert.equal(provider.genericRegistrations().length, 0);
  chrome.sessionStore.set("bachataGenericRegistrations.v1", [registration]);
  await provider.restoreGenericRegistrations();
  assert.equal(provider.genericRegistrations().length, 0);
  await assert.rejects(provider.sendGenericCommand(11, { type: "BACHATA_GENERIC_SEND", prompt: "never sent" }, { ensureContent: false }), /access is unavailable/);
  assert.equal(chrome.messages.some(({ message }) => message.type === "BACHATA_GENERIC_SEND"), false);
});
