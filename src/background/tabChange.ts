import {
  canonicalConversationUrl,
  isSupportedInitialTransition,
  isSupportedInitialTransitionStart,
  providerForUrl,
} from "./conversation.js";
import type { ActiveRequest, DocumentBinding } from "./routerState.js";

/**
 * BB-AUD-09. What a tab update means for the work bound to that tab.
 *
 * Chrome reports a URL change and a load completion through the same event, and what follows
 * differs completely: a Generic tab that left its bound origin loses its registration, a
 * provider tab that left supported sites loses its binding and fails its requests, a provider
 * tab that moved within one conversation keeps everything, and a tab mid-transition must not be
 * disturbed at all. Those judgements sat between `chrome.tabs.get`, `saveStored` and
 * `ensureContentScript` in the service-worker entry, so each was reachable only by driving a
 * whole tab lifecycle. The Chrome calls and the persistence stay in the entry; the judgements
 * are here, and every one of them is a total function of the event and the state it is judged
 * against.
 *
 * The verdicts are named rather than boolean because what the entry must do differs per verdict
 * — one stops the whole update, one carries a different user-facing failure, and one only
 * suppresses a status refresh — and a boolean would have made the caller re-derive which.
 */

export type GenericTabChangeVerdict = {
  /** The tab navigated away from the origin its registration was bound to. */
  leftOrigin: boolean;
  /** Whether the popup and the controller should be told the tab's status may have moved. */
  refreshStatus: boolean;
};

const originOf = (url: string): string | undefined => {
  try {
    const next = new URL(url);
    return next.protocol === "http:" || next.protocol === "https:" ? next.origin : undefined;
  } catch {
    return undefined;
  }
};

export const genericTabChangeVerdict = (input: {
  url?: string | undefined;
  status?: string | undefined;
  registeredOrigin: string;
}): GenericTabChangeVerdict => {
  if (typeof input.url === "string" && originOf(input.url) !== input.registeredOrigin) {
    return { leftOrigin: true, refreshStatus: true };
  }
  return {
    leftOrigin: false,
    refreshStatus: typeof input.url === "string" || input.status === "complete",
  };
};

export type ProviderTabUrlVerdict =
  | { verdict: "no-url-change" }
  | { verdict: "left-supported-sites"; failure: string }
  | { verdict: "left-its-conversation"; failure: string; suppressRefresh: false }
  | { verdict: "document-replaced"; failure: string; suppressRefresh: false }
  | { verdict: "kept"; suppressRefresh: boolean };

const pendingInitialTransitionMatches = (
  binding: DocumentBinding | undefined,
  request: ActiveRequest | undefined,
): boolean =>
  Boolean(
    binding &&
      request &&
      request.provider === binding.provider &&
      request.tabId === binding.tabId &&
      request.frameId === binding.frameId &&
      request.documentId === binding.documentId &&
      request.documentToken === binding.documentToken &&
      request.conversationUrl === binding.conversationUrl &&
      request.conversationIdentity === binding.conversationIdentity &&
      request.initialConversationUrl === request.conversationUrl &&
      request.allowInitialConversationTransition &&
      !request.transitionUsed &&
      isSupportedInitialTransitionStart(request.provider, request.conversationUrl),
  );

/**
 * A pending initial transition is the one navigation a bound request is allowed to make, so a
 * tab making it is not a tab that lost its binding: nothing is dropped and no status refresh is
 * published, because the transition itself will publish one when the content script confirms it.
 */
export const providerTabUrlVerdict = (input: {
  url?: string | undefined;
  status?: string | undefined;
  binding?: DocumentBinding | undefined;
  activeRequest?: ActiveRequest | undefined;
  /**
   * BR-G6-09. The document Chrome has just committed, when the report named one. A reload and a
   * tab replacement both land on the same URL, so a URL comparison cannot see them: the page the
   * bridge was talking to is gone, its content script with it, and the binding and the request
   * survive pointing at a document that no longer exists. That request never submits, never
   * captures and never fails.
   */
  documentId?: string | undefined;
}): ProviderTabUrlVerdict => {
  const { url, status, binding, activeRequest, documentId } = input;
  if (typeof url !== "string") {
    if (status === "complete" && pendingInitialTransitionMatches(binding, activeRequest)) {
      return { verdict: "kept", suppressRefresh: true };
    }
    return { verdict: "no-url-change" };
  }
  const provider = providerForUrl(url);
  if (!provider) {
    return {
      verdict: "left-supported-sites",
      failure: "The selected browser tab navigated to an unsupported site",
    };
  }
  const nextUrl = canonicalConversationUrl(provider, url);
  const permittedPendingTransition = Boolean(
    pendingInitialTransitionMatches(binding, activeRequest) &&
    (documentId === undefined ||
      binding?.documentId === undefined ||
      documentId === binding.documentId) &&
    activeRequest &&
      activeRequest.provider === provider &&
      isSupportedInitialTransition(activeRequest.provider, activeRequest.conversationUrl, nextUrl),
  );
  if (
    binding &&
    (binding.provider !== provider || binding.conversationUrl !== nextUrl) &&
    !permittedPendingTransition
  ) {
    return {
      verdict: "left-its-conversation",
      failure: "The selected browser tab navigated",
      suppressRefresh: false,
    };
  }
  if (
    binding &&
    !permittedPendingTransition &&
    documentId !== undefined &&
    binding.documentId !== undefined &&
    binding.documentId !== documentId
  ) {
    return {
      verdict: "document-replaced",
      failure: "The selected browser document was replaced",
      suppressRefresh: false,
    };
  }
  return { verdict: "kept", suppressRefresh: permittedPendingTransition };
};

/**
 * Whether a finished load is worth asking Chrome about. A tab nobody is tracking is not, and a
 * tab in the middle of a permitted transition must not be re-injected under the turn that is
 * running on it.
 */
export const tabSupportProbeNeeded = (input: {
  suppressRefresh: boolean;
  status?: string | undefined;
  tracked: boolean;
}): boolean => !input.suppressRefresh && input.status === "complete" && input.tracked;

/** What Chrome answered about the tab: a supported provider page, or not one. */
export const probedTabSupported = (url: unknown): boolean =>
  typeof url === "string" && providerForUrl(url) !== undefined;

export const refreshAfterTabChange = (input: {
  suppressRefresh: boolean;
  url?: string | undefined;
  status?: string | undefined;
}): boolean =>
  !input.suppressRefresh && (typeof input.url === "string" || input.status === "complete");
