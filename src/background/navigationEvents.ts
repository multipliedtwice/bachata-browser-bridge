/**
 * What Chrome's navigation events mean for a bound conversation.
 *
 * The bridge currently learns about route changes from a URL poll and from broad
 * `tabs.onUpdated`, neither of which can tell a `pushState` inside the bound conversation from
 * a subframe loading an advertisement. Chrome reports both precisely, and this decides which
 * of its reports are the bridge's business.
 *
 * The normalizer is a total function of the event and the origins the extension is allowed to
 * see. The tracker below adds the only state the decision needs — what each tab was last known
 * to be showing — so a redirect chain and a restored history entry collapse to the one
 * transition they represent. Neither touches Chrome: `background/index.ts` subscribes and
 * carries out whatever the tracker accepts.
 */
import type { BrowserProvider } from "../protocol/types.js";
import { providerForUrl } from "./conversation.js";

export type NavigationEventKind =
  | "onCommitted"
  | "onHistoryStateUpdated"
  | "onReferenceFragmentUpdated"
  | "onTabReplaced";

export type ChromeNavigationEvent = {
  kind: NavigationEventKind;
  tabId?: number | undefined;
  replacedTabId?: number | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
  url?: string | undefined;
};

export type NormalizedNavigation = {
  kind: NavigationEventKind;
  tabId: number;
  frameId: 0;
  documentId?: string | undefined;
  url: string;
  provider: BrowserProvider;
  /** A new document replaces the old one; a same-document change keeps it. */
  newDocument: boolean;
};

export type NavigationRefusal =
  | "unsupportedKind"
  | "noTab"
  | "subframe"
  | "prerender"
  | "invalidUrl"
  | "unsupportedOrigin"
  | "staleDocument"
  | "duplicate";

export type NavigationVerdict =
  | { navigation: NormalizedNavigation; refusal?: undefined }
  | { navigation?: undefined; refusal: NavigationRefusal };

/**
 * What the tracker answers: a verdict, and for an accepted one the number it holds for its tab.
 *
 * A handler that awaits anything checks that number still holds before acting. Chrome delivers
 * events faster than a permission read resolves, and applying an older one afterwards would move
 * the tab back to a route it has already left.
 */
export type TrackedNavigationVerdict =
  | { navigation: NormalizedNavigation; sequence: number; refusal?: undefined }
  | { navigation?: undefined; sequence?: undefined; refusal: NavigationRefusal };

const sameDocumentKinds = new Set<NavigationEventKind>([
  "onHistoryStateUpdated",
  "onReferenceFragmentUpdated",
]);

const navigationKinds = new Set<NavigationEventKind>([
  "onCommitted",
  "onHistoryStateUpdated",
  "onReferenceFragmentUpdated",
  "onTabReplaced",
]);

const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether Chrome's report is a top-level navigation of a tab the extension may look at.
 *
 * `frameId` must be `0`: a subframe navigating is not the conversation moving. A document
 * still in the prerender lifecycle has not been shown to anyone, so acting on it would bind a
 * conversation the user has not opened. A Generic origin is honoured only while it is still
 * permitted, because a revoked permission is the user withdrawing consent to read that site.
 *
 * `documentId` is compared against the document the bridge believes it is bound to, so a late
 * event from a replaced document is refused. Chrome's own event timestamps are never compared
 * with the extension's clock: the two are not the same clock, and a comparison between them
 * would reject valid events under load.
 */
export const normalizeNavigationEvent = (
  event: ChromeNavigationEvent,
  permittedGenericOrigins: ReadonlySet<string>,
  knownDocumentId?: string | undefined,
): NavigationVerdict => {
  if (!navigationKinds.has(event.kind)) {
    return { refusal: "unsupportedKind" };
  }
  const tabId = event.tabId;
  if (tabId === undefined || !Number.isInteger(tabId)) {
    return { refusal: "noTab" };
  }
  if (event.frameId !== 0) {
    return { refusal: "subframe" };
  }
  if (event.documentLifecycle !== undefined && event.documentLifecycle !== "active") {
    return { refusal: "prerender" };
  }
  if (typeof event.url !== "string") {
    return { refusal: "invalidUrl" };
  }
  const origin = originOf(event.url);
  if (origin === undefined) {
    return { refusal: "invalidUrl" };
  }
  const provider = providerForUrl(event.url)
    ?? (permittedGenericOrigins.has(origin) ? "generic" : undefined);
  if (provider === undefined) {
    return { refusal: "unsupportedOrigin" };
  }
  // A same-document change keeps the document, so an id that disagrees with the one the bridge
  // holds is a report about a document that has already been replaced.
  if (
    sameDocumentKinds.has(event.kind) &&
    knownDocumentId !== undefined &&
    event.documentId !== undefined &&
    event.documentId !== knownDocumentId
  ) {
    return { refusal: "staleDocument" };
  }
  return {
    navigation: {
      kind: event.kind,
      tabId,
      frameId: 0,
      ...(event.documentId === undefined ? {} : { documentId: event.documentId }),
      url: event.url,
      provider,
      newDocument: !sameDocumentKinds.has(event.kind),
    },
  };
};

/**
 * Whether an accepted navigation is a state transition the bridge has not already acted on.
 *
 * Chrome reports a redirect chain and a restored back/forward entry as several events that
 * land on the same document and URL, and the bridge only cares about effective transitions.
 * A new document is always a transition, even to the same URL: a reload replaces everything
 * the bridge knew about the page.
 */
export const isEffectiveTransition = (
  navigation: NormalizedNavigation,
  previous: { documentId?: string | undefined; url: string } | undefined,
): boolean => {
  if (!previous) {
    return true;
  }
  if (navigation.newDocument) {
    return navigation.documentId === undefined || navigation.documentId !== previous.documentId;
  }
  return navigation.url !== previous.url;
};

/**
 * One `webNavigation` report, in the words this module decides on.
 *
 * Chrome's three navigation events carry the same fields and differ only in what they mean, so
 * naming the kind is all the translation there is. It lives here rather than at the
 * subscription because it is a projection with no Chrome call in it, and because the three
 * listeners would otherwise each hold their own copy of it.
 */
export const navigationDetailsToEvent = (
  kind: NavigationEventKind,
  details: {
    tabId: number;
    frameId: number;
    url: string;
    documentId?: string | undefined;
    documentLifecycle?: string | undefined;
  },
): ChromeNavigationEvent => ({
  kind,
  tabId: details.tabId,
  frameId: details.frameId,
  ...(details.documentId === undefined ? {} : { documentId: details.documentId }),
  ...(details.documentLifecycle === undefined
    ? {}
    : { documentLifecycle: details.documentLifecycle }),
  url: details.url,
});

export type NavigationState = {
  documentId?: string | undefined;
  url: string;
  sequence: number;
};

export type NavigationTracker = {
  /**
   * Decide one Chrome report and, when it is an effective transition, record it as what the
   * tab is now showing. A refused report changes nothing.
   */
  accept: (
    event: ChromeNavigationEvent,
    permittedGenericOrigins: ReadonlySet<string>,
  ) => TrackedNavigationVerdict;
  /**
   * Chrome swapped one tab for another. Neither id describes a document the bridge has seen:
   * the replacement is a document that loaded out of band, and the replaced one is gone. Both
   * are forgotten so the next report about the surviving id is judged as a first navigation
   * rather than against a predecessor it has nothing to do with.
   */
  replaceTab: (addedTabId: number, removedTabId: number) => void;
  forgetTab: (tabId: number) => void;
  /**
   * Whether the accepted navigation numbered `sequence` is still the latest for its tab.
   *
   * A handler that awaited something asks this before acting. A tab that has since navigated
   * again, been replaced, or been closed answers no, so the older event does nothing rather
   * than overwriting what replaced it.
   */
  isCurrent: (tabId: number, sequence: number) => boolean;
};

export const createNavigationTracker = (): NavigationTracker => {
  const states = new Map<number, NavigationState>();
  // Monotonic across every tab, so a number is never reused after a tab is forgotten and a
  // late handler cannot match a sequence that belonged to something else.
  let accepted = 0;
  return {
    accept: (event, permittedGenericOrigins) => {
      const tabId = event.tabId;
      const previous =
        tabId === undefined || !Number.isInteger(tabId) ? undefined : states.get(tabId);
      const verdict = normalizeNavigationEvent(
        event,
        permittedGenericOrigins,
        previous?.documentId,
      );
      if (verdict.refusal !== undefined) {
        return verdict;
      }
      if (!isEffectiveTransition(verdict.navigation, previous)) {
        return { refusal: "duplicate" };
      }
      accepted += 1;
      states.set(verdict.navigation.tabId, {
        ...(verdict.navigation.documentId === undefined
          ? {}
          : { documentId: verdict.navigation.documentId }),
        url: verdict.navigation.url,
        sequence: accepted,
      });
      return { navigation: verdict.navigation, sequence: accepted };
    },
    forgetTab: (tabId) => {
      states.delete(tabId);
    },
    isCurrent: (tabId, sequence) => states.get(tabId)?.sequence === sequence,
    replaceTab: (addedTabId, removedTabId) => {
      states.delete(addedTabId);
      states.delete(removedTabId);
    },
  };
};
