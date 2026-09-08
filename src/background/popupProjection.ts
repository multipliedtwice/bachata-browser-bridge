/**
 * The popup's view of the worker's state.
 *
 * The popup shows one row per provider tab, and each row's status, readiness, reason and
 * conversation identity are decided from the sessions the worker built. That projection sat
 * beside the `chrome.tabs.query` and session build that feed it, so the shape the popup
 * actually receives could only be reached by driving the whole worker. The Chrome reads stay
 * in the entry; what they project to is decided here.
 */
import type { BrowserProvider, BrowserSession, BrowserSessionCapabilities } from "../protocol/types.js";
import { popupStatusReason } from "./routerState.js";
import type { PopupRecovery } from "./popupRecovery.js";

export type ProviderTab = {
  id: number;
  provider: BrowserProvider;
  title: string;
  url: string;
};

export type PopupTab = ProviderTab & {
  status: BrowserSession["status"] | "unregistered";
  ready: boolean;
  reason: string;
  sessionId?: string;
  conversationUrl?: string;
  conversationIdentity?: string;
  capabilities?: BrowserSessionCapabilities;
  recovery?: PopupRecovery;
  manualSelectionAvailable?: boolean;
};

export const isPopupCapabilities = (value: unknown): value is BrowserSessionCapabilities => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.keys(value).every((key) => [
    "submission", "completion", "interruption", "assets", "conversationState",
  ].includes(key))) return false;
  return "submission" in value && typeof value.submission === "string" && ["verifiedSend", "syntheticEnter", "native"].includes(value.submission)
    && "completion" in value && typeof value.completion === "string" && ["verifiedLifecycle", "manualOnly", "native"].includes(value.completion)
    && "interruption" in value && typeof value.interruption === "string" && ["confirmed", "unavailable", "native"].includes(value.interruption)
    && "assets" in value && (value.assets === "supported" || value.assets === "textOnly")
    && "conversationState" in value && (value.conversationState === "confirmed" || value.conversationState === "uncertain");
};

export const popupCapabilityDescription = (capabilities: BrowserSessionCapabilities | undefined): {
  summary: string;
  details: string;
} => {
  if (!capabilities) return { summary: "Capabilities not reported", details: "Refresh this conversation to check available actions." };
  const completion = capabilities.completion === "manualOnly" ? "Manual response selection required" : "Automatic completion available";
  const conversation = capabilities.conversationState === "uncertain" ? "Conversation uncertain" : "Conversation confirmed";
  const submission = capabilities.submission === "verifiedSend" ? "Send control verified"
    : capabilities.submission === "syntheticEnter" ? "Keyboard fallback for Send" : "Provider Send supported";
  const interruption = capabilities.interruption === "confirmed" ? "Stop confirmed"
    : capabilities.interruption === "unavailable" ? "Stop unavailable" : "Provider Stop supported";
  const assets = capabilities.assets === "supported" ? "Text and assets" : "Text only";
  return {
    summary: [completion, ...(capabilities.conversationState === "uncertain" ? [conversation] : []),
      ...(capabilities.interruption === "unavailable" ? [interruption] : [])].join(" · "),
    details: [submission, completion, interruption, assets, conversation].join(" · "),
  };
};

export type PopupState = {
  endpoint?: string;
  selectedTabId?: number;
  revision: number;
  connected: boolean;
  connecting: boolean;
  retryInMs?: number | undefined;
  error?: string | undefined;
  tabs: PopupTab[];
};

/**
 * BR-G6-15. The bounds the popup enforces on everything it is handed.
 *
 * The popup validates the whole state as one value: a single field over its limit fails the
 * whole structure and the popup shows nothing at all — no tabs, no endpoint, no error — for one
 * long but perfectly valid title or conversation URL. The producer holds the same numbers now,
 * so a long value costs its own field and nothing else.
 */
export const POPUP_LIMITS = {
  tabs: 200,
  title: 512,
  url: 4_096,
  reason: 1_024,
  sessionId: 256,
  conversationUrl: 4_096,
  conversationIdentity: 512,
  endpoint: 2_048,
  error: 4_096,
} as const;

const bounded = (value: string, maximum: number): string =>
  value.length <= maximum ? value : value.slice(0, maximum);

/**
 * BB-A4-N07. The bound conversation is pinned into the projection before the cap is applied.
 *
 * The cap was taken blind to the selection, so past two hundred provider tabs the selected one
 * could be dropped while the state still reported its id: the popup showed no bound row and no
 * Unbind control, while the worker kept routing turns to it. A selection nothing can see reads as
 * unbound, and it is not.
 */
const withSelectedTab = <T extends { id: number }>(
  tabs: readonly T[],
  selectedTabId: number | undefined,
): T[] => {
  const kept = tabs.slice(0, POPUP_LIMITS.tabs);
  if (kept.some((tab) => tab.id === selectedTabId)) {
    return kept;
  }
  const selected = tabs.find((tab) => tab.id === selectedTabId);
  return selected === undefined ? kept : [selected, ...kept.slice(0, POPUP_LIMITS.tabs - 1)];
};

/**
 * A tab with no session of its own is shown as unregistered rather than omitted, so the popup
 * can explain why a tab the user is looking at is not usable yet.
 */
export const projectPopupTabs = (
  tabs: readonly ProviderTab[],
  sessions: readonly BrowserSession[],
  selectedTabId: number | undefined,
): PopupTab[] => {
  const sessionsByTab = new Map(sessions.map((session) => [session.tabId, session]));
  return withSelectedTab(tabs, selectedTabId).map((tab) => {
    const session = sessionsByTab.get(tab.id);
    const status = session?.status ?? "unregistered";
    return {
      ...tab,
      title: bounded(tab.title, POPUP_LIMITS.title),
      url: bounded(tab.url, POPUP_LIMITS.url),
      status,
      ready: status === "ready",
      reason: bounded(popupStatusReason(status), POPUP_LIMITS.reason),
      ...(session
        ? {
            sessionId: bounded(session.id, POPUP_LIMITS.sessionId),
            conversationUrl: bounded(session.conversationUrl, POPUP_LIMITS.conversationUrl),
            conversationIdentity: bounded(
              session.conversationIdentity,
              POPUP_LIMITS.conversationIdentity,
            ),
            ...(isPopupCapabilities(session.capabilities) ? { capabilities: { ...session.capabilities } } : {}),
          }
        : {}),
    };
  });
};

/**
 * An endpoint or selected tab that was never stored is left out of the projection rather than
 * sent as an empty value, so the popup can tell "not configured" from "configured as blank".
 */
export const projectPopupState = (input: {
  endpoint?: string | undefined;
  selectedTabId?: number | undefined;
  revision: number;
  connected: boolean;
  connecting: boolean;
  retryInMs?: number | undefined;
  error?: string | undefined;
  tabs: PopupTab[];
}): PopupState => ({
  ...(input.endpoint ? { endpoint: bounded(input.endpoint, POPUP_LIMITS.endpoint) } : {}),
  ...(input.selectedTabId ? { selectedTabId: input.selectedTabId } : {}),
  revision: input.revision,
  connected: input.connected,
  connecting: input.connecting,
  retryInMs: input.retryInMs,
  error: input.error === undefined ? undefined : bounded(input.error, POPUP_LIMITS.error),
  tabs: withSelectedTab(input.tabs, input.selectedTabId),
});
