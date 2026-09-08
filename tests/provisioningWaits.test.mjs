import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitGenericSession,
  awaitLoadedProviderTab,
  awaitProviderSession,
  awaitSessionOnTab,
  freshGenericVerdict,
  openedSessionRefusal,
  pollUntilSettled,
  providerTabIsLoaded,
  selectGenericSession,
  sessionForProviderTab,
  sessionWaitIsSettled,
} from "../dist/background/provisioningWaits.js";

// BB-AUD-09. These decisions used to sit inside the service-worker entry beside the Chrome
// calls that carry them out, so each one could only be reached by driving a whole
// conversation open against a live browser.

const session = (overrides = {}) => ({
  id: "session-1",
  provider: "generic",
  tabId: 1,
  frameId: 0,
  documentToken: "document-1",
  conversationUrl: "https://example.invalid/c/1",
  conversationIdentity: "conversation-1",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const immediateDelay = async () => undefined;

test("a settled session is one the page will not move out of on its own", () => {
  ["ready", "notAuthenticated", "failed"].forEach((status) => {
    assert.equal(sessionWaitIsSettled(session({ status })), true, status);
  });
  ["disconnected", "notReady", "submitting", "streaming"].forEach((status) => {
    assert.equal(sessionWaitIsSettled(session({ status })), false, status);
  });
});

test("a provider tab counts as loaded only when it finished on that provider's own page", () => {
  assert.equal(providerTabIsLoaded({ status: "complete", url: "https://chatgpt.com/" }, "chatgpt"), true);
  assert.equal(providerTabIsLoaded({ status: "loading", url: "https://chatgpt.com/" }, "chatgpt"), false);
  assert.equal(providerTabIsLoaded({ status: "complete", url: "https://claude.ai/" }, "chatgpt"), false);
  assert.equal(providerTabIsLoaded({ status: "complete" }, "chatgpt"), false);
  assert.equal(providerTabIsLoaded({}, "chatgpt"), false);
});

test("a session is matched on both the tab and the provider", () => {
  const sessions = [
    session({ id: "a", tabId: 1, provider: "generic" }),
    session({ id: "b", tabId: 2, provider: "chatgpt" }),
  ];
  assert.equal(sessionForProviderTab(sessions, 2, "chatgpt")?.id, "b");
  assert.equal(sessionForProviderTab(sessions, 2, "generic"), undefined);
  assert.equal(sessionForProviderTab(sessions, 3, "generic"), undefined);
});

test("polling stops at the first settled answer", async () => {
  const answers = [undefined, session({ status: "notReady" }), session({ status: "ready" })];
  let reads = 0;
  const outcome = await pollUntilSettled({
    read: async () => answers[reads++],
    settled: sessionWaitIsSettled,
    timeoutMs: 1_000,
    intervalMs: 1,
    signal: new AbortController().signal,
    now: () => 0,
    delay: immediateDelay,
  });
  assert.equal(outcome.settled?.status, "ready");
  assert.equal(reads, 3);
});

test("polling carries the last unsettled answer out of a timeout", async () => {
  let clock = 0;
  const outcome = await pollUntilSettled({
    read: async () => session({ status: "notReady" }),
    settled: sessionWaitIsSettled,
    timeoutMs: 30,
    intervalMs: 10,
    signal: new AbortController().signal,
    now: () => {
      clock += 10;
      return clock - 10;
    },
    delay: immediateDelay,
  });
  assert.equal(outcome.settled, undefined);
  assert.equal(outcome.lastObserved?.status, "notReady");
});

test("polling that never read anything reports nothing observed", async () => {
  const outcome = await pollUntilSettled({
    read: async () => undefined,
    settled: () => true,
    timeoutMs: 0,
    intervalMs: 10,
    signal: new AbortController().signal,
    now: () => 0,
    delay: immediateDelay,
  });
  assert.equal(outcome.settled, undefined);
  assert.equal(outcome.lastObserved, undefined);
});

test("polling ends with the cancellation error, not a timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pollUntilSettled({
      read: async () => session(),
      settled: () => false,
      timeoutMs: 1_000,
      intervalMs: 1,
      signal: controller.signal,
      now: () => 0,
      delay: immediateDelay,
    }),
    /cancelled/u,
  );
});

test("polling uses the wall clock and a real delay when none are supplied", async () => {
  const outcome = await pollUntilSettled({
    read: async () => session({ status: "ready" }),
    settled: sessionWaitIsSettled,
    timeoutMs: 1_000,
    intervalMs: 1,
    signal: new AbortController().signal,
  });
  assert.equal(outcome.settled?.status, "ready");
});

test("a single ready generic tab is unambiguous", () => {
  const only = session({ id: "only" });
  assert.equal(selectGenericSession({ readySessions: [only] }).session?.id, "only");
});

test("no ready generic tab refuses with the binding instruction", () => {
  const refusal = selectGenericSession({ readySessions: [] }).refusal;
  assert.equal(refusal?.code, "PROVIDER_NOT_READY");
  assert.match(refusal?.message ?? "", /Bind and validate/u);
});

test("several ready generic tabs refuse rather than guess", () => {
  const refusal = selectGenericSession({
    readySessions: [session({ id: "a", tabId: 1 }), session({ id: "b", tabId: 2 })],
  }).refusal;
  assert.equal(refusal?.code, "PROVIDER_SELECTION_REQUIRED");
});

test("an exact tab or conversation identity resolves an otherwise ambiguous choice", () => {
  const readySessions = [
    session({ id: "a", tabId: 1, conversationIdentity: "one" }),
    session({ id: "b", tabId: 2, conversationIdentity: "two" }),
  ];
  assert.equal(selectGenericSession({ readySessions, preferredTabId: 2 }).session?.id, "b");
  assert.equal(
    selectGenericSession({ readySessions, preferredConversationIdentity: "one" }).session?.id,
    "a",
  );
  assert.equal(
    selectGenericSession({ readySessions, preferredTabId: 9 }).refusal?.code,
    "PROVIDER_SELECTION_REQUIRED",
  );
});

test("a preferred origin narrows the choice and an unparsable url never matches", () => {
  const readySessions = [
    session({ id: "a", tabId: 1, conversationUrl: "https://one.invalid/c/1" }),
    session({ id: "b", tabId: 2, conversationUrl: "https://two.invalid/c/2" }),
    session({ id: "c", tabId: 3, conversationUrl: "not a url" }),
  ];
  assert.equal(
    selectGenericSession({ readySessions, preferredOrigin: "https://two.invalid" }).session?.id,
    "b",
  );
  assert.equal(
    selectGenericSession({ readySessions, preferredOrigin: "https://three.invalid" }).refusal?.code,
    "PROVIDER_SELECTION_REQUIRED",
  );
});

test("a page that confirms freshness is accepted", () => {
  const selected = session();
  const verdict = freshGenericVerdict({
    selected,
    session: selected,
    commandResult: { ok: true, value: { freshnessConfirmed: true } },
    commandError: undefined,
  });
  assert.equal(verdict.session?.id, selected.id);
});

test("a different conversation is accepted as fresh without the page saying so", () => {
  const selected = session();
  const verdict = freshGenericVerdict({
    selected,
    session: session({ conversationIdentity: "changed" }),
    commandResult: { ok: true, value: {} },
    commandError: undefined,
  });
  assert.equal(verdict.refusal, undefined);
});

// BB-A4-F07. Reloading the tab the command was sent to replaces the document and the session
// while the page comes back on the same transcript. Neither replacement says the New
// Conversation control did anything, and reporting one as freshness hands the caller the old
// conversation.
test("a replaced document or session on the same conversation is not fresh evidence", () => {
  const selected = session();
  ["documentToken", "id"].forEach((field) => {
    const verdict = freshGenericVerdict({
      selected,
      session: session({ [field]: "changed" }),
      commandResult: { ok: true, value: {} },
      commandError: undefined,
    });
    assert.equal(verdict.refusal?.code, "OPEN_CONVERSATION_FAILED", field);
    assert.match(verdict.refusal?.message ?? "", /evidence was not observed/u, field);
  });
});

test("an unchanged conversation is refused however quiet the command was", () => {
  const selected = session();
  const verdict = freshGenericVerdict({
    selected,
    session: selected,
    commandResult: { ok: true, value: {} },
    commandError: undefined,
  });
  assert.equal(verdict.refusal?.code, "OPEN_CONVERSATION_FAILED");
  assert.match(verdict.refusal?.message ?? "", /evidence was not observed/u);
});

test("the refusal quotes the page's own error, then the thrown one", () => {
  const selected = session();
  assert.match(
    freshGenericVerdict({
      selected,
      session: selected,
      commandResult: { ok: false, error: "no new-conversation control" },
      commandError: new Error("ignored"),
    }).refusal?.message ?? "",
    /no new-conversation control/u,
  );
  assert.match(
    freshGenericVerdict({
      selected,
      session: selected,
      commandResult: undefined,
      commandError: new Error("the tab never answered"),
    }).refusal?.message ?? "",
    /the tab never answered/u,
  );
  assert.match(
    freshGenericVerdict({
      selected,
      session: undefined,
      commandResult: "not a record",
      commandError: "not an error",
    }).refusal?.message ?? "",
    /evidence was not observed/u,
  );
});

test("an unauthenticated generic page is named as one", () => {
  const selected = session();
  const verdict = freshGenericVerdict({
    selected,
    session: session({ id: "other", status: "notAuthenticated" }),
    commandResult: { ok: true, value: { freshnessConfirmed: true } },
    commandError: undefined,
  });
  assert.equal(verdict.refusal?.code, "AUTHENTICATION_REQUIRED");
});

test("a ready opened session is accepted", () => {
  assert.equal(openedSessionRefusal({ session: session(), recycled: false }), undefined);
});

test("an unready session is refused and named by how it was obtained", () => {
  assert.equal(
    openedSessionRefusal({ session: session({ status: "notAuthenticated" }), recycled: false })?.code,
    "AUTHENTICATION_REQUIRED",
  );
  const failed = openedSessionRefusal({ session: session({ status: "failed" }), recycled: true });
  assert.equal(failed?.code, "PROVIDER_NOT_READY");
  assert.match(failed?.message ?? "", /recycled provider conversation is failed/u);
  assert.match(
    openedSessionRefusal({ session: session({ status: "failed" }), recycled: false })?.message ?? "",
    /opened provider conversation is failed/u,
  );
});

test("a recycled tab that came back on the same conversation is refused", () => {
  assert.equal(
    openedSessionRefusal({
      session: session({ conversationIdentity: "same" }),
      recycled: true,
      preferredConversationIdentity: "same",
    })?.code,
    "OPEN_CONVERSATION_FAILED",
  );
  assert.equal(
    openedSessionRefusal({
      session: session({ conversationIdentity: "new" }),
      recycled: true,
      preferredConversationIdentity: "same",
    }),
    undefined,
  );
  // A freshly opened tab is never compared: it was never the caller's conversation.
  assert.equal(
    openedSessionRefusal({
      session: session({ conversationIdentity: "same" }),
      recycled: false,
      preferredConversationIdentity: "same",
    }),
    undefined,
  );
});

// BB-A4-COV. The waits themselves. Each one is a deadline, an interval, a judgement about what
// was read and what to say when nothing settled; the Chrome call is the caller's. While these
// lived in the service-worker entry the only way to reach them was to open a whole conversation
// against a live browser, so what they do when nothing settles was measured by nothing.

const openSignal = new AbortController().signal;

// A clock the test moves itself, so a wait that must time out does so without waiting.
const steppingClock = (steps) => {
  let index = 0;
  return { now: () => steps[Math.min(index++, steps.length - 1)], delay: immediateDelay };
};

test("a tab wait ends when the tab is loaded on the provider's own page", async () => {
  const reads = [];
  await awaitLoadedProviderTab({
    read: async () => {
      reads.push("read");
      return reads.length === 1
        ? { status: "loading", url: "https://chatgpt.com/" }
        : { status: "complete", url: "https://chatgpt.com/c/1" };
    },
    provider: "chatgpt",
    timeoutMs: 1_000,
    signal: openSignal,
    now: () => 0,
    delay: immediateDelay,
  });
  assert.equal(reads.length, 2, "the wait stopped before the tab finished loading");
});

test("a tab that never finishes loading is reported as that, not as a missing page", async () => {
  await assert.rejects(
    awaitLoadedProviderTab({
      read: async () => ({ status: "loading", url: "https://chatgpt.com/" }),
      provider: "chatgpt",
      timeoutMs: 10,
      signal: openSignal,
      ...steppingClock([0, 0, 100]),
    }),
    /did not finish loading/u,
  );
});

test("a session wait answers with the settled session on that tab", async () => {
  const answered = await awaitSessionOnTab({
    readSessions: async () => [session({ tabId: 7, provider: "chatgpt", status: "ready" })],
    tabId: 7,
    provider: "chatgpt",
    timeoutMs: 1_000,
    signal: openSignal,
    now: () => 0,
    delay: immediateDelay,
  });
  assert.equal(answered.tabId, 7);
});

test("a session seen only in a transient state is still the answer", async () => {
  const answered = await awaitSessionOnTab({
    readSessions: async () => [session({ tabId: 7, provider: "chatgpt", status: "loading" })],
    tabId: 7,
    provider: "chatgpt",
    timeoutMs: 10,
    signal: openSignal,
    absent: "nothing registered",
    ...steppingClock([0, 0, 100]),
  });
  assert.equal(answered.status, "loading", "a transient session was discarded for nothing at all");
});

test("a wait that saw no session at all says so in the caller's own words", async () => {
  await assert.rejects(
    awaitSessionOnTab({
      readSessions: async () => [],
      tabId: 7,
      provider: "chatgpt",
      timeoutMs: 10,
      signal: openSignal,
      absent: "nothing registered",
      ...steppingClock([0, 0, 100]),
    }),
    /nothing registered/u,
  );
});

test("the provider and generic waits each name the page they were waiting on", async () => {
  await assert.rejects(
    awaitProviderSession({
      readSessions: async () => [],
      tabId: 7,
      provider: "chatgpt",
      timeoutMs: 10,
      signal: openSignal,
      ...steppingClock([0, 0, 100]),
    }),
    /The provider page did not register a browser session/u,
  );
  await assert.rejects(
    awaitGenericSession({
      readSessions: async () => [],
      tabId: 7,
      timeoutMs: 10,
      signal: openSignal,
      ...steppingClock([0, 0, 100]),
    }),
    /The generic provider page did not register a browser session/u,
  );
  // The generic wait asks for generic sessions and nothing else.
  const answered = await awaitGenericSession({
    readSessions: async () => [
      session({ tabId: 7, provider: "chatgpt", status: "ready" }),
      session({ tabId: 7, provider: "generic", status: "ready", id: "generic-session" }),
    ],
    tabId: 7,
    timeoutMs: 1_000,
    signal: openSignal,
    now: () => 0,
    delay: immediateDelay,
  });
  assert.equal(answered.id, "generic-session");
});

// With no clock handed in, a wait uses the real one. Both cases settle on the first read, so
// nothing here sleeps.
test("a wait with no clock supplied reads the real one", async () => {
  await awaitLoadedProviderTab({
    read: async () => ({ status: "complete", url: "https://chatgpt.com/c/1" }),
    provider: "chatgpt",
    timeoutMs: 1_000,
    signal: openSignal,
  });
  const answered = await awaitProviderSession({
    readSessions: async () => [session({ tabId: 7, provider: "chatgpt", status: "ready" })],
    tabId: 7,
    provider: "chatgpt",
    timeoutMs: 1_000,
    signal: openSignal,
  });
  assert.equal(answered.tabId, 7);
});
