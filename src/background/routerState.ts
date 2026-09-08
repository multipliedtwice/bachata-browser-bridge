import type {
  BrowserProvider,
  BrowserSession,
  ConversationBinding,
  ServerMessage,
} from "../protocol/types.js";
import {
  canonicalConversationUrl,
  conversationIdentityFor,
  providerForUrl,
  sessionIdForConversation,
} from "./conversation.js";
import { normalizeBridgeEndpoint } from "./endpoint.js";
import { sanitizeReconnectMetadata } from "./reconnect.js";

/*
 * BB-AUD-09. Pure state and routing decisions lifted out of `background/index.ts`.
 *
 * Both functions below are total functions of their arguments: no `chrome` surface, no
 * module state, no I/O. Inside a 3,200-line service-worker entry they were reachable from a
 * test only by loading the whole worker and driving it through the extension APIs, which is
 * why their branches — nine identity comparisons, and a dozen validation paths over
 * untrusted persisted JSON — were among the least covered code in the repository.
 */

export type ActiveRequest = ConversationBinding & {
  allowInitialConversationTransition: boolean;
  deadlineAt: number;
  transitionUsed: boolean;
  initialConversationUrl: string;
  submissionCommitted?: boolean;
  submissionAttempted?: boolean;
};

export type StoredState = {
  endpoint?: string | undefined;
  connectionToken?: string | undefined;
  selectedTabId?: number | undefined;
  selectedSessionId?: string | undefined;
  handledTabIds?: number[] | undefined;
  reconnectAttempt?: number | undefined;
  reconnectAt?: number | undefined;
};

/**
 * Whether an interrupt names exactly the request that is running.
 *
 * Every field must match, because an interrupt that matched loosely would stop a different
 * turn than the one the user asked to stop. `canonicalConversationUrl` can throw on a URL
 * the provider never produced; a malformed interrupt matches nothing rather than failing
 * the caller.
 */
export const interruptMatchesRequest = (
  message: Extract<ServerMessage, { type: "conversation.interrupt" }>,
  request: ActiveRequest,
): boolean => {
  try {
    const conversationUrl = canonicalConversationUrl(message.provider, message.conversationUrl);
    // BR-G6-04. An accepted first-turn transition moves the request onto the conversation the
    // provider created for the turn, but the controller's Stop still names the conversation it
    // authorized. Both name this request; every other conversation still matches nothing.
    const namesThisConversation =
      (request.conversationUrl === conversationUrl
        && request.conversationIdentity === message.conversationIdentity)
      || (request.transitionUsed
        && request.initialConversationUrl === conversationUrl
        && conversationIdentityFor(message.provider, request.initialConversationUrl)
          === message.conversationIdentity);
    return request.agentId === message.agentId
      && request.provider === message.provider
      && request.sessionId === message.sessionId
      && request.tabId === message.tabId
      && request.frameId === message.frameId
      && request.documentId === message.documentId
      && request.documentToken === message.documentToken
      && namesThisConversation;
  } catch {
    return false;
  }
};

/**
 * Normalises persisted worker state.
 *
 * The input is whatever `chrome.storage.local` returns, which is attacker-adjacent: it
 * survives extension updates and can be edited. Every field is validated rather than
 * trusted, and an unusable endpoint is reported separately so the caller can tell the user
 * its saved endpoint was dropped instead of silently reconnecting to nothing.
 */
export const storedStateFrom = (
  value: unknown,
): { state: StoredState; invalidEndpoint: boolean } => {
  if (!isStoredRecord(value)) {
    return { state: {}, invalidEndpoint: false };
  }
  const candidate = value;
  let endpoint: string | undefined;
  let invalidEndpoint = false;
  if (candidate.endpoint !== undefined) {
    try {
      endpoint = normalizeBridgeEndpoint(candidate.endpoint);
    } catch {
      invalidEndpoint = true;
    }
  }
  // A token without an endpoint addresses nothing, so it is dropped with it.
  const connectionToken = endpoint && typeof candidate.connectionToken === "string" && candidate.connectionToken.trim()
    ? candidate.connectionToken.trim()
    : undefined;
  const selectedTabId = Number.isInteger(candidate.selectedTabId) && Number(candidate.selectedTabId) > 0
    ? Number(candidate.selectedTabId)
    : undefined;
  const handledTabIds = Array.isArray(candidate.handledTabIds)
    ? Array.from(new Set(candidate.handledTabIds
        .filter((item): item is number => Number.isInteger(item) && Number(item) > 0)))
        .sort((left, right) => left - right)
    : undefined;
  const reconnect = sanitizeReconnectMetadata(candidate, connectionToken);
  return {
    state: {
      ...(endpoint ? { endpoint } : {}),
      ...(connectionToken ? { connectionToken } : {}),
      ...(selectedTabId ? { selectedTabId } : {}),
      ...(selectedTabId && typeof candidate.selectedSessionId === "string" && candidate.selectedSessionId.trim()
        ? { selectedSessionId: candidate.selectedSessionId.trim() }
        : {}),
      ...(handledTabIds && handledTabIds.length > 0 ? { handledTabIds } : {}),
      ...reconnect,
    },
    invalidEndpoint,
  };
};

export type DocumentBinding = {
  provider: BrowserProvider;
  tabId: number;
  frameId: number;
  documentId?: string | undefined;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
};

export const sessionIdFor = (binding: DocumentBinding): string =>
  sessionIdForConversation(
    binding.provider,
    binding.tabId,
    binding.documentToken,
    binding.conversationIdentity,
  );

/** Whether a published session still names the document the binding was taken from. */
export const bindingMatchesSession = (
  binding: DocumentBinding,
  session: BrowserSession,
): boolean =>
  session.provider === binding.provider &&
  session.tabId === binding.tabId &&
  session.frameId === binding.frameId &&
  session.documentId === binding.documentId &&
  session.documentToken === binding.documentToken &&
  session.conversationUrl === binding.conversationUrl &&
  session.conversationIdentity === binding.conversationIdentity;

/**
 * Whether two bindings name the same document and conversation.
 *
 * `conversationUrl` is deliberately excluded: a same-document route change rewrites the URL
 * while the identity and the document token stay put, and an asset transfer bound before
 * that change must still be recognised as its own.
 */
export const sameDocumentBinding = (
  left: DocumentBinding,
  right: DocumentBinding,
): boolean =>
  left.provider === right.provider &&
  left.tabId === right.tabId &&
  left.frameId === right.frameId &&
  left.documentId === right.documentId &&
  left.documentToken === right.documentToken &&
  left.conversationIdentity === right.conversationIdentity;

/** Where a fresh conversation starts. Generic providers have no start URL by design. */
export const providerStartUrl = (provider: BrowserProvider): string => {
  if (provider === "chatgpt") {
    return "https://chatgpt.com/";
  }
  if (provider === "claude") {
    return "https://claude.ai/new";
  }
  throw new Error("Generic browser providers must be explicitly bound to an existing tab");
};

export const popupStatusReason = (
  status: BrowserSession["status"] | "unregistered",
): string => {
  if (status === "ready") {
    return "Ready";
  }
  if (status === "notAuthenticated") {
    return "Sign in to this provider tab, then refresh tabs.";
  }
  if (status === "notReady") {
    return "Open a conversation and wait for the page to finish loading.";
  }
  if (status === "submitting") {
    return "This conversation is submitting a message.";
  }
  if (status === "streaming") {
    return "This conversation is generating a response.";
  }
  if (status === "failed") {
    return "The provider page reported a failure. Reload it, then refresh tabs.";
  }
  if (status === "disconnected") {
    return "The provider page is disconnected. Reload it, then refresh tabs.";
  }
  return "Refresh tabs to inspect this provider page.";
};

const activeStateVersion = 8;

export const storageKey = `bachataBridgeState.v${String(activeStateVersion)}`;

/**
 * PAIR-ID-01. A legacy list is a record of what shipped, not of what the product is called.
 *
 * The `pair` to `bachata` rename rewrote these entries with everything else, and that turned a
 * historical record into a list of names no released build ever wrote: an extension upgrading from
 * a released version holds `pairBridgeState.v7` in `chrome.storage.local`, and a migration that
 * looks only for `bachataBridgeState.v7` finds nothing, drops the user's endpoint and bindings, and
 * reports no error while doing it. The same is true of the endpoint path a stored record carries.
 *
 * So both spellings are read, newest version first and the current spelling first within a version.
 * This decides nothing about the product's identity — that is PAIR-ID-01's to decide — because a
 * version below the active one can never become the active name again.
 */
const legacyStateVersions = [7, 6, 5, 4];

export const legacyStorageKeys = [
  /*
   * BR-G6-19. The active version's own older spelling. The list above reads both spellings for
   * every version below the active one, which was the whole point of it — and then missed the
   * one key a released build at this very version actually wrote. The rename changed the
   * spelling without changing the version, so `pairBridgeState.v8` holds a real pairing, real
   * bindings and a real endpoint, and nothing was looking for it.
   *
   * This decides nothing about the product's identity either: it is only read, never written,
   * and the current spelling still wins wherever both exist.
   */
  `pairBridgeState.v${String(activeStateVersion)}`,
  ...legacyStateVersions.flatMap((version) => [
    `bachataBridgeState.v${String(version)}`,
    `pairBridgeState.v${String(version)}`,
  ]),
];

const legacyEndpointPath = /\/(?:bachata|pair)-browser-bridge-v[4-8]$/u;

const isStoredRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * BB-A4-F19. The endpoint path a record carries, rewritten to the active protocol.
 *
 * The active storage key is where a release-era pairing lives once it has been written back
 * even once, and its endpoint still names the protocol version it was paired under. Rewriting
 * only on the legacy branch meant a populated current record was handed to the v9 validator
 * verbatim, refused, and its token dropped with it — the pairing was lost by the upgrade that
 * was supposed to carry it. The rewrite belongs to whichever record wins, not to where it was
 * found, and it decides nothing else: host, scheme and port are still `normalizeBridgeEndpoint`'s
 * to accept or refuse.
 */
const withActiveEndpointPath = (
  record: Record<string, unknown>,
): Record<string, unknown> => {
  if (typeof record.endpoint !== "string") {
    return record;
  }
  const endpoint = record.endpoint.replace(legacyEndpointPath, "/bachata-browser-bridge-v9");
  return endpoint === record.endpoint ? record : { ...record, endpoint };
};

/**
 * Picks the record to normalise out of everything storage returned.
 *
 * Only the newest legacy record is migrated, and only when the current key holds nothing:
 * an existing v8 record is authoritative even if older keys survive beside it. The endpoint
 * path is rewritten to the active protocol so a user who upgrades keeps their pairing.
 */
export const migratedStoredCandidate = (
  current: unknown,
  legacyValues: readonly unknown[],
): unknown => {
  const candidate = current ? current : legacyValues.find(Boolean);
  return isStoredRecord(candidate) ? withActiveEndpointPath(candidate) : current;
};

/** The part of a `chrome.runtime.MessageSender` a binding is derived from. */
export type MessageSenderLike = {
  tab?: { id?: number | undefined } | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
  documentId?: string | undefined;
};

/**
 * The document a content-script message actually came from, or nothing.
 *
 * The binding is rebuilt from the sender the browser vouches for rather than from anything
 * the message claims, so a page cannot address a document it does not own. Subframes are
 * refused outright: only the top frame of a supported provider tab may register.
 */
export const senderBinding = (
  sender: MessageSenderLike,
  documentTokenValue: unknown,
): DocumentBinding | undefined => {
  if (
    !sender.tab ||
    !Number.isInteger(sender.tab.id) ||
    sender.frameId !== 0 ||
    typeof sender.url !== "string" ||
    typeof documentTokenValue !== "string" ||
    !documentTokenValue
  ) {
    return undefined;
  }
  const provider = providerForUrl(sender.url);
  if (!provider) {
    return undefined;
  }
  const conversationUrl = canonicalConversationUrl(provider, sender.url);
  return {
    provider,
    tabId: sender.tab.id as number,
    frameId: sender.frameId,
    documentId: typeof sender.documentId === "string" ? sender.documentId : undefined,
    documentToken: documentTokenValue,
    conversationUrl,
    conversationIdentity: conversationIdentityFor(provider, conversationUrl),
  };
};

/**
 * Whether a running request belongs to the document and agent that just sent a message.
 *
 * A partial match is a mismatch: accepting one would let a stale document, or a different
 * agent sharing the tab, drive a turn it does not own.
 */
export const activeRequestMatchesSender = (
  request: ActiveRequest,
  binding: DocumentBinding,
  message: Record<string, unknown>,
): boolean =>
  request.provider === binding.provider &&
  request.tabId === binding.tabId &&
  request.frameId === binding.frameId &&
  request.documentId === binding.documentId &&
  request.documentToken === binding.documentToken &&
  request.conversationUrl === binding.conversationUrl &&
  request.conversationIdentity === binding.conversationIdentity &&
  request.agentId === message.agentId &&
  request.sessionId === message.sessionId;

/**
 * BB-AUD-09. Whether a content script's `content.transition` may move an in-flight request onto
 * the conversation the page navigated to.
 *
 * This is the one place a request's bound conversation may change while it is running, so it is
 * the one place that must be decided rather than assumed. It was decided inline in the service
 * worker beside the write it authorises, which meant the refusals could only be reached by
 * driving a whole turn. The refusal is a single verdict because the wire answer is a single
 * refusal: what varies is which of the nine conditions failed, and none of them is reported
 * separately.
 *
 * The accepted answer carries the state the caller must apply, so the decision and the write
 * cannot drift apart: the caller writes what this returned, and nothing it derived itself.
 */
export type InitialTransitionAdmission =
  | {
      admitted: true;
      conversationUrl: string;
      conversationIdentity: string;
      binding: DocumentBinding;
    }
  | { admitted: false };

export const admitInitialTransition = (input: {
  request?: ActiveRequest | undefined;
  binding?: DocumentBinding | undefined;
  message: Record<string, unknown>;
  supportedTransition: (
    provider: BrowserProvider,
    previousUrl: string,
    nextUrl: string,
  ) => boolean;
}): InitialTransitionAdmission => {
  const { request, binding, message } = input;
  if (
    !request ||
    !binding ||
    request.provider !== binding.provider ||
    request.tabId !== binding.tabId ||
    request.frameId !== binding.frameId ||
    request.documentId !== binding.documentId ||
    request.documentToken !== binding.documentToken ||
    request.agentId !== message.agentId ||
    request.sessionId !== message.sessionId ||
    // BR-G6-03. Only the content script knows whether the irreversible Send has happened, and
    // it asserts that here. A transition claimed before submission is somebody else's
    // navigation, not the conversation the provider assigned to this turn.
    message.submissionCommitted !== true ||
    !request.allowInitialConversationTransition ||
    request.transitionUsed ||
    !input.supportedTransition(
      request.provider,
      request.conversationUrl,
      binding.conversationUrl,
    )
  ) {
    return { admitted: false };
  }
  return {
    admitted: true,
    conversationUrl: binding.conversationUrl,
    conversationIdentity: binding.conversationIdentity,
    binding,
  };
};

/**
 * The tabs the worker has already injected into, normalised.
 *
 * The list is persisted, so it can come back with duplicates, non-integers or ids from a
 * browser session that no longer exists. Every read normalises rather than trusting: only
 * positive integers survive, duplicates collapse, and the order is stable so an unchanged
 * set never looks like a change worth persisting.
 */
export const normalizedHandledTabIds = (stored: StoredState): number[] =>
  Array.from(
    new Set(
      (stored.handledTabIds ?? []).filter(
        (tabId) => Number.isInteger(tabId) && tabId > 0,
      ),
    ),
  ).sort((left, right) => left - right);

export const withHandledTabs = (
  stored: StoredState,
  tabIds: readonly number[],
): number[] =>
  Array.from(new Set([...normalizedHandledTabIds(stored), ...tabIds]))
    .sort((left, right) => left - right);

/** The list with one tab dropped, or nothing at all when that was the last one. */
export const withoutHandledTab = (
  stored: StoredState,
  tabId: number,
): number[] | undefined => {
  const remaining = normalizedHandledTabIds(stored).filter((value) => value !== tabId);
  return remaining.length > 0 ? remaining : undefined;
};

export type ProviderTabLike = {
  id: number;
  provider: BrowserProvider;
  url: string;
};

export type ContentStatusLike = {
  status: string;
  documentToken?: string | undefined;
  conversationUrl?: string | undefined;
  conversationIdentity?: string | undefined;
};

export type ConversationAttestationLike = {
  documentToken: string;
  documentRevision: number;
  conversationUrl: string;
  conversationIdentity: string;
};

export type GenericStatusLike = {
  documentToken?: string | undefined;
  documentRevision?: number | undefined;
};

/**
 * Whether a registered document is still a candidate for the tab set that was just read.
 *
 * A binding outlives the page it was made on. The tab may be gone, may now hold another
 * provider, or may have navigated to a different conversation, and in each case the binding
 * names a document that is no longer there.
 */
export const bindingIsLiveOnTab = (
  binding: DocumentBinding,
  tab: ProviderTabLike | undefined,
): boolean =>
  tab !== undefined &&
  tab.provider === binding.provider &&
  canonicalConversationUrl(binding.provider, tab.url) === binding.conversationUrl;

/**
 * Whether the page that answered a status probe is the page the binding names.
 *
 * The probe is addressed to a tab and a frame, not to a document, so a reload or a route
 * change can be answered by a page the binding never described. A status the protocol does
 * not publish is refused for the same reason: an unpublishable state is not a session.
 */
export const contentStatusMatchesBinding = (
  status: ContentStatusLike,
  binding: DocumentBinding,
  publishedStatuses: ReadonlySet<string>,
): boolean =>
  status.documentToken === binding.documentToken &&
  status.conversationUrl !== undefined &&
  canonicalConversationUrl(binding.provider, status.conversationUrl) ===
    binding.conversationUrl &&
  status.conversationIdentity === binding.conversationIdentity &&
  publishedStatuses.has(status.status);

/**
 * Whether a generic page still holds the document and conversation it attested to.
 *
 * The attestation is made by the content script at capture time; this is read afterwards,
 * from the background, against a fresh status. A different document revision means the page
 * re-rendered under the extension, which is exactly what the attestation exists to catch.
 */
export const genericStatusMatchesAttestation = (
  status: GenericStatusLike,
  conversationUrl: string,
  conversationIdentity: string,
  attestation: ConversationAttestationLike,
): boolean =>
  status.documentToken === attestation.documentToken &&
  status.documentRevision === attestation.documentRevision &&
  conversationUrl === attestation.conversationUrl &&
  conversationIdentity === attestation.conversationIdentity;

/**
 * Which built session is the one an attestation describes, at the state it must be in.
 *
 * A provisional reuse is only provisional if the conversation is still quarantined; a
 * confirmed one is only confirmed if the page reports ready and the conversation is
 * confirmed. Accepting the wrong state would hand a caller a conversation the extension has
 * not proved safe to reuse.
 */
export const sessionForAttestation = (
  sessions: readonly BrowserSession[],
  tabId: number,
  attestation: ConversationAttestationLike,
  state: "provisional" | "confirmed",
): BrowserSession | undefined =>
  sessions.find(
    (candidate) =>
      candidate.provider === "generic" &&
      candidate.tabId === tabId &&
      candidate.documentToken === attestation.documentToken &&
      candidate.conversationUrl === attestation.conversationUrl &&
      candidate.conversationIdentity === attestation.conversationIdentity &&
      candidate.status === (state === "confirmed" ? "ready" : "notReady") &&
      candidate.capabilities?.conversationState ===
        (state === "confirmed" ? "confirmed" : "uncertain"),
  );
