import assert from "node:assert/strict";
import test from "node:test";

import {
  createNavigationTracker,
  isEffectiveTransition,
  navigationDetailsToEvent,
  normalizeNavigationEvent,
} from "../dist/background/navigationEvents.js";

// N1. Chrome reports navigation precisely; the href poll and broad `tabs.onUpdated` the bridge
// used could not tell a `pushState` inside the bound conversation from a subframe loading
// something else. `background/index.ts` subscribes `webNavigation.onCommitted`,
// `onHistoryStateUpdated` and `onReferenceFragmentUpdated` and adapts `tabs.onReplaced`
// through this module; every decision those listeners make is here.

const permittedGeneric = new Set(["https://generic.invalid"]);

const event = (overrides = {}) => ({
  kind: "onCommitted",
  tabId: 7,
  frameId: 0,
  documentId: "document-1",
  documentLifecycle: "active",
  url: "https://chatgpt.com/c/one",
  ...overrides,
});

const accept = (overrides, knownDocumentId) =>
  normalizeNavigationEvent(event(overrides), permittedGeneric, knownDocumentId);

test("a hard navigation, a reload and a redirect each commit a new document", () => {
  const committed = accept().navigation;
  assert.equal(committed.kind, "onCommitted");
  assert.equal(committed.tabId, 7);
  assert.equal(committed.frameId, 0);
  assert.equal(committed.documentId, "document-1");
  assert.equal(committed.url, "https://chatgpt.com/c/one");
  assert.equal(committed.provider, "chatgpt");
  assert.equal(committed.newDocument, true);
});

test("pushState, replaceState and a hash change keep the document", () => {
  ["onHistoryStateUpdated", "onReferenceFragmentUpdated"].forEach((kind) => {
    const navigation = accept({ kind }).navigation;
    assert.equal(navigation.kind, kind);
    assert.equal(navigation.newDocument, false, kind);
  });
});

test("a tab replacement is a new document, because everything about the old one is gone", () => {
  const navigation = accept({ kind: "onTabReplaced", replacedTabId: 6 }).navigation;
  assert.equal(navigation.newDocument, true);
  assert.equal(navigation.tabId, 7);
});

test("an event kind the bridge does not consume is refused by name", () => {
  assert.equal(
    normalizeNavigationEvent(event({ kind: "onBeforeNavigate" }), permittedGeneric).refusal,
    "unsupportedKind",
  );
  assert.equal(
    normalizeNavigationEvent(event({ kind: "onErrorOccurred" }), permittedGeneric).refusal,
    "unsupportedKind",
  );
});

test("a subframe navigating is not the conversation moving", () => {
  assert.equal(accept({ frameId: 1 }).refusal, "subframe");
  assert.equal(accept({ frameId: undefined }).refusal, "subframe");
});

test("a document nobody has been shown is refused", () => {
  assert.equal(accept({ documentLifecycle: "prerender" }).refusal, "prerender");
  assert.equal(accept({ documentLifecycle: "cached" }).refusal, "prerender");
  // Chrome may omit the lifecycle entirely, and an omission is not a prerender.
  assert.equal(accept({ documentLifecycle: undefined }).refusal, undefined);
});

test("an event with no usable tab is refused", () => {
  assert.equal(accept({ tabId: undefined }).refusal, "noTab");
  assert.equal(accept({ tabId: 1.5 }).refusal, "noTab");
});

test("a url that is not an http origin is refused", () => {
  assert.equal(accept({ url: undefined }).refusal, "invalidUrl");
  assert.equal(accept({ url: "not a url" }).refusal, "invalidUrl");
  assert.equal(accept({ url: "chrome://settings" }).refusal, "invalidUrl");
  assert.equal(accept({ url: "file:///etc/hosts" }).refusal, "invalidUrl");
});

test("a built-in provider is recognised without any granted origin", () => {
  assert.equal(
    normalizeNavigationEvent(event(), new Set()).navigation.provider,
    "chatgpt",
  );
  assert.equal(
    normalizeNavigationEvent(event({ url: "https://claude.ai/chat/two" }), new Set())
      .navigation.provider,
    "claude",
  );
});

test("a Generic origin is honoured only while it is still permitted", () => {
  const generic = event({ url: "https://generic.invalid/chat/one" });
  assert.equal(
    normalizeNavigationEvent(generic, permittedGeneric).navigation.provider,
    "generic",
  );
  // A revoked permission is the user withdrawing consent to read that site.
  assert.equal(normalizeNavigationEvent(generic, new Set()).refusal, "unsupportedOrigin");
});

test("an unrelated site is refused", () => {
  assert.equal(accept({ url: "https://example.invalid/" }).refusal, "unsupportedOrigin");
  // A permitted origin does not extend to its neighbours.
  assert.equal(
    accept({ url: "https://other.generic.invalid/chat" }).refusal,
    "unsupportedOrigin",
  );
});

test("a late same-document event from a replaced document is refused", () => {
  assert.equal(
    accept({ kind: "onHistoryStateUpdated", documentId: "document-0" }, "document-1").refusal,
    "staleDocument",
  );
  assert.equal(
    accept({ kind: "onHistoryStateUpdated", documentId: "document-1" }, "document-1").refusal,
    undefined,
  );
  // A commit is how a document is replaced, so it is never stale against the previous one.
  assert.equal(
    accept({ kind: "onCommitted", documentId: "document-2" }, "document-1").refusal,
    undefined,
  );
  // Chrome may omit the id, and an omission is not a mismatch.
  assert.equal(
    accept({ kind: "onHistoryStateUpdated", documentId: undefined }, "document-1").refusal,
    undefined,
  );
});

const navigation = (overrides = {}) => ({
  kind: "onCommitted",
  tabId: 7,
  frameId: 0,
  documentId: "document-1",
  url: "https://chatgpt.com/c/one",
  provider: "chatgpt",
  newDocument: true,
  ...overrides,
});

test("the first navigation on a tab is always a transition", () => {
  assert.equal(isEffectiveTransition(navigation(), undefined), true);
});

test("a redirect chain landing on the same document is one transition, not several", () => {
  assert.equal(
    isEffectiveTransition(navigation(), { documentId: "document-1", url: "https://chatgpt.com/c/one" }),
    false,
  );
  assert.equal(
    isEffectiveTransition(
      navigation({ url: "https://chatgpt.com/c/redirected" }),
      { documentId: "document-1", url: "https://chatgpt.com/c/one" },
    ),
    false,
    "a redirect within one document reported a second transition",
  );
});

test("a reload replaces the document, so it is a transition even to the same url", () => {
  assert.equal(
    isEffectiveTransition(
      navigation({ documentId: "document-2" }),
      { documentId: "document-1", url: "https://chatgpt.com/c/one" },
    ),
    true,
  );
});

test("a same-document route change is a transition only when the route actually changed", () => {
  const previous = { documentId: "document-1", url: "https://chatgpt.com/c/one" };
  assert.equal(
    isEffectiveTransition(navigation({ newDocument: false, url: "https://chatgpt.com/c/two" }), previous),
    true,
  );
  // Back and forward through the same entry report the same url twice.
  assert.equal(
    isEffectiveTransition(navigation({ newDocument: false }), previous),
    false,
  );
});

test("a new document with no id is treated as a transition rather than assumed to be the old one", () => {
  assert.equal(
    isEffectiveTransition(
      navigation({ documentId: undefined }),
      { documentId: "document-1", url: "https://chatgpt.com/c/one" },
    ),
    true,
  );
});

// The tracker is the normalizer plus the only state the decision needs: what each tab was last
// known to be showing. Chrome reports a redirect chain and a restored history entry as several
// events about one state, and the listeners must act once.

const trackerEvent = (overrides = {}) => event(overrides);

test("a tab's first navigation is acted on, and repeating it is not", () => {
  const tracker = createNavigationTracker();
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).navigation?.url, "https://chatgpt.com/c/one");
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).refusal, "duplicate");
});

test("a redirect chain that lands on one document is one transition", () => {
  const tracker = createNavigationTracker();
  tracker.accept(
    trackerEvent({ documentId: "document-9", url: "https://chatgpt.com/" }),
    permittedGeneric,
  );
  const landed = tracker.accept(
    trackerEvent({ documentId: "document-9", url: "https://chatgpt.com/c/one" }),
    permittedGeneric,
  );
  assert.equal(landed.refusal, "duplicate");
  // The tab is still recorded as showing where the chain started, so returning there is not a
  // transition either.
  assert.equal(
    tracker.accept(
      trackerEvent({ kind: "onHistoryStateUpdated", documentId: "document-9", url: "https://chatgpt.com/" }),
      permittedGeneric,
    ).refusal,
    "duplicate",
  );
});

test("a reload is a transition even to the same url, because the document is new", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  const reloaded = tracker.accept(
    trackerEvent({ documentId: "document-2" }),
    permittedGeneric,
  );
  assert.equal(reloaded.navigation?.newDocument, true);
  // The reloaded document is what the tab is now judged against: an event naming the one it
  // replaced is a late report from a document that is gone.
  assert.equal(
    tracker.accept(
      trackerEvent({ kind: "onHistoryStateUpdated", documentId: "document-1", url: "https://chatgpt.com/c/two" }),
      permittedGeneric,
    ).refusal,
    "staleDocument",
  );
});

test("a route change inside one document is a transition only when the route changed", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  const pushed = tracker.accept(
    trackerEvent({ kind: "onHistoryStateUpdated", url: "https://chatgpt.com/c/two" }),
    permittedGeneric,
  );
  assert.equal(pushed.navigation?.newDocument, false);
  assert.equal(
    tracker.accept(
      trackerEvent({ kind: "onHistoryStateUpdated", url: "https://chatgpt.com/c/two" }),
      permittedGeneric,
    ).refusal,
    "duplicate",
  );
});

test("going back to a url the tab has left is a transition, not a duplicate", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  tracker.accept(
    trackerEvent({ kind: "onHistoryStateUpdated", url: "https://chatgpt.com/c/two" }),
    permittedGeneric,
  );
  const back = tracker.accept(
    trackerEvent({ kind: "onHistoryStateUpdated", url: "https://chatgpt.com/c/one" }),
    permittedGeneric,
  );
  assert.equal(back.navigation?.url, "https://chatgpt.com/c/one");
});

test("a late same-document event from a replaced document is refused and changes nothing", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  const stale = tracker.accept(
    trackerEvent({
      kind: "onReferenceFragmentUpdated",
      documentId: "document-gone",
      url: "https://chatgpt.com/c/one#section",
    }),
    permittedGeneric,
  );
  assert.equal(stale.refusal, "staleDocument");
  // Refused, so it did not become what the tab is showing: the original url is still current.
  assert.equal(
    tracker.accept(trackerEvent({ kind: "onHistoryStateUpdated" }), permittedGeneric).refusal,
    "duplicate",
  );
});

test("a refused event never becomes the tab's recorded state", () => {
  const tracker = createNavigationTracker();
  assert.equal(tracker.accept(trackerEvent({ frameId: 3 }), permittedGeneric).refusal, "subframe");
  assert.equal(
    tracker.accept(trackerEvent({ documentLifecycle: "prerender" }), permittedGeneric).refusal,
    "prerender",
  );
  assert.equal(
    tracker.accept(trackerEvent({ url: "https://unrelated.invalid/" }), permittedGeneric).refusal,
    "unsupportedOrigin",
  );
  // None of them became state, so the tab's first accepted navigation is still its first.
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).navigation?.url, "https://chatgpt.com/c/one");
});

test("each tab is judged against its own history", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  const other = tracker.accept(trackerEvent({ tabId: 8 }), permittedGeneric);
  assert.equal(other.navigation?.tabId, 8);
  // Each keeps its own history: repeating either is a duplicate of that tab, not of the other.
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).refusal, "duplicate");
  assert.equal(tracker.accept(trackerEvent({ tabId: 8 }), permittedGeneric).refusal, "duplicate");
});

test("a replaced tab keeps no state under either id, so the survivor starts over", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  tracker.accept(trackerEvent({ tabId: 8, documentId: "document-8" }), permittedGeneric);
  tracker.replaceTab(8, 7);
  // Neither id carries anything forward, so the replaced tab's route is a first navigation too.
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).navigation?.url, "https://chatgpt.com/c/one");
  const afterReplacement = tracker.accept(
    trackerEvent({ kind: "onTabReplaced", tabId: 8, documentId: "document-8" }),
    permittedGeneric,
  );
  assert.equal(afterReplacement.navigation?.newDocument, true);
});

test("a closed tab is forgotten, so its id cannot suppress a later tab's first navigation", () => {
  const tracker = createNavigationTracker();
  tracker.accept(trackerEvent(), permittedGeneric);
  tracker.forgetTab(7);
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).navigation?.url, "https://chatgpt.com/c/one");
});

test("a Generic origin that has been revoked stops being a transition at all", () => {
  const tracker = createNavigationTracker();
  const generic = { kind: "onCommitted", tabId: 11, frameId: 0, documentId: "document-g", documentLifecycle: "active", url: "https://generic.invalid/chat" };
  assert.equal(tracker.accept(generic, permittedGeneric).navigation?.provider, "generic");
  assert.equal(tracker.accept({ ...generic, documentId: "document-h" }, new Set()).refusal, "unsupportedOrigin");
});

test("an event with no usable tab is refused before any state is read", () => {
  const tracker = createNavigationTracker();
  assert.equal(tracker.accept(trackerEvent({ tabId: undefined }), permittedGeneric).refusal, "noTab");
  assert.equal(tracker.accept(trackerEvent({ tabId: 1.5 }), permittedGeneric).refusal, "noTab");
  assert.equal(tracker.accept(trackerEvent(), permittedGeneric).navigation?.tabId, 7);
});

test("a document Chrome did not name is still recorded, by url alone", () => {
  const tracker = createNavigationTracker();
  const first = tracker.accept(trackerEvent({ documentId: undefined }), permittedGeneric);
  assert.equal(first.navigation?.documentId, undefined);
  assert.equal("documentId" in first.navigation, false);
  // Without an id nothing proves the next commit is the same document, so it is a transition.
  assert.equal(
    tracker.accept(trackerEvent({ documentId: undefined }), permittedGeneric).navigation?.url,
    "https://chatgpt.com/c/one",
  );
});

test("Chrome's three navigation events differ only in what they mean", () => {
  const details = {
    tabId: 7,
    frameId: 0,
    url: "https://chatgpt.com/c/one",
    documentId: "document-1",
    documentLifecycle: "active",
  };
  assert.deepEqual(navigationDetailsToEvent("onCommitted", details), {
    kind: "onCommitted",
    tabId: 7,
    frameId: 0,
    documentId: "document-1",
    documentLifecycle: "active",
    url: "https://chatgpt.com/c/one",
  });
  assert.equal(
    navigationDetailsToEvent("onHistoryStateUpdated", details).kind,
    "onHistoryStateUpdated",
  );
});

test("a field Chrome did not send is absent rather than undefined", () => {
  const event = navigationDetailsToEvent("onReferenceFragmentUpdated", {
    tabId: 7,
    frameId: 0,
    url: "https://chatgpt.com/c/one#a",
  });
  assert.equal("documentId" in event, false);
  assert.equal("documentLifecycle" in event, false);
});

// N1 re-audit. Chrome delivers events faster than an asynchronous permission read resolves, so
// an accepted navigation carries the number it holds for its tab and a handler that awaited
// anything checks that number still holds before acting.

test("each accepted navigation is numbered, and only the newest one is current", () => {
  const tracker = createNavigationTracker();
  const first = tracker.accept(trackerEvent(), permittedGeneric);
  assert.equal(typeof first.sequence, "number");
  assert.equal(tracker.isCurrent(7, first.sequence), true);
  const second = tracker.accept(
    trackerEvent({ kind: "onHistoryStateUpdated", url: "https://chatgpt.com/c/two" }),
    permittedGeneric,
  );
  assert.notEqual(second.sequence, first.sequence);
  assert.equal(tracker.isCurrent(7, second.sequence), true);
  // The older one is history: a handler still holding it must do nothing.
  assert.equal(tracker.isCurrent(7, first.sequence), false);
});

test("numbers are never reused, so a forgotten tab cannot match an older handler's number", () => {
  const tracker = createNavigationTracker();
  const first = tracker.accept(trackerEvent(), permittedGeneric);
  tracker.forgetTab(7);
  const afterClose = tracker.accept(trackerEvent(), permittedGeneric);
  assert.notEqual(afterClose.sequence, first.sequence);
  assert.equal(tracker.isCurrent(7, first.sequence), false);
});

test("a closed tab makes every number for it stale", () => {
  const tracker = createNavigationTracker();
  const accepted = tracker.accept(trackerEvent(), permittedGeneric);
  tracker.forgetTab(7);
  assert.equal(tracker.isCurrent(7, accepted.sequence), false);
});

test("a replaced tab makes every number for either id stale", () => {
  const tracker = createNavigationTracker();
  const survivor = tracker.accept(trackerEvent({ tabId: 8 }), permittedGeneric);
  const replaced = tracker.accept(trackerEvent(), permittedGeneric);
  tracker.replaceTab(8, 7);
  assert.equal(tracker.isCurrent(8, survivor.sequence), false);
  assert.equal(tracker.isCurrent(7, replaced.sequence), false);
});

test("a refused navigation is numbered by nothing and current for nothing", () => {
  const tracker = createNavigationTracker();
  const refused = tracker.accept(trackerEvent({ frameId: 4 }), permittedGeneric);
  assert.equal(refused.sequence, undefined);
  assert.equal(tracker.isCurrent(7, 1), false);
});

test("one tab's number says nothing about another tab", () => {
  const tracker = createNavigationTracker();
  const first = tracker.accept(trackerEvent(), permittedGeneric);
  tracker.accept(trackerEvent({ tabId: 8 }), permittedGeneric);
  assert.equal(tracker.isCurrent(8, first.sequence), false);
  assert.equal(tracker.isCurrent(7, first.sequence), true);
});
