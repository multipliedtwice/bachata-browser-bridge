import { profileIdentity } from "../dist/background/profileIdentity.js";
import assert from "node:assert/strict";
import test from "node:test";

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const profiles = new Map();
const storage = new Map();
const requests = [];

const chromeStub = () => ({
  runtime: {
    sendMessage: async (message) => {
      requests.push(message);
      if (message.type === "BACHATA_GENERIC_PROFILE_LIST") {
        const value = [...profiles.values()];
        return { ok: true, value, fingerprints: await Promise.all(value.map(profileIdentity)) };
      }
      if (message.type === "BACHATA_GENERIC_PROFILE_UPSERT") {
        profiles.set(message.profile.routePattern ?? "*", message.profile);
        return { ok: true, fingerprint: await profileIdentity(message.profile) };
      }
      if (message.type === "BACHATA_GENERIC_PROFILE_CLEAR") {
        profiles.clear();
        return { ok: true };
      }
      return { ok: false, error: "unsupported" };
    },
  },
  storage: {
    local: {
      // Matches the real surface: null returns every item, and remove takes one key or many.
      get: async (key) => {
        if (key === null || key === undefined) return Object.fromEntries(storage);
        if (Array.isArray(key)) {
          return Object.fromEntries(key.filter((entry) => storage.has(entry)).map((entry) => [entry, storage.get(entry)]));
        }
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      set: async (values) => {
        Object.entries(values).forEach(([key, value]) => storage.set(key, value));
      },
      remove: async (key) => {
        for (const entry of Array.isArray(key) ? key : [key]) storage.delete(entry);
      },
    },
  },
});

setGlobal("location", { origin: "https://llm.test", pathname: "/", search: "", hash: "" });
setGlobal("chrome", chromeStub());

const profile = await import("../dist/content/generic/bindingProfile.js");

const at = (pathname, search = "", hash = "") => {
  setGlobal("location", { origin: "https://llm.test", pathname, search, hash });
};

const recipe = (tag, attributes = {}) => ({
  tag,
  stableAttributes: attributes,
  structuralPath: [0, 1],
});

const boundProfile = (overrides = {}) => ({
  protocol: "bachata-generic-binding-v1",
  origin: "https://llm.test",
  routePattern: "/chat/*",
  framePath: [],
  composer: recipe("textarea", { "data-testid": "composer" }),
  conversationRoot: recipe("main"),
  sendButton: recipe("button", { "aria-label": "Send" }),
  createdBy: "user",
  bindingSources: { composer: "user", conversationRoot: "user" },
  validated: true,
  consecutiveFailures: 0,
  documentRevision: 3,
  ...overrides,
});

const reset = () => {
  profiles.clear();
  storage.clear();
  requests.length = 0;
  setGlobal("chrome", chromeStub());
};

test("the current route includes path, query and fragment", () => {
  at("/chat/42", "?mode=fast", "#top");
  assert.equal(profile.currentRouteValue(), "/chat/42?mode=fast#top");
  at("", "", "");
  assert.equal(profile.currentRouteValue(), "/", "an empty path did not fall back to root");
});

test("a route pattern matches only what it was written for", () => {
  assert.equal(profile.routePatternMatches("/chat/*", "/chat/42"), true);
  assert.equal(profile.routePatternMatches("/chat/*", "/chats/42"), false);
  assert.equal(profile.routePatternMatches("/chat/42", "/chat/42"), true);
  assert.equal(profile.routePatternMatches("/chat/42", "/chat/43"), false);
  // A pattern is not a regular expression: its metacharacters are literal.
  assert.equal(profile.routePatternMatches("/chat/.+", "/chat/42"), false);
  assert.equal(profile.routePatternMatches("/chat/.+", "/chat/.+"), true);
});

test("an empty or missing pattern never matches", () => {
  assert.equal(profile.routePatternMatches(undefined, "/chat/42"), false);
  assert.equal(profile.routePatternMatches("", "/chat/42"), false);
  assert.equal(profile.routePatternMatches("   ", "/chat/42"), false);
});

test("a dynamic conversation id is generalised, and a stable path is not", () => {
  at("/chat/1234567");
  assert.equal(profile.currentRoutePattern(), "/chat/*", "a numeric id was not generalised");

  at("/chat/0a1b2c3d-4e5f-6a7b-8c9d");
  assert.equal(profile.currentRoutePattern(), "/chat/*", "a uuid-like id was not generalised");

  at("/chat/abcdefghijklmnopqrstuvwx");
  assert.equal(profile.currentRoutePattern(), "/chat/*", "a long opaque id was not generalised");

  at("/settings/profile");
  assert.equal(
    profile.currentRoutePattern(),
    "/settings/profile",
    "a stable path was wrongly generalised into a wildcard",
  );

  at("/chat/");
  assert.equal(profile.currentRoutePattern(), "/chat/", "a trailing slash was generalised");
});

test("the pattern keeps the query and fragment that identify the view", () => {
  at("/chat/1234567", "?mode=fast", "#latest");
  assert.equal(profile.currentRoutePattern(), "/chat/*?mode=fast#latest");
});

test("a saved binding comes back for its own route and not another", async () => {
  reset();
  at("/chat/1234567");
  await profile.saveBindingProfile(boundProfile());
  const upsert = requests.find((entry) => entry.type === "BACHATA_GENERIC_PROFILE_UPSERT");
  assert.ok(upsert, "saving a binding sent no storage request");
  assert.equal(upsert.profile.routePattern, "/chat/*");

  assert.equal((await profile.loadBindingProfile())?.composer.tag, "textarea");

  at("/settings/profile");
  assert.equal(
    await profile.loadBindingProfile(),
    undefined,
    "a binding recorded for the conversation route was reused on an unrelated page",
  );
});

test("an exact route beats a wildcard, and an unvalidated binding is never used blind", async () => {
  reset();
  at("/chat/1234567");
  await profile.saveBindingProfile(boundProfile({
    routePattern: "/chat/*",
    composer: recipe("textarea", { "data-testid": "wildcard" }),
  }));
  await profile.saveBindingProfile(boundProfile({
    routePattern: "/chat/1234567",
    composer: recipe("textarea", { "data-testid": "exact" }),
  }));
  assert.equal(
    (await profile.loadBindingProfile())?.composer.stableAttributes["data-testid"],
    "exact",
    "the wildcard binding won over the binding recorded for this exact route",
  );

  reset();
  at("/chat/1234567");
  await profile.saveBindingProfile(boundProfile({ validated: false }));
  assert.equal(
    await profile.loadBindingProfile(),
    undefined,
    "an unvalidated binding was returned as if it had been proven",
  );
  assert.equal(
    (await profile.loadUnvalidatedBindingProfile())?.composer.tag,
    "textarea",
    "an unvalidated binding was not offered even where being unproven is expected",
  );
});

test("a binding for another origin is refused rather than stored", async () => {
  reset();
  at("/chat/1234567");
  const failure = await profile
    .saveBindingProfile(boundProfile({ origin: "https://other.test" }))
    .then(() => undefined, (error) => error);
  assert.ok(failure, "a binding recorded on another site was accepted for this one");
  assert.match(String(failure.message), /origin does not match/u);
  assert.equal(profiles.size, 0);
});

test("a draft becomes a binding only once both required roles are bound", async () => {
  reset();
  at("/chat/1234567");
  assert.equal(
    await profile.saveBindingDraftRole("composer", recipe("textarea"), 4),
    undefined,
    "a half-bound draft was promoted to a binding",
  );
  assert.equal(profiles.size, 0, "a half-bound draft was stored as a binding");
  assert.equal((await profile.loadBindingDraft())?.composer.tag, "textarea");

  const created = await profile.saveBindingDraftRole("conversationRoot", recipe("main"), 4);
  assert.ok(created, "binding the conversation root did not produce a binding");
  assert.equal(created.validated, false, "a fresh binding claimed to be proven");
  assert.equal(created.documentRevision, 4);
  assert.deepEqual(created.bindingSources, { composer: "user", conversationRoot: "user" });
  assert.equal(
    await profile.loadBindingDraft(),
    undefined,
    "the draft survived the binding it produced",
  );
});

test("a draft recorded against an older document is not merged into the new one", async () => {
  reset();
  at("/chat/1234567");
  await profile.saveBindingDraftRole("composer", recipe("textarea", { "data-testid": "old" }), 4);
  // The page reloaded: the earlier draft describes a document that no longer exists.
  const created = await profile.saveBindingDraftRole("composer", recipe("textarea", { "data-testid": "new" }), 5);
  assert.equal(created, undefined, "a stale draft was completed into a binding");
  const draft = await profile.loadBindingDraft();
  assert.equal(draft.documentRevision, 5);
  assert.equal(draft.composer.stableAttributes["data-testid"], "new");
  assert.equal(draft.conversationRoot, undefined, "a stale role survived the document change");
});

test("an auto-healed draft is recorded as auto-healed, not as the human's own binding", async () => {
  reset();
  at("/chat/1234567");
  await profile.saveBindingDraftRole("composer", recipe("textarea"), 6, "autoHeal");
  const created = await profile.saveBindingDraftRole("conversationRoot", recipe("main"), 6, "autoHeal");
  assert.equal(created.createdBy, "autoHeal");
  assert.deepEqual(created.bindingSources, { composer: "autoHeal", conversationRoot: "autoHeal" });
});

test("validation records success, and repeated failure retires the binding", async () => {
  reset();
  at("/chat/1234567");
  const validated = await profile.markProfileValidation(boundProfile({ validated: false }), true, 7);
  assert.equal(validated.validated, true);
  assert.equal(validated.consecutiveFailures, 0);
  assert.equal(validated.documentRevision, 7);
  assert.ok(validated.lastSuccessfulAt, "a proven binding recorded no success time");

  let current = validated;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    current = await profile.markProfileValidation(current, false, 7);
    assert.equal(current.consecutiveFailures, attempt);
    assert.equal(current.validated, true, `a binding was retired after ${String(attempt)} failure(s)`);
  }
  current = await profile.markProfileValidation(current, false, 7);
  assert.equal(current.consecutiveFailures, 5);
  assert.equal(current.validated, false, "a binding that failed five times in a row stayed proven");
});

test("a single failure retires the binding when the caller proved it is wrong", async () => {
  reset();
  at("/chat/1234567");
  const retired = await profile.markProfileValidation(boundProfile(), false, 8, true);
  assert.equal(retired.validated, false);
  assert.equal(retired.consecutiveFailures, 1);
});

test("lifecycle evidence does not survive a binding whose route moved", async () => {
  reset();
  at("/chat/1234567");
  const evidence = {
    stopControlObservedAt: new Date().toISOString(),
    stopControlFingerprint: JSON.stringify(recipe("button", { "aria-label": "Send" })),
    stopControlRoutePattern: "/chat/*",
    lifecycleCompletedAt: new Date().toISOString(),
    lifecycleCompletedFingerprint: JSON.stringify(recipe("button", { "aria-label": "Send" })),
    lifecycleCompletedRoutePattern: "/chat/*",
  };
  const kept = await profile.markProfileValidation(boundProfile(evidence), true, 9);
  assert.equal(kept.stopControlObservedAt, evidence.stopControlObservedAt, "evidence was dropped on the route it was recorded for");

  // The same binding now proves itself on a different route: the older lifecycle evidence
  // describes controls on a page this binding no longer points at.
  at("/thread/9876543");
  const moved = await profile.markProfileValidation(boundProfile(evidence), true, 9);
  assert.equal(moved.routePattern, "/thread/*", "a proven binding kept a route it no longer matches");
  assert.equal(moved.stopControlObservedAt, undefined, "stale Stop-control evidence survived a route change");
  assert.equal(moved.lifecycleCompletedAt, undefined, "stale lifecycle evidence survived a route change");
});

test("a failed validation drops lifecycle evidence rather than carrying it forward", async () => {
  reset();
  at("/chat/1234567");
  const failed = await profile.markProfileValidation(boundProfile({
    stopControlObservedAt: new Date().toISOString(),
    stopControlFingerprint: JSON.stringify(recipe("button", { "aria-label": "Send" })),
    stopControlRoutePattern: "/chat/*",
  }), false, 9);
  assert.equal(failed.stopControlObservedAt, undefined, "evidence survived a validation that failed");
});

test("clearing a binding asks storage to clear and leaves nothing behind", async () => {
  reset();
  at("/chat/1234567");
  await profile.saveBindingProfile(boundProfile());
  assert.equal(profiles.size, 1);
  await profile.clearBindingProfile();
  assert.equal(profiles.size, 0, "clearing a binding left it stored");
});

test("a storage failure is surfaced, never silently treated as no binding", async () => {
  reset();
  setGlobal("chrome", {
    runtime: { sendMessage: async () => ({ ok: false, error: "storage refused" }) },
  });
  const failure = await profile.loadBindingProfiles().then(() => undefined, (error) => error);
  assert.ok(failure, "a storage failure was reported as an empty binding set");
  assert.match(String(failure.message), /storage refused/u);

  setGlobal("chrome", { runtime: { sendMessage: async () => undefined } });
  const silent = await profile.loadBindingProfiles().then(() => undefined, (error) => error);
  assert.match(String(silent.message), /binding storage request failed/u);
});

test("a stored value that is not a binding is ignored rather than trusted", async () => {
  reset();
  at("/chat/1234567");
  profiles.set("/chat/*", { protocol: "bachata-generic-binding-v1", origin: "https://llm.test" });
  profiles.set("other", boundProfile({ origin: "https://other.test", routePattern: "/chat/x" }));
  assert.deepEqual(await profile.loadBindingProfiles(), [], "a malformed stored binding was returned as usable");
});

// BB-8. A draft only becomes a profile once every required role is bound, so an abandoned one
// was never completed and never removed. Each origin and route kept its own indefinitely.
test("an abandoned binding draft expires instead of accumulating", async () => {
  reset();
  at("/chat/new");
  const { loadBindingDraft, saveBindingDraftRole } = profile;
  const fresh = await loadBindingDraft();
  assert.equal(fresh, undefined, "no draft should exist before one is written");

  await saveBindingDraftRole("composer", recipe("textarea", { "data-testid": "composer" }), 1);
  const stored = await loadBindingDraft();
  assert.ok(stored, "a freshly written draft is readable");
  assert.equal(typeof stored.updatedAt, "number", "a draft must record when it was written");

  const keys = Object.keys(await chrome.storage.local.get(null))
    .filter((key) => key.startsWith("bachata.generic.draft."));
  assert.equal(keys.length, 1);
  // Age it past the window and prove the next load both hides and removes it.
  const aged = await chrome.storage.local.get(keys[0]);
  await chrome.storage.local.set({
    [keys[0]]: { ...aged[keys[0]], updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
  });
  assert.equal(await loadBindingDraft(), undefined, "an expired draft was still returned");
  assert.equal(
    Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith("bachata.generic.draft.")).length,
    0,
    "an expired draft was left in storage",
  );
});

test("a draft written before expiry tracking is discarded rather than trusted", async () => {
  reset();
  at("/chat/new");
  await chrome.storage.local.set({
    "bachata.generic.draft.https://llm.test:%2Fchat%2F*": {
      documentRevision: 1,
      createdBy: "user",
      bindingSources: {},
    },
  });
  assert.equal(await profile.loadBindingDraft(), undefined, "a draft with no timestamp was trusted");
});

// Seeding a draft from an already-saved profile: binding one more role when a profile exists
// and the document has since re-rendered carries the previously bound roles forward.
test("a new draft is seeded from the saved profile when the document revision moved", async () => {
  reset();
  at("/chat/new");
  profiles.set("/chat/*", boundProfile({ validated: false, routePattern: "/chat/*" }));

  const saved = await profile.saveBindingDraftRole(
    "stopButton",
    recipe("button", { "aria-label": "Stop" }),
    99,
  );
  assert.ok(saved, "binding the last required role did not produce a profile");
  assert.equal(saved.documentRevision, 99);
  assert.equal(saved.composer.tag, "textarea", "the composer bound earlier was lost");
  assert.equal(saved.conversationRoot.tag, "main", "the conversation root bound earlier was lost");
  assert.equal(saved.stopButton.stableAttributes["aria-label"], "Stop");
  assert.equal(saved.bindingSources.stopButton, "user");
});

// The stale-draft sweep is housekeeping, not a precondition: if storage enumeration fails the
// caller must still get its draft rather than an error from a cleanup step.
test("a failing draft sweep does not break reading the draft", async () => {
  reset();
  at("/chat/new");
  await profile.saveBindingDraftRole("composer", recipe("textarea", { "data-testid": "composer" }), 4);

  const stub = globalThis.chrome;
  const originalGet = stub.storage.local.get;
  stub.storage.local.get = async (key) => {
    if (key === null || key === undefined) throw new Error("storage enumeration failed");
    return await originalGet(key);
  };
  try {
    const draft = await profile.loadBindingDraft();
    assert.ok(draft, "a failed sweep swallowed the draft");
    assert.equal(draft.documentRevision, 4);
  } finally {
    stub.storage.local.get = originalGet;
  }
});

// BB-AUD-09. `exactOptionalPropertyTypes` turned four direct assignments into conditional
// spreads, one per optional role. The shared fixture always carries `sendButton` and never
// the other three, so only one side of each was ever taken. This is the complementary
// shape: it seeds from a profile with the other three bound and no send button, which
// reaches the four sides the fixture cannot.
test("a draft seeded from a profile carries whichever optional roles it has", async () => {
  reset();
  at("/chat/new");
  profiles.set("/chat/*", boundProfile({
    validated: false,
    routePattern: "/chat/*",
    sendButton: undefined,
    stopButton: recipe("button", { "aria-label": "Stop" }),
    newConversationButton: recipe("button", { "aria-label": "New" }),
    responseMessage: recipe("article", { "data-role": "assistant" }),
  }));

  const saved = await profile.saveBindingDraftRole(
    "sendButton",
    recipe("button", { "aria-label": "Send" }),
    120,
  );

  assert.ok(saved, "binding the last required role did not produce a profile");
  assert.equal(saved.documentRevision, 120);
  assert.equal(saved.sendButton.stableAttributes["aria-label"], "Send");
  assert.equal(
    saved.stopButton.stableAttributes["aria-label"],
    "Stop",
    "an optional role the profile carried was dropped",
  );
  assert.equal(saved.newConversationButton.stableAttributes["aria-label"], "New");
  assert.equal(saved.responseMessage.stableAttributes["data-role"], "assistant");
});

test("a draft seeded from a profile omits optional roles it does not have", async () => {
  reset();
  at("/chat/new");
  profiles.set("/chat/*", boundProfile({
    validated: false,
    routePattern: "/chat/*",
    sendButton: undefined,
    stopButton: undefined,
    newConversationButton: undefined,
    responseMessage: undefined,
  }));

  const saved = await profile.saveBindingDraftRole(
    "sendButton",
    recipe("button", { "aria-label": "Send" }),
    121,
  );

  assert.ok(saved);
  // The guarantee is that no binding is invented for a role the profile never had — not
  // that the key is absent, which the fixture's own spread decides rather than the code.
  for (const role of ["stopButton", "newConversationButton", "responseMessage"]) {
    assert.equal(saved[role], undefined, `${role} was given a binding it never had`);
  }
  assert.equal(saved.sendButton.stableAttributes["aria-label"], "Send");
});

test("profile edits retain the originally read source and target versions across route adoption", async () => {
  reset();
  at("/chat/1234567");
  const original = boundProfile();
  await profile.saveBindingProfile(original);
  const loaded = await profile.loadBindingProfile();
  const fingerprint = await profileIdentity(loaded);
  const adopted = { ...loaded, routePattern: "/new-chat" };
  await profile.saveBindingProfile(adopted, loaded);
  const write = requests.at(-1);
  assert.equal(write.expectedTargetHash, null);
  assert.deepEqual(write.expectedSource, { routePattern: "/chat/*", fingerprint });
  await profile.markProfileValidation(adopted, true, 4);
  const next = requests.at(-1);
  assert.equal(next.expectedSource.routePattern, "/new-chat");
  assert.equal(next.expectedSource.fingerprint, await profileIdentity(adopted));
});

test("a profile list without trustworthy versions cannot enable editing", async () => {
  reset();
  for (const fingerprints of [undefined, [], ["bad"]]) {
    globalThis.chrome.runtime.sendMessage = async () => ({ ok: true, value: [boundProfile()], fingerprints });
    await assert.rejects(profile.loadBindingProfiles(), /versions are unavailable/);
  }
});

test("navigation during draft reads cannot save a chosen control onto another route", async () => {
  reset();
  at("/chat/first");
  const sendMessage = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (message) => {
    const result = await sendMessage(message);
    if (message.type === "BACHATA_GENERIC_PROFILE_LIST") at("/settings");
    return result;
  };
  await assert.rejects(profile.saveBindingDraftRole("composer", recipe("textarea"), 4), /page changed/);
  assert.equal(storage.size, 0);
  assert.equal(requests.some((message) => message.type === "BACHATA_GENERIC_PROFILE_UPSERT"), false);
});

test("navigation during a draft write cannot promote it on the new page", async () => {
  reset();
  at("/chat/first");
  profiles.set("/chat/*", boundProfile());
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (values) => { await set(values); at("/settings"); };
  await assert.rejects(profile.saveBindingDraftRole("sendButton", recipe("button"), 4), /page changed/);
  assert.equal(requests.some((message) => message.type === "BACHATA_GENERIC_PROFILE_UPSERT"), false);
  assert.equal([...storage.keys()].some((key) => key.includes("settings")), false);
});

test("navigation during profile commit preserves the next page's draft", async () => {
  reset();
  at("/chat/first");
  profiles.set("/chat/*", boundProfile());
  const nextKey = "bachata.generic.draft.https://llm.test:%2Fsettings";
  const nextDraft = { composer: recipe("input"), documentRevision: 5, updatedAt: Date.now() };
  const sendMessage = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (message) => {
    const result = await sendMessage(message);
    if (message.type === "BACHATA_GENERIC_PROFILE_UPSERT") {
      at("/settings");
      storage.set(nextKey, nextDraft);
    }
    return result;
  };
  await assert.rejects(profile.saveBindingDraftRole("sendButton", recipe("button"), 4), /page changed/);
  assert.equal(storage.get(nextKey), nextDraft);
  assert.equal(profiles.has("/settings"), false);
  assert.equal(requests.at(-1).profile.routePattern, "/chat/first");
});

test("an origin change during the initial draft read stops the save before profile access", async () => {
  reset();
  at("/chat/first");
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async (key) => {
    const result = await get(key);
    location.origin = "https://other.test";
    return result;
  };
  await assert.rejects(profile.saveBindingDraftRole("composer", recipe("textarea"), 4), /page changed/);
  assert.deepEqual(requests, []);
  assert.equal(storage.size, 0);
});
