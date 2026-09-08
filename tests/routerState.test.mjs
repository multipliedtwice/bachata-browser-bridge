import assert from "node:assert/strict";
import test from "node:test";

import * as routerState from "../dist/background/routerState.js";

import {
  activeRequestMatchesSender,
  admitInitialTransition,
  bindingMatchesSession,
  interruptMatchesRequest,
  legacyStorageKeys,
  migratedStoredCandidate,
  normalizedHandledTabIds,
  popupStatusReason,
  providerStartUrl,
  sameDocumentBinding,
  senderBinding,
  sessionIdFor,
  storageKey,
  storedStateFrom,
  withHandledTabs,
  withoutHandledTab,
} from "../dist/background/routerState.js";

// BB-AUD-09. These two decisions used to live inside the 3,200-line service-worker entry,
// where a test could only reach them by loading the whole worker and driving it through the
// extension APIs. Every branch below was previously exercised, if at all, by accident.

const binding = (overrides = {}) => ({
  requestId: "r-1",
  agentId: "agent-1",
  provider: "chatgpt",
  sessionId: "session-1",
  tabId: 7,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "token-1",
  conversationUrl: "https://chatgpt.com/c/abc",
  conversationIdentity: "abc",
  ...overrides,
});

const activeRequest = (overrides = {}) => ({
  ...binding(),
  allowInitialConversationTransition: false,
  deadlineAt: 0,
  transitionUsed: false,
  initialConversationUrl: "https://chatgpt.com/c/abc",
  ...overrides,
});

const interrupt = (overrides = {}) => ({
  type: "conversation.interrupt",
  protocolVersion: 9,
  ...binding(),
  ...overrides,
});

test("an interrupt naming exactly the running request matches", () => {
  assert.equal(interruptMatchesRequest(interrupt(), activeRequest()), true);
});

// An interrupt that matched loosely would stop a different turn than the user asked to stop,
// so every identity field is load-bearing and gets its own case.
test("an interrupt differing in any identity field does not match", () => {
  const fields = {
    agentId: "agent-2",
    provider: "claude",
    sessionId: "session-2",
    tabId: 8,
    frameId: 1,
    documentId: "doc-2",
    documentToken: "token-2",
    conversationIdentity: "def",
  };
  for (const [field, value] of Object.entries(fields)) {
    assert.equal(
      interruptMatchesRequest(interrupt({ [field]: value }), activeRequest()),
      false,
      `${field} was ignored when matching an interrupt`,
    );
  }
});

test("the conversation URL is compared canonically, not literally", () => {
  // A provider URL carrying a query still names the same conversation.
  assert.equal(
    interruptMatchesRequest(
      interrupt({ conversationUrl: "https://chatgpt.com/c/abc?model=x" }),
      activeRequest(),
    ),
    true,
  );
  assert.equal(
    interruptMatchesRequest(
      interrupt({ conversationUrl: "https://chatgpt.com/c/other" }),
      activeRequest(),
    ),
    false,
  );
});

// BR-G6-04. The accepted first-turn transition rewrites the request's dispatch binding, but
// the controller's authorization still names the conversation it sent. Refusing its Stop as
// "no longer active" leaves a running turn nothing can stop.
test("after an accepted transition a Stop naming the authorized conversation still matches", () => {
  const transitioned = activeRequest({
    transitionUsed: true,
    initialConversationUrl: "https://chatgpt.com/",
    conversationUrl: "https://chatgpt.com/c/abc",
    conversationIdentity: "chatgpt:https://chatgpt.com/c/abc",
  });
  assert.equal(
    interruptMatchesRequest(
      interrupt({
        conversationUrl: "https://chatgpt.com/",
        conversationIdentity: "chatgpt:https://chatgpt.com/",
      }),
      transitioned,
    ),
    true,
  );
  assert.equal(
    interruptMatchesRequest(
      interrupt({
        conversationUrl: "https://chatgpt.com/c/abc",
        conversationIdentity: "chatgpt:https://chatgpt.com/c/abc",
      }),
      transitioned,
    ),
    true,
    "the conversation the turn actually runs in stopped matching",
  );
  assert.equal(
    interruptMatchesRequest(
      interrupt({
        conversationUrl: "https://chatgpt.com/c/other",
        conversationIdentity: "chatgpt:https://chatgpt.com/c/other",
      }),
      transitioned,
    ),
    false,
    "a third conversation was accepted",
  );
  assert.equal(
    interruptMatchesRequest(
      interrupt({
        conversationUrl: "https://chatgpt.com/",
        conversationIdentity: "chatgpt:https://chatgpt.com/",
      }),
      activeRequest({ initialConversationUrl: "https://chatgpt.com/" }),
    ),
    false,
    "a request that never transitioned accepted a conversation it is not bound to",
  );
});

test("an unusable conversation URL matches nothing instead of throwing", () => {
  assert.equal(
    interruptMatchesRequest(interrupt({ conversationUrl: "not a url" }), activeRequest()),
    false,
  );
});

test("persisted state that is not an object yields empty state", () => {
  for (const value of [undefined, null, "", 0, [], "text"]) {
    assert.deepEqual(
      storedStateFrom(value),
      { state: {}, invalidEndpoint: false },
      `${JSON.stringify(value)} was not treated as absent state`,
    );
  }
});

test("a valid endpoint is kept and a bad one is reported, not silently dropped", () => {
  const good = storedStateFrom({ endpoint: "ws://127.0.0.1:32123/bachata-browser-bridge-v9" });
  assert.equal(good.state.endpoint, "ws://127.0.0.1:32123/bachata-browser-bridge-v9");
  assert.equal(good.invalidEndpoint, false);

  const bad = storedStateFrom({ endpoint: "ws://evil.test/bachata-browser-bridge-v9" });
  assert.equal(bad.state.endpoint, undefined);
  assert.equal(bad.invalidEndpoint, true, "a rejected endpoint must be reported to the user");

  // Absent is not invalid.
  assert.equal(storedStateFrom({}).invalidEndpoint, false);
});

test("a connection token without a usable endpoint is discarded with it", () => {
  const orphaned = storedStateFrom({ connectionToken: "secret" });
  assert.equal(orphaned.state.connectionToken, undefined, "a token addressing nothing was kept");

  const rejected = storedStateFrom({ endpoint: "ws://evil.test/x", connectionToken: "secret" });
  assert.equal(rejected.state.connectionToken, undefined);

  const kept = storedStateFrom({
    endpoint: "ws://127.0.0.1:32123/bachata-browser-bridge-v9",
    connectionToken: "  secret  ",
  });
  assert.equal(kept.state.connectionToken, "secret", "a valid token was not trimmed and kept");

  for (const token of ["", "   ", 42, null, {}]) {
    const result = storedStateFrom({
      endpoint: "ws://127.0.0.1:32123/bachata-browser-bridge-v9",
      connectionToken: token,
    });
    assert.equal(result.state.connectionToken, undefined, `${JSON.stringify(token)} was accepted`);
  }
});

test("a selected tab is accepted only as a positive integer", () => {
  assert.equal(storedStateFrom({ selectedTabId: 7 }).state.selectedTabId, 7);
  for (const value of [0, -1, 1.5, "7", null, undefined, Number.NaN]) {
    assert.equal(
      storedStateFrom({ selectedTabId: value }).state.selectedTabId,
      undefined,
      `${JSON.stringify(value)} was accepted as a tab id`,
    );
  }
});

test("a selected session is kept only alongside a selected tab", () => {
  assert.equal(
    storedStateFrom({ selectedTabId: 7, selectedSessionId: " s-1 " }).state.selectedSessionId,
    "s-1",
  );
  assert.equal(
    storedStateFrom({ selectedSessionId: "s-1" }).state.selectedSessionId,
    undefined,
    "a session id survived without the tab it belongs to",
  );
  assert.equal(
    storedStateFrom({ selectedTabId: 7, selectedSessionId: "   " }).state.selectedSessionId,
    undefined,
  );
});

test("handled tab ids are filtered, de-duplicated and ordered", () => {
  assert.deepEqual(
    storedStateFrom({ handledTabIds: [3, 1, 3, -2, 0, 2.5, "4", null, 2] }).state.handledTabIds,
    [1, 2, 3],
  );
  // An array that survives filtering to nothing is omitted rather than stored empty.
  assert.equal(storedStateFrom({ handledTabIds: [0, -1, "x"] }).state.handledTabIds, undefined);
  assert.equal(storedStateFrom({ handledTabIds: [] }).state.handledTabIds, undefined);
  assert.equal(storedStateFrom({ handledTabIds: "not an array" }).state.handledTabIds, undefined);
});

test("a fully populated record round-trips every field", () => {
  const { state, invalidEndpoint } = storedStateFrom({
    endpoint: "ws://127.0.0.1:32123/bachata-browser-bridge-v9",
    connectionToken: "token",
    selectedTabId: 5,
    selectedSessionId: "session",
    handledTabIds: [2, 1],
    unknownField: "ignored",
  });
  assert.equal(invalidEndpoint, false);
  assert.equal(state.endpoint, "ws://127.0.0.1:32123/bachata-browser-bridge-v9");
  assert.equal(state.connectionToken, "token");
  assert.equal(state.selectedTabId, 5);
  assert.equal(state.selectedSessionId, "session");
  assert.deepEqual(state.handledTabIds, [1, 2]);
  assert.equal(Object.hasOwn(state, "unknownField"), false, "an unknown field was carried through");
});

const documentBinding = (overrides = {}) => ({
  provider: "chatgpt",
  tabId: 7,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "token-1",
  conversationUrl: "https://chatgpt.com/c/abc",
  conversationIdentity: "abc",
  ...overrides,
});

test("a session id is derived from the document a binding names", () => {
  const first = sessionIdFor(documentBinding());
  assert.equal(typeof first, "string");
  assert.notEqual(first.length, 0);
  assert.equal(first, sessionIdFor(documentBinding()));
  assert.notEqual(first, sessionIdFor(documentBinding({ tabId: 8 })));
  assert.notEqual(first, sessionIdFor(documentBinding({ documentToken: "token-2" })));
  assert.notEqual(first, sessionIdFor(documentBinding({ conversationIdentity: "def" })));
  assert.notEqual(first, sessionIdFor(documentBinding({ provider: "claude" })));
});

test("a published session matches only the exact binding it came from", () => {
  const bound = documentBinding();
  const session = { ...bound, sessionId: sessionIdFor(bound), status: "ready" };
  assert.equal(bindingMatchesSession(bound, session), true);
  const fields = {
    provider: "claude",
    tabId: 8,
    frameId: 1,
    documentId: "doc-2",
    documentToken: "token-2",
    conversationUrl: "https://chatgpt.com/c/def",
    conversationIdentity: "def",
  };
  for (const [field, value] of Object.entries(fields)) {
    assert.equal(
      bindingMatchesSession(bound, { ...session, [field]: value }),
      false,
      `${field} was ignored when matching a session`,
    );
  }
});

test("two bindings are the same document when identity and token agree", () => {
  const left = documentBinding();
  assert.equal(sameDocumentBinding(left, documentBinding()), true);
  // A same-document route change rewrites the URL while the document stays put.
  assert.equal(
    sameDocumentBinding(left, documentBinding({ conversationUrl: "https://chatgpt.com/c/abc?x=1" })),
    true,
  );
  const fields = {
    provider: "claude",
    tabId: 8,
    frameId: 1,
    documentId: "doc-2",
    documentToken: "token-2",
    conversationIdentity: "def",
  };
  for (const [field, value] of Object.entries(fields)) {
    assert.equal(
      sameDocumentBinding(left, documentBinding({ [field]: value })),
      false,
      `${field} was ignored when comparing documents`,
    );
  }
});

test("only the built-in providers have a start URL", () => {
  assert.equal(providerStartUrl("chatgpt"), "https://chatgpt.com/");
  assert.equal(providerStartUrl("claude"), "https://claude.ai/new");
  assert.throws(() => providerStartUrl("generic"), /explicitly bound/);
});

test("every popup status carries its own instruction", () => {
  const statuses = [
    "ready",
    "notAuthenticated",
    "notReady",
    "submitting",
    "streaming",
    "failed",
    "disconnected",
    "unregistered",
  ];
  const reasons = statuses.map((status) => popupStatusReason(status));
  assert.equal(new Set(reasons).size, statuses.length, "two statuses share one instruction");
  for (const reason of reasons) {
    assert.equal(reason.length > 0, true);
  }
});

test("the active storage record wins over every legacy record", () => {
  const current = { endpoint: "ws://127.0.0.1:1/bachata-browser-bridge-v9" };
  assert.equal(
    migratedStoredCandidate(current, [{ endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v7" }]),
    current,
  );
});

test("the newest legacy record is migrated to the active protocol path", () => {
  const migrated = migratedStoredCandidate(undefined, [
    undefined,
    { endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v7", selectedTabId: 4 },
    { endpoint: "ws://127.0.0.1:3/bachata-browser-bridge-v4" },
  ]);
  assert.deepEqual(migrated, {
    endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v9",
    selectedTabId: 4,
  });
});

test("a legacy record without a usable endpoint is carried across unchanged", () => {
  assert.deepEqual(
    migratedStoredCandidate(undefined, [{ selectedTabId: 4 }]),
    { selectedTabId: 4 },
  );
  assert.deepEqual(
    migratedStoredCandidate(undefined, [{ endpoint: 7 }]),
    { endpoint: 7 },
  );
});

test("an endpoint outside the migrated version range keeps its path", () => {
  assert.deepEqual(
    migratedStoredCandidate(undefined, [{ endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v9" }]),
    { endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v9" },
  );
  assert.deepEqual(
    migratedStoredCandidate(undefined, [{ endpoint: "ws://127.0.0.1:2/other" }]),
    { endpoint: "ws://127.0.0.1:2/other" },
  );
});

test("nothing worth migrating leaves the absent record absent", () => {
  for (const legacy of [[], [undefined, null, ""], [[]], ["text"], [7]]) {
    assert.equal(
      migratedStoredCandidate(undefined, legacy),
      undefined,
      `${JSON.stringify(legacy)} was migrated`,
    );
  }
});

test("the legacy keys are the versions below the active one, newest first, in both shipped spellings", () => {
  // PAIR-ID-01. The list is a record of what shipped. A released build wrote `pairBridgeState.v7`,
  // and the `pair` to `bachata` rename rewrote this list along with everything else — leaving a
  // migration that looks for names nothing ever stored. Asserting only the current spelling is
  // what let that pass: it proves the list agrees with itself.
  assert.equal(storageKey, "bachataBridgeState.v8");
  assert.deepEqual(legacyStorageKeys, [
    // BR-G6-19. The active version's own older spelling. The rename changed the spelling without
    // changing the version, so a released v8 build stored a real pairing under this key and the
    // list — built only from versions *below* the active one — was not looking for it.
    "pairBridgeState.v8",
    "bachataBridgeState.v7",
    "pairBridgeState.v7",
    "bachataBridgeState.v6",
    "pairBridgeState.v6",
    "bachataBridgeState.v5",
    "pairBridgeState.v5",
    "bachataBridgeState.v4",
    "pairBridgeState.v4",
  ]);
  // Ordered newest version first, so the newest record present is the one migrated.
  const versions = legacyStorageKeys.map((key) => Number(/\.v(\d+)$/u.exec(key)[1]));
  assert.deepEqual(versions, [...versions].sort((left, right) => right - left));
  assert.equal(legacyStorageKeys.includes(storageKey), false, "the active key is listed as legacy");
  // Every version this build can migrate from is readable in both spellings, the active one
  // included: that is the whole claim the list makes.
  const activeVersion = Number(/\.v(\d+)$/u.exec(storageKey)[1]);
  for (const version of new Set(versions)) {
    for (const spelling of ["bachataBridgeState", "pairBridgeState"]) {
      const key = `${spelling}.v${String(version)}`;
      assert.equal(
        key === storageKey || legacyStorageKeys.includes(key),
        true,
        `${key} is neither the active key nor readable as a legacy one`,
      );
    }
  }
  assert.equal(
    legacyStorageKeys.includes(`pairBridgeState.v${String(activeVersion)}`),
    true,
    "a released build at the active version stored its pairing under a key nothing reads",
  );
});

test("a record stored under the shipped name is migrated to the active protocol path", () => {
  // PAIR-ID-01. The endpoint a released build persisted names `pair-browser-bridge-v7`. A pattern
  // that matched only the renamed spelling left that path untouched, so the upgraded extension
  // kept talking to a protocol path the current server does not serve.
  assert.deepEqual(
    migratedStoredCandidate(undefined, [
      { endpoint: "ws://127.0.0.1:2/pair-browser-bridge-v7", selectedTabId: 4 },
    ]),
    { endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v9", selectedTabId: 4 },
  );
  for (const version of [4, 5, 6, 7, 8]) {
    assert.deepEqual(
      migratedStoredCandidate(undefined, [
        { endpoint: `ws://127.0.0.1:2/pair-browser-bridge-v${String(version)}` },
      ]),
      { endpoint: "ws://127.0.0.1:2/bachata-browser-bridge-v9" },
      `v${String(version)}`,
    );
  }
  // And the range is still a range: the active version and anything outside it keep their path.
  assert.deepEqual(
    migratedStoredCandidate(undefined, [{ endpoint: "ws://127.0.0.1:2/pair-browser-bridge-v9" }]),
    { endpoint: "ws://127.0.0.1:2/pair-browser-bridge-v9" },
  );
  assert.deepEqual(
    migratedStoredCandidate(undefined, [{ endpoint: "ws://127.0.0.1:2/pair-browser-bridge-v3" }]),
    { endpoint: "ws://127.0.0.1:2/pair-browser-bridge-v3" },
  );
});

const sender = (overrides = {}) => ({
  tab: { id: 7 },
  frameId: 0,
  url: "https://chatgpt.com/c/abc",
  documentId: "doc-1",
  ...overrides,
});

test("a binding is derived from the sender the browser vouches for", () => {
  const bound = senderBinding(sender(), "token-1");
  assert.deepEqual(bound, {
    provider: "chatgpt",
    tabId: 7,
    frameId: 0,
    documentId: "doc-1",
    documentToken: "token-1",
    conversationUrl: "https://chatgpt.com/c/abc",
    conversationIdentity: "chatgpt:https://chatgpt.com/c/abc",
  });
});

test("a sender that cannot own a provider document is refused", () => {
  const cases = [
    [sender({ tab: undefined }), "token-1"],
    [sender({ tab: {} }), "token-1"],
    [sender({ tab: { id: 1.5 } }), "token-1"],
    [sender({ frameId: 1 }), "token-1"],
    [sender({ frameId: undefined }), "token-1"],
    [sender({ url: undefined }), "token-1"],
    [sender({ url: "https://example.test/" }), "token-1"],
    [sender(), undefined],
    [sender(), 7],
    [sender(), ""],
  ];
  for (const [candidate, token] of cases) {
    assert.equal(
      senderBinding(candidate, token),
      undefined,
      `${JSON.stringify({ candidate, token })} produced a binding`,
    );
  }
});

test("a sender without a document id binds without one", () => {
  assert.equal(senderBinding(sender({ documentId: undefined }), "token-1")?.documentId, undefined);
  assert.equal(senderBinding(sender({ documentId: 7 }), "token-1")?.documentId, undefined);
});

test("a running request matches only the sender and agent that own it", () => {
  const bound = senderBinding(sender(), "token-1");
  const request = activeRequest({ conversationIdentity: bound.conversationIdentity });
  const message = { agentId: "agent-1", sessionId: "session-1" };
  assert.equal(activeRequestMatchesSender(request, bound, message), true);

  const bindingFields = {
    provider: "claude",
    tabId: 8,
    frameId: 1,
    documentId: "doc-2",
    documentToken: "token-2",
    conversationUrl: "https://chatgpt.com/c/def",
    conversationIdentity: "chatgpt:https://chatgpt.com/c/def",
  };
  for (const [field, value] of Object.entries(bindingFields)) {
    assert.equal(
      activeRequestMatchesSender(request, { ...bound, [field]: value }, message),
      false,
      `${field} was ignored when matching a sender`,
    );
  }
  assert.equal(
    activeRequestMatchesSender(request, bound, { ...message, agentId: "agent-2" }),
    false,
  );
  assert.equal(
    activeRequestMatchesSender(request, bound, { ...message, sessionId: "session-2" }),
    false,
  );
});

// BB-AUD-09. The handled-tab list is persisted, so every read of it normalises rather than
// trusting what came back.

test("the handled-tab list is normalised on every read", () => {
  assert.deepEqual(normalizedHandledTabIds({}), []);
  assert.deepEqual(normalizedHandledTabIds({ handledTabIds: [3, 1, 3, 2] }), [1, 2, 3]);
  assert.deepEqual(
    normalizedHandledTabIds({ handledTabIds: [0, -1, 1.5, Number.NaN, 4] }),
    [4],
  );
});

test("remembering a tab keeps the list sorted and free of duplicates", () => {
  assert.deepEqual(withHandledTabs({ handledTabIds: [3, 1] }, [2, 3]), [1, 2, 3]);
  assert.deepEqual(withHandledTabs({}, [9]), [9]);
  assert.deepEqual(withHandledTabs({ handledTabIds: [1] }, []), [1]);
});

test("forgetting the last handled tab leaves nothing rather than an empty list", () => {
  assert.deepEqual(withoutHandledTab({ handledTabIds: [1, 2] }, 1), [2]);
  assert.equal(withoutHandledTab({ handledTabIds: [1] }, 1), undefined);
  assert.equal(withoutHandledTab({}, 1), undefined);
  // A tab that was never in the list changes nothing.
  assert.deepEqual(withoutHandledTab({ handledTabIds: [1, 2] }, 7), [1, 2]);
});

// BB-AUD-09. The session builder and the generic attestation path decided these inside the
// service-worker entry, beside the `chrome.tabs` reads and the content probes that feed them,
// so each was reachable only by driving the whole worker against a live browser.

const liveBinding = (overrides = {}) => ({
  provider: "chatgpt",
  tabId: 7,
  frameId: 0,
  documentToken: "document-7",
  conversationUrl: "https://chatgpt.com/c/one",
  conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
  ...overrides,
});

const publishedStatuses = new Set([
  "disconnected",
  "notAuthenticated",
  "notReady",
  "ready",
  "submitting",
  "streaming",
  "failed",
]);

test("a binding is live only on a tab still holding its own conversation", () => {
  const live = { id: 7, provider: "chatgpt", url: "https://chatgpt.com/c/one" };
  assert.equal(routerState.bindingIsLiveOnTab(liveBinding(), live), true);
  // The tab is gone.
  assert.equal(routerState.bindingIsLiveOnTab(liveBinding(), undefined), false);
  // The tab now holds another provider.
  assert.equal(
    routerState.bindingIsLiveOnTab(liveBinding(), { ...live, provider: "claude" }),
    false,
  );
  // The tab navigated to another conversation.
  assert.equal(
    routerState.bindingIsLiveOnTab(liveBinding(), { ...live, url: "https://chatgpt.com/c/two" }),
    false,
  );
});

test("a same-document route change keeps the binding live", () => {
  // Query and fragment are not part of a built-in provider's conversation identity.
  assert.equal(
    routerState.bindingIsLiveOnTab(liveBinding(), {
      id: 7,
      provider: "chatgpt",
      url: "https://chatgpt.com/c/one?model=x#section",
    }),
    true,
  );
});

const contentStatus = (overrides = {}) => ({
  status: "ready",
  documentToken: "document-7",
  conversationUrl: "https://chatgpt.com/c/one",
  conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
  ...overrides,
});

test("a status is the binding's own only when every part of it agrees", () => {
  assert.equal(
    routerState.contentStatusMatchesBinding(contentStatus(), liveBinding(), publishedStatuses),
    true,
  );
  assert.equal(
    routerState.contentStatusMatchesBinding(
      contentStatus({ documentToken: "another-document" }),
      liveBinding(),
      publishedStatuses,
    ),
    false,
  );
  assert.equal(
    routerState.contentStatusMatchesBinding(
      contentStatus({ conversationUrl: undefined }),
      liveBinding(),
      publishedStatuses,
    ),
    false,
  );
  assert.equal(
    routerState.contentStatusMatchesBinding(
      contentStatus({ conversationUrl: "https://chatgpt.com/c/two" }),
      liveBinding(),
      publishedStatuses,
    ),
    false,
  );
  assert.equal(
    routerState.contentStatusMatchesBinding(
      contentStatus({ conversationIdentity: "chatgpt:https://chatgpt.com/c/two" }),
      liveBinding(),
      publishedStatuses,
    ),
    false,
  );
});

test("a status the protocol does not publish is not a session", () => {
  assert.equal(
    routerState.contentStatusMatchesBinding(
      contentStatus({ status: "thinking" }),
      liveBinding(),
      publishedStatuses,
    ),
    false,
  );
  publishedStatuses.forEach((published) => {
    assert.equal(
      routerState.contentStatusMatchesBinding(
        contentStatus({ status: published }),
        liveBinding(),
        publishedStatuses,
      ),
      true,
      published,
    );
  });
});

const attestation = (overrides = {}) => ({
  documentToken: "document-9",
  documentRevision: 4,
  conversationUrl: "https://example.invalid/chat/one",
  conversationIdentity: "generic:https://example.invalid/chat/one",
  ...overrides,
});

test("a generic status matches its attestation only at the same document revision", () => {
  const current = attestation();
  assert.equal(
    routerState.genericStatusMatchesAttestation(
      { documentToken: "document-9", documentRevision: 4 },
      current.conversationUrl,
      current.conversationIdentity,
      current,
    ),
    true,
  );
  // The page re-rendered under the extension.
  assert.equal(
    routerState.genericStatusMatchesAttestation(
      { documentToken: "document-9", documentRevision: 5 },
      current.conversationUrl,
      current.conversationIdentity,
      current,
    ),
    false,
  );
  // A different document answered.
  assert.equal(
    routerState.genericStatusMatchesAttestation(
      { documentToken: "another", documentRevision: 4 },
      current.conversationUrl,
      current.conversationIdentity,
      current,
    ),
    false,
  );
  // The conversation moved.
  assert.equal(
    routerState.genericStatusMatchesAttestation(
      { documentToken: "document-9", documentRevision: 4 },
      "https://example.invalid/chat/two",
      current.conversationIdentity,
      current,
    ),
    false,
  );
  assert.equal(
    routerState.genericStatusMatchesAttestation(
      { documentToken: "document-9", documentRevision: 4 },
      current.conversationUrl,
      "generic:https://example.invalid/chat/two",
      current,
    ),
    false,
  );
});

const genericSession = (overrides = {}) => ({
  id: "session-9",
  provider: "generic",
  tabId: 9,
  frameId: 0,
  documentToken: "document-9",
  conversationUrl: "https://example.invalid/chat/one",
  conversationIdentity: "generic:https://example.invalid/chat/one",
  status: "ready",
  capabilities: { conversationState: "confirmed" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("a confirmed reuse needs a ready page and a confirmed conversation", () => {
  const sessions = [genericSession()];
  assert.equal(
    routerState.sessionForAttestation(sessions, 9, attestation(), "confirmed")?.id,
    "session-9",
  );
  assert.equal(
    routerState.sessionForAttestation(sessions, 9, attestation(), "provisional"),
    undefined,
  );
});

test("a provisional reuse needs the conversation still held uncertain", () => {
  const sessions = [
    genericSession({
      status: "notReady",
      capabilities: { conversationState: "uncertain" },
    }),
  ];
  assert.equal(
    routerState.sessionForAttestation(sessions, 9, attestation(), "provisional")?.id,
    "session-9",
  );
  assert.equal(
    routerState.sessionForAttestation(sessions, 9, attestation(), "confirmed"),
    undefined,
  );
});

test("an attestation never matches another tab, provider or document", () => {
  const current = attestation();
  const cases = [
    genericSession({ tabId: 10 }),
    genericSession({ provider: "chatgpt" }),
    genericSession({ documentToken: "another" }),
    genericSession({ conversationUrl: "https://example.invalid/chat/two" }),
    genericSession({ conversationIdentity: "generic:https://example.invalid/chat/two" }),
    genericSession({ capabilities: undefined }),
  ];
  cases.forEach((session) => {
    assert.equal(
      routerState.sessionForAttestation([session], 9, current, "confirmed"),
      undefined,
      JSON.stringify(session.id),
    );
  });
  assert.equal(routerState.sessionForAttestation([], 9, current, "confirmed"), undefined);
});

// BB-AUD-09. The one place a running request's bound conversation may change. It was decided
// inline in the service worker beside the write it authorises, so every refusal could only be
// reached by driving a whole turn through Chrome and a socket.

const transitionRequest = (overrides = {}) => ({
  provider: "chatgpt",
  tabId: 4,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "token-1",
  conversationUrl: "https://chatgpt.com/",
  conversationIdentity: "chatgpt:/",
  initialConversationUrl: "https://chatgpt.com/",
  agentId: "agent-1",
  sessionId: "session-1",
  requestId: "request-1",
  allowInitialConversationTransition: true,
  transitionUsed: false,
  deadlineAt: Number.MAX_SAFE_INTEGER,
  ...overrides,
});

const transitionBinding = (overrides = {}) => ({
  provider: "chatgpt",
  tabId: 4,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "token-1",
  conversationUrl: "https://chatgpt.com/c/new-one",
  conversationIdentity: "chatgpt:/c/new-one",
  ...overrides,
});

const transitionMessage = (overrides = {}) => ({
  requestId: "request-1",
  agentId: "agent-1",
  sessionId: "session-1",
  submissionCommitted: true,
  ...overrides,
});

const admitTransition = (overrides = {}) =>
  admitInitialTransition({
    request: transitionRequest(),
    binding: transitionBinding(),
    message: transitionMessage(),
    supportedTransition: () => true,
    ...overrides,
  });

test("an initial transition is admitted and reports the exact state the caller must write", () => {
  const admission = admitTransition();
  assert.deepEqual(admission, {
    admitted: true,
    conversationUrl: "https://chatgpt.com/c/new-one",
    conversationIdentity: "chatgpt:/c/new-one",
    binding: transitionBinding(),
  });
});

test("a transition with no request behind it, or no sender binding, is refused", () => {
  assert.deepEqual(admitTransition({ request: undefined }), { admitted: false });
  assert.deepEqual(admitTransition({ binding: undefined }), { admitted: false });
});

test("a transition from a document that is not the request's own is refused", () => {
  for (const change of [
    { provider: "claude" },
    { tabId: 5 },
    { frameId: 1 },
    { documentId: "doc-2" },
    { documentToken: "token-2" },
  ]) {
    assert.deepEqual(
      admitTransition({ binding: transitionBinding(change) }),
      { admitted: false },
      JSON.stringify(change),
    );
  }
});

test("a transition naming another agent or another session is refused", () => {
  assert.deepEqual(admitTransition({ message: transitionMessage({ agentId: "agent-2" }) }), { admitted: false });
  assert.deepEqual(admitTransition({ message: transitionMessage({ sessionId: "session-2" }) }), { admitted: false });
});

test("a request that never allowed a transition, or already used one, is refused", () => {
  assert.deepEqual(
    admitTransition({ request: transitionRequest({ allowInitialConversationTransition: false }) }),
    { admitted: false },
  );
  assert.deepEqual(
    admitTransition({ request: transitionRequest({ transitionUsed: true }) }),
    { admitted: false },
  );
});

// BR-G6-03. Only the content script knows whether the irreversible Send has happened. A
// transition claimed before it is somebody else's navigation — a restored conversation, a
// sidebar click — and admitting it would rebind the request onto a conversation nobody
// authorized while the prompt is still unsent.
test("a transition that does not assert a committed submission is refused", () => {
  for (const claim of [undefined, false, "true", 1]) {
    assert.deepEqual(
      admitTransition({ message: transitionMessage({ submissionCommitted: claim }) }),
      { admitted: false },
      JSON.stringify(claim ?? null),
    );
  }
});

test("the supported-transition rule is asked with the request's own before and after", () => {
  const asked = [];
  const admission = admitTransition({
    supportedTransition: (provider, previous, next) => {
      asked.push([provider, previous, next]);
      return false;
    },
  });
  assert.deepEqual(asked, [["chatgpt", "https://chatgpt.com/", "https://chatgpt.com/c/new-one"]]);
  assert.deepEqual(admission, { admitted: false });
});

// BB-A4-F19. A pairing made under an earlier protocol survives the upgrade wherever storage kept
// it. The rewrite used to sit on the legacy branch only, so a record under the ACTIVE key — where
// a release-era pairing lands the first time it is written back — reached the v9 validator with
// its old path, was refused, and lost its connection token with it. The rewrite belongs to
// whichever record wins, not to the key it was found under.
test("a current record's historical endpoint path is rewritten to the active protocol", () => {
  for (const spelling of ["bachata", "pair"]) {
    for (const version of [4, 5, 6, 7, 8]) {
      const current = {
        endpoint: `ws://127.0.0.1:1/${spelling}-browser-bridge-v${String(version)}`,
        connectionToken: "secret",
      };
      assert.deepEqual(
        migratedStoredCandidate(current, [
          { endpoint: `ws://127.0.0.1:2/${spelling}-browser-bridge-v7` },
        ]),
        { endpoint: "ws://127.0.0.1:1/bachata-browser-bridge-v9", connectionToken: "secret" },
        `${spelling} v${String(version)} was not rewritten, or the legacy record won`,
      );
    }
  }
});

test("a rewritten current record keeps its pairing through validation", () => {
  const { state, invalidEndpoint } = storedStateFrom(
    migratedStoredCandidate(
      {
        endpoint: "ws://127.0.0.1:1/pair-browser-bridge-v8",
        connectionToken: "secret",
        selectedTabId: 5,
      },
      [],
    ),
  );
  assert.equal(invalidEndpoint, false, "the upgraded endpoint was refused");
  assert.equal(state.endpoint, "ws://127.0.0.1:1/bachata-browser-bridge-v9");
  assert.equal(state.connectionToken, "secret", "the token was dropped with the endpoint");
  assert.equal(state.selectedTabId, 5);
});

test("rewriting the path decides nothing else about an endpoint", () => {
  const { state, invalidEndpoint } = storedStateFrom(
    migratedStoredCandidate({ endpoint: "ws://evil.test/bachata-browser-bridge-v8" }, []),
  );
  assert.equal(invalidEndpoint, true, "a foreign host was admitted by the path rewrite");
  assert.equal(state.endpoint, undefined);
});

test("a current record with no endpoint at all is returned untouched", () => {
  const current = { connectionToken: "secret", selectedTabId: 3 };
  assert.deepEqual(migratedStoredCandidate(current, []), current);
  assert.equal(migratedStoredCandidate(undefined, []), undefined);
  assert.equal(migratedStoredCandidate(undefined, ["not a record"]), undefined);
});
