/**
 * The decisions inside the provisioning waits.
 *
 * Opening a provider conversation polls Chrome: for the tab, for the session, and for the
 * generic binding. Each wait held the poll and the judgement it makes about what it read in
 * one body, so the judgement could only be reached by driving a whole conversation open.
 * The Chrome calls stay in the service-worker entry; what their answers mean is decided here.
 */
import type { BrowserProvider, BrowserSession } from "../protocol/types.js";
import { providerForUrl } from "./conversation.js";
import { abortableDelay, throwIfAborted } from "./cancellation.js";

export type ProvisioningRefusalCode =
  | "PROVIDER_NOT_READY"
  | "PROVIDER_SELECTION_REQUIRED"
  | "AUTHENTICATION_REQUIRED"
  | "OPEN_CONVERSATION_FAILED";

export type ProvisioningRefusal = {
  code: ProvisioningRefusalCode;
  message: string;
};

const settledSessionStatuses = new Set<BrowserSession["status"]>([
  "ready",
  "notAuthenticated",
  "failed",
]);

export const sessionWaitIsSettled = (session: BrowserSession): boolean =>
  settledSessionStatuses.has(session.status);

export const providerTabIsLoaded = (
  tab: { status?: string | undefined; url?: string | undefined },
  provider: BrowserProvider,
): boolean =>
  tab.status === "complete" &&
  typeof tab.url === "string" &&
  providerForUrl(tab.url) === provider;

export const sessionForProviderTab = (
  sessions: readonly BrowserSession[],
  tabId: number,
  provider: BrowserProvider,
): BrowserSession | undefined =>
  sessions.find(
    (candidate) => candidate.tabId === tabId && candidate.provider === provider,
  );

export type PollOutcome<T> =
  | { settled: T; lastObserved?: undefined }
  | { settled?: undefined; lastObserved: T | undefined };

/**
 * Polls a reader until what it returns is settled, the deadline passes, or the signal aborts.
 *
 * The reader is the Chrome call; `settled` is the judgement about its answer. The last value
 * the reader produced is carried out on timeout, because a session observed in a transient
 * state is still better evidence than none.
 */
export const pollUntilSettled = async <T>(input: {
  read: () => Promise<T | undefined>;
  settled: (value: T) => boolean;
  timeoutMs: number;
  intervalMs: number;
  signal: AbortSignal;
  now?: (() => number) | undefined;
  delay?: ((delayMs: number, signal: AbortSignal) => Promise<void>) | undefined;
}): Promise<PollOutcome<T>> => {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? abortableDelay;
  const deadline = now() + input.timeoutMs;
  let lastObserved: T | undefined;
  while (now() < deadline) {
    throwIfAborted(input.signal);
    const observed = await input.read();
    if (observed !== undefined) {
      lastObserved = observed;
      if (input.settled(observed)) return { settled: observed };
    }
    await delay(input.intervalMs, input.signal);
  }
  return { lastObserved };
};

/**
 * BB-A4-COV. The waits themselves, not only the judgements inside them.
 *
 * Each wait is a deadline, an interval, a judgement about what was read, and what to say when
 * nothing settled. Those four belong together and none of them is a Chrome call: the caller
 * hands in the read, and everything decided about its answer is decided here. Keeping the
 * wrappers in the service-worker entry meant that shape could only be reached by opening a whole
 * conversation, so it was measured by nothing.
 */
const provisioningPollIntervalMs = 100;

/** The clock and the sleep, so a wait can be driven without one. */
export type ProvisioningPollClock = {
  now?: (() => number) | undefined;
  delay?: ((delayMs: number, signal: AbortSignal) => Promise<void>) | undefined;
};

const pollClock = (clock: ProvisioningPollClock) => ({
  ...(clock.now === undefined ? {} : { now: clock.now }),
  ...(clock.delay === undefined ? {} : { delay: clock.delay }),
});

export const awaitLoadedProviderTab = async (input: ProvisioningPollClock & {
  read: () => Promise<{ status?: string | undefined; url?: string | undefined }>;
  provider: BrowserProvider;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> => {
  const outcome = await pollUntilSettled({
    read: input.read,
    settled: (tab) => providerTabIsLoaded(tab, input.provider),
    timeoutMs: input.timeoutMs,
    intervalMs: provisioningPollIntervalMs,
    signal: input.signal,
    ...pollClock(input),
  });
  if (outcome.settled === undefined) {
    throw new Error("The provider page did not finish loading");
  }
};

/**
 * A session observed in a transient state is still better evidence than none, so the last thing
 * the reader produced is accepted when nothing settled; only a wait that saw nothing at all is a
 * refusal, and it says which page it was waiting on.
 */
export const awaitSessionOnTab = async (input: ProvisioningPollClock & {
  readSessions: () => Promise<readonly BrowserSession[]>;
  tabId: number;
  provider: BrowserProvider;
  timeoutMs: number;
  signal: AbortSignal;
  absent: string;
}): Promise<BrowserSession> => {
  const outcome = await pollUntilSettled({
    read: async () => sessionForProviderTab(await input.readSessions(), input.tabId, input.provider),
    settled: sessionWaitIsSettled,
    timeoutMs: input.timeoutMs,
    intervalMs: provisioningPollIntervalMs,
    signal: input.signal,
    ...pollClock(input),
  });
  const session = outcome.settled ?? outcome.lastObserved;
  if (!session) {
    throw new Error(input.absent);
  }
  return session;
};

export const awaitProviderSession = async (input: ProvisioningPollClock & {
  readSessions: () => Promise<readonly BrowserSession[]>;
  tabId: number;
  provider: BrowserProvider;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<BrowserSession> =>
  await awaitSessionOnTab({
    ...input,
    absent: "The provider page did not register a browser session",
  });

export const awaitGenericSession = async (input: ProvisioningPollClock & {
  readSessions: () => Promise<readonly BrowserSession[]>;
  tabId: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<BrowserSession> =>
  await awaitSessionOnTab({
    ...input,
    provider: "generic",
    absent: "The generic provider page did not register a browser session",
  });

/**
 * Chooses the generic tab a provisioning request means.
 *
 * A generic target is bound by the user and never opened by the bridge, so an ambiguous
 * request is refused rather than guessed: one ready tab is unambiguous, and beyond that only
 * an exact tab or conversation identity resolves it.
 */
export const selectGenericSession = (input: {
  readySessions: readonly BrowserSession[];
  preferredOrigin?: string | undefined;
  preferredTabId?: number | undefined;
  preferredConversationIdentity?: string | undefined;
}): { session: BrowserSession; refusal?: undefined } | { session?: undefined; refusal: ProvisioningRefusal } => {
  const originMatches = input.preferredOrigin === undefined
    ? input.readySessions
    : input.readySessions.filter((session) => {
        try {
          return new URL(session.conversationUrl).origin === input.preferredOrigin;
        } catch {
          return false;
        }
      });
  const byTab = input.preferredTabId === undefined
    ? undefined
    : originMatches.find((session) => session.tabId === input.preferredTabId);
  const byIdentity = input.preferredConversationIdentity === undefined
    ? undefined
    : originMatches.find(
        (session) => session.conversationIdentity === input.preferredConversationIdentity,
      );
  const selected = byTab ?? byIdentity ?? (originMatches.length === 1 ? originMatches[0] : undefined);
  if (selected) return { session: selected };
  if (input.readySessions.length === 0) {
    return {
      refusal: {
        code: "PROVIDER_NOT_READY",
        message: "Bind and validate a generic browser-LLM tab before opening a generic conversation",
      },
    };
  }
  return {
    refusal: {
      code: "PROVIDER_SELECTION_REQUIRED",
      message: "Multiple generic browser-LLM tabs are ready; bind this agent to a specific generic tab first",
    },
  };
};

/**
 * Judges whether a generic new-conversation attempt produced a provably fresh conversation:
 * either the page confirmed it, or the session that came back is a different *conversation*
 * from the one the command was sent to. A quiet command with an unchanged session is not
 * evidence, so it is refused rather than reported as fresh.
 *
 * BB-A4-F07. A replaced document is not a new conversation. Reloading the tab the command was
 * sent to mints a new document token and a new session id while the page comes back on the same
 * transcript, so accepting either of those as freshness handed the caller the old conversation
 * with the New Conversation control never having worked. Only the conversation identity moving,
 * or the page saying so itself, is positive evidence.
 */
export const freshGenericVerdict = (input: {
  selected: BrowserSession;
  session: BrowserSession | undefined;
  commandResult: unknown;
  commandError: unknown;
}): { session: BrowserSession; refusal?: undefined } | { session?: undefined; refusal: ProvisioningRefusal } => {
  const resultRecord = input.commandResult && typeof input.commandResult === "object"
    ? input.commandResult as Record<string, unknown>
    : undefined;
  const valueRecord = resultRecord?.value && typeof resultRecord.value === "object"
    ? resultRecord.value as Record<string, unknown>
    : undefined;
  const explicitlyFresh = resultRecord?.ok === true && valueRecord?.freshnessConfirmed === true;
  const session = input.session;
  const freshConversationObserved = Boolean(
    session && session.conversationIdentity !== input.selected.conversationIdentity,
  );
  if (session && session.status === "ready" && (explicitlyFresh || freshConversationObserved)) {
    return { session };
  }
  const commandMessage = resultRecord?.ok === false && typeof resultRecord.error === "string"
    ? resultRecord.error
    : input.commandError instanceof Error
      ? input.commandError.message
      : "Fresh-conversation evidence was not observed";
  return {
    refusal: {
      code: session?.status === "notAuthenticated" ? "AUTHENTICATION_REQUIRED" : "OPEN_CONVERSATION_FAILED",
      message: `Unable to open a confirmed fresh generic conversation: ${commandMessage}. Bind or auto-detect the provider's New Conversation control.`,
    },
  };
};

/**
 * Judges a session the bridge opened or recycled. A recycled tab that came back on the same
 * conversation identity the caller asked to leave is refused: the reload did not produce a
 * new conversation, and reporting it as one would hand the caller the old transcript.
 */
export const openedSessionRefusal = (input: {
  session: BrowserSession;
  recycled: boolean;
  preferredConversationIdentity?: string | undefined;
}): ProvisioningRefusal | undefined => {
  if (input.session.status !== "ready") {
    return {
      code: input.session.status === "notAuthenticated"
        ? "AUTHENTICATION_REQUIRED"
        : "PROVIDER_NOT_READY",
      message: `The ${input.recycled ? "recycled" : "opened"} provider conversation is ${input.session.status}`,
    };
  }
  if (
    input.recycled &&
    input.preferredConversationIdentity &&
    input.session.conversationIdentity === input.preferredConversationIdentity
  ) {
    return {
      code: "OPEN_CONVERSATION_FAILED",
      message: "The recycled provider tab did not expose a fresh conversation identity",
    };
  }
  return undefined;
};
