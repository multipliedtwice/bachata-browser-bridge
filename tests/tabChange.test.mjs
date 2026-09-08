import assert from "node:assert/strict";
import test from "node:test";

import {
  genericTabChangeVerdict,
  probedTabSupported,
  providerTabUrlVerdict,
  refreshAfterTabChange,
  tabSupportProbeNeeded,
} from "../dist/background/tabChange.js";

// BB-AUD-09. What a tab update means for the work bound to that tab. Each verdict is driven
// directly: no Chrome, no socket, no persisted state, so a navigation that must drop a binding
// and one that must be ignored are both one call apart rather than one tab lifecycle apart.

test("a Generic tab that stays on its bound origin keeps its registration", () => {
  assert.deepEqual(
    genericTabChangeVerdict({ url: "https://example.invalid/chat/two", registeredOrigin: "https://example.invalid" }),
    { leftOrigin: false, refreshStatus: true },
  );
});

test("a Generic tab that moved to another origin loses it, whatever the scheme", () => {
  for (const url of [
    "https://elsewhere.invalid/chat",
    "http://example.invalid/chat",
    "about:blank",
    "chrome://settings",
    "not a url",
    "file:///tmp/page.html",
  ]) {
    assert.deepEqual(
      genericTabChangeVerdict({ url, registeredOrigin: "https://example.invalid" }),
      { leftOrigin: true, refreshStatus: true },
      url,
    );
  }
});

test("a Generic tab change with no URL refreshes only when the load finished", () => {
  assert.deepEqual(
    genericTabChangeVerdict({ status: "complete", registeredOrigin: "https://example.invalid" }),
    { leftOrigin: false, refreshStatus: true },
  );
  assert.deepEqual(
    genericTabChangeVerdict({ status: "loading", registeredOrigin: "https://example.invalid" }),
    { leftOrigin: false, refreshStatus: false },
  );
  assert.deepEqual(
    genericTabChangeVerdict({ registeredOrigin: "https://example.invalid" }),
    { leftOrigin: false, refreshStatus: false },
  );
});

const binding = (overrides = {}) => ({
  provider: "chatgpt",
  tabId: 3,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "token-1",
  conversationUrl: "https://chatgpt.com/c/one",
  conversationIdentity: "chatgpt:one",
  ...overrides,
});

const activeRequest = (overrides = {}) => ({
  ...binding(),
  agentId: "agent-1",
  sessionId: "session-1",
  requestId: "request-1",
  conversationUrl: "https://chatgpt.com/",
  conversationIdentity: "chatgpt:https://chatgpt.com/",
  initialConversationUrl: "https://chatgpt.com/",
  allowInitialConversationTransition: true,
  transitionUsed: false,
  deadlineAt: Number.MAX_SAFE_INTEGER,
  ...overrides,
});

const initialBinding = (overrides = {}) => binding({
  conversationUrl: "https://chatgpt.com/",
  conversationIdentity: "chatgpt:https://chatgpt.com/",
  ...overrides,
});

test("a change that carries no URL decides nothing about the binding", () => {
  assert.deepEqual(providerTabUrlVerdict({ binding: binding() }), { verdict: "no-url-change" });
  assert.deepEqual(providerTabUrlVerdict({}), { verdict: "no-url-change" });
});

test("a URL-less completion during the exact pending first transition is suppressed", () => {
  assert.deepEqual(
    providerTabUrlVerdict({
      status: "complete",
      binding: initialBinding(),
      activeRequest: activeRequest(),
    }),
    { verdict: "kept", suppressRefresh: true },
  );
});

test("ordinary URL-less completions are not hidden as first transitions", () => {
  const cases = [
    { activeRequest: activeRequest({ allowInitialConversationTransition: false }) },
    { activeRequest: activeRequest({ transitionUsed: true }) },
    {
      binding: binding(),
      activeRequest: activeRequest({
        conversationUrl: "https://chatgpt.com/c/one",
        conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
        initialConversationUrl: "https://chatgpt.com/c/one",
      }),
    },
    { activeRequest: activeRequest({ provider: "claude" }) },
    { activeRequest: activeRequest({ tabId: 4 }) },
    { activeRequest: activeRequest({ frameId: 1 }) },
    { activeRequest: activeRequest({ documentId: "other-document-id" }) },
    { activeRequest: activeRequest({ documentToken: "other-document" }) },
    { activeRequest: activeRequest({ conversationIdentity: "chatgpt:https://chatgpt.com/c/other" }) },
  ];
  for (const candidate of cases) {
    assert.deepEqual(
      providerTabUrlVerdict({
        status: "complete",
        binding: candidate.binding ?? initialBinding(),
        activeRequest: candidate.activeRequest,
      }),
      { verdict: "no-url-change" },
      JSON.stringify(candidate),
    );
  }
});

test("an established conversation's URL-less completion still probes and refreshes", () => {
  const verdict = providerTabUrlVerdict({ status: "complete", binding: binding() });
  assert.deepEqual(verdict, { verdict: "no-url-change" });
  assert.equal(
    tabSupportProbeNeeded({ suppressRefresh: false, status: "complete", tracked: true }),
    true,
  );
  assert.equal(
    refreshAfterTabChange({ suppressRefresh: false, status: "complete" }),
    true,
  );
});

test("a transition is only protected while the binding it belongs to is still held", () => {
  // The pending-transition rule now compares a request against the binding it was taken from,
  // field for field, rather than accepting any active request on the tab. With no binding there is
  // nothing to compare and nothing to protect: the update is not treated as a navigation away, and
  // it is not treated as a transition either, so the refresh and the support probe still happen.
  assert.deepEqual(
    providerTabUrlVerdict({
      url: "https://chatgpt.com/c/new-one",
      activeRequest: activeRequest(),
    }),
    { verdict: "kept", suppressRefresh: false },
  );
  assert.deepEqual(
    providerTabUrlVerdict({ status: "complete", activeRequest: activeRequest() }),
    { verdict: "no-url-change" },
  );
});

test("a completion is only suppressed once the load has actually finished", () => {
  for (const status of ["loading", undefined]) {
    assert.deepEqual(
      providerTabUrlVerdict({
        ...(status === undefined ? {} : { status }),
        binding: initialBinding(),
        activeRequest: activeRequest(),
      }),
      { verdict: "no-url-change" },
      String(status),
    );
  }
});

test("a tab that left supported sites loses its binding and says why", () => {
  assert.deepEqual(providerTabUrlVerdict({ url: "https://example.invalid/", binding: binding() }), {
    verdict: "left-supported-sites",
    failure: "The selected browser tab navigated to an unsupported site",
  });
  // With nothing bound to the tab, the answer is the same: an unsupported page is not a page
  // this worker keeps a tab for.
  assert.equal(
    providerTabUrlVerdict({ url: "https://example.invalid/" }).verdict,
    "left-supported-sites",
  );
});

test("a tab that stayed on its own conversation keeps everything", () => {
  assert.deepEqual(
    providerTabUrlVerdict({ url: "https://chatgpt.com/c/one", binding: binding() }),
    { verdict: "kept", suppressRefresh: false },
  );
});

test("a tab that moved to another conversation loses its binding", () => {
  assert.deepEqual(
    providerTabUrlVerdict({ url: "https://chatgpt.com/c/two", binding: binding() }),
    {
      verdict: "left-its-conversation",
      failure: "The selected browser tab navigated",
      suppressRefresh: false,
    },
  );
  // A move to the other provider's site is the same loss, not an unsupported page.
  assert.equal(
    providerTabUrlVerdict({ url: "https://claude.ai/chat/x", binding: binding() }).verdict,
    "left-its-conversation",
  );
});

// BR-G6-09. A reload and a tab replacement land on the same URL, so a URL comparison sees
// nothing: the page the bridge was talking to is gone, its content script with it, and the
// binding and the request survive pointing at a document that no longer exists. That request
// never submits, never captures and never fails.
test("a document replaced at the same URL loses its binding", () => {
  assert.deepEqual(
    providerTabUrlVerdict({
      url: "https://chatgpt.com/c/one",
      binding: binding(),
      documentId: "doc-2",
    }),
    {
      verdict: "document-replaced",
      failure: "The selected browser document was replaced",
      suppressRefresh: false,
    },
  );
  // The same document reported again is the same page, and a report that names no document
  // cannot tell one from the other — neither drops anything.
  assert.deepEqual(
    providerTabUrlVerdict({
      url: "https://chatgpt.com/c/one",
      binding: binding(),
      documentId: "doc-1",
    }),
    { verdict: "kept", suppressRefresh: false },
  );
  assert.deepEqual(
    providerTabUrlVerdict({ url: "https://chatgpt.com/c/one", binding: binding() }),
    { verdict: "kept", suppressRefresh: false },
  );
  // A first route transition may stay in one document; it may not replace the document the
  // controller bound, even when the destination path would otherwise be allowed.
  assert.deepEqual(
    providerTabUrlVerdict({
      url: "https://chatgpt.com/c/new-one",
      binding: initialBinding(),
      activeRequest: activeRequest({
        conversationUrl: "https://chatgpt.com/",
        allowInitialConversationTransition: true,
        transitionUsed: false,
      }),
      documentId: "doc-2",
    }),
    {
      verdict: "left-its-conversation",
      failure: "The selected browser tab navigated",
      suppressRefresh: false,
    },
  );
});

test("a tab with nothing bound to it has no conversation to lose", () => {
  assert.deepEqual(providerTabUrlVerdict({ url: "https://chatgpt.com/c/two" }), {
    verdict: "kept",
    suppressRefresh: false,
  });
});

test("a permitted initial transition is not a navigation away, and publishes no refresh", () => {
  assert.deepEqual(
    providerTabUrlVerdict({
      url: "https://chatgpt.com/c/new-one",
      binding: initialBinding(),
      activeRequest: activeRequest(),
    }),
    { verdict: "kept", suppressRefresh: true },
  );
});

test("a request that cannot transition does not protect the tab from losing its binding", () => {
  for (const change of [
    { allowInitialConversationTransition: false },
    { transitionUsed: true },
    { provider: "claude" },
    { conversationUrl: "https://chatgpt.com/c/already-one" },
  ]) {
    const verdict = providerTabUrlVerdict({
      url: "https://chatgpt.com/c/new-one",
      binding: initialBinding(),
      activeRequest: activeRequest(change),
    });
    assert.equal(verdict.verdict, "left-its-conversation", JSON.stringify(change));
  }
});

test("a finished load is probed only for a tracked tab that is not mid-transition", () => {
  assert.equal(tabSupportProbeNeeded({ suppressRefresh: false, status: "complete", tracked: true }), true);
  assert.equal(tabSupportProbeNeeded({ suppressRefresh: true, status: "complete", tracked: true }), false);
  assert.equal(tabSupportProbeNeeded({ suppressRefresh: false, status: "loading", tracked: true }), false);
  assert.equal(tabSupportProbeNeeded({ suppressRefresh: false, tracked: true }), false);
  assert.equal(tabSupportProbeNeeded({ suppressRefresh: false, status: "complete", tracked: false }), false);
});

test("what Chrome answered decides support, and a missing answer is not support", () => {
  assert.equal(probedTabSupported("https://chatgpt.com/c/one"), true);
  assert.equal(probedTabSupported("https://claude.ai/chat/one"), true);
  assert.equal(probedTabSupported("https://example.invalid/"), false);
  assert.equal(probedTabSupported(undefined), false);
  assert.equal(probedTabSupported(42), false);
});

test("a status refresh follows any change that was not suppressed", () => {
  assert.equal(refreshAfterTabChange({ suppressRefresh: false, url: "https://chatgpt.com/" }), true);
  assert.equal(refreshAfterTabChange({ suppressRefresh: false, status: "complete" }), true);
  assert.equal(refreshAfterTabChange({ suppressRefresh: false, status: "loading" }), false);
  assert.equal(refreshAfterTabChange({ suppressRefresh: false }), false);
  assert.equal(refreshAfterTabChange({ suppressRefresh: true, url: "https://chatgpt.com/", status: "complete" }), false);
});
