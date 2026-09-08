import { classifyDomElement, collectDomCandidates } from "./candidates.js";
import { currentRoutePattern, loadBindingProfile, loadBindingProfiles, loadUnvalidatedBindingProfile, markProfileValidation, saveBindingProfile } from "./bindingProfile.js";
import {
  profileHasConfirmedInterruption,
  profileHasObservedStopControl,
  profileHasVerifiedLifecycle,
  replaceGenericBindingProfileState,
  withCompletedLifecycleEvidence,
  withConfirmedInterruptionEvidence,
  withObservedStopControlEvidence,
  withoutGenericLifecycleEvidence,
} from "./lifecycleEvidence.js";
import { createLocatorRecipe, isWritableElement, resolveLocatorRecipe } from "./locator.js";
import { healResponseWithLocalModel, healWithLocalModel } from "./localModel.js";
import { pickBindingElement } from "./picker.js";
import { showGenericSetup } from "./setup.js";
import { captureGenericResponse, conversationHoldsNonce, createGenericResponseLifecycleState, type GenericCaptureAttestation, type GenericResponseLifecycleState } from "./responseCapture.js";
import { clearConversationQuarantine, conversationIsQuarantined, conversationQuarantineState, quarantineConversation } from "./conversationQuarantine.js";
import { genericEmptyConversationStable, genericFreshnessObserved, genericFreshnessStabilityMs, genericInitialEmptyStabilityMs } from "./freshConversation.js";
import { selectionToCapturedResponse } from "./markdown.js";
import { extractReadablePage } from "./readability.js";
import { delay, now, waitForStableCondition, waitForTransientControl } from "./transientControl.js";
import type { GenericBindingProfile, GenericBindingRole, GenericCapturedSegment, GenericRequest, GenericResponse, GenericSendResult } from "./types.js";

declare global {
  interface Window {
    __BACHATA_GENERIC_CONTENT_INSTALLED__?: boolean;
  }
}

if (!window.__BACHATA_GENERIC_CONTENT_INSTALLED__) {
  window.__BACHATA_GENERIC_CONTENT_INSTALLED__ = true;

  const documentToken = `generic-document:${crypto.randomUUID()}`;
  let documentRevision = 1;
  const acceptingRequestIds = new Set<string>();
  const cancelledRequestIds = new Set<string>();
  const rememberCancellation = (requestId: string): void => {
    cancelledRequestIds.add(requestId);
    setTimeout(() => {
      if (!acceptingRequestIds.has(requestId) && activeRequest?.requestId !== requestId) {
        cancelledRequestIds.delete(requestId);
      }
    }, 30_000);
  };
  let activeRequest: {
    requestId: string;
    controller: AbortController;
    resolveManual: (
      response: { markdown: string; text: string; segments: GenericCapturedSegment[] },
      attestation: GenericCaptureAttestation,
    ) => void;
    submitted: boolean;
    lifecycle: GenericResponseLifecycleState;
    conversationIdentity: string;
    conversationIdentities: string[];
    providerIdleConfirmed: boolean;
    // The document this request was accepted against. An interrupt arrives with a request id
    // and nothing else, so this is the only thing it can be checked against before a bound
    // control on the page is activated.
    documentRevisionAtStart: number;
    // BB-A4-N02. The token written into the submitted prompt. A same-document route change
    // leaves the document revision and every resolved control untouched, so this is what says
    // the conversation on the page is still the one this request was submitted into.
    nonce: string;
  } | undefined;
  const isRequestAborted = (requestId: string): boolean => {
    const pending = activeRequest;
    return pending?.requestId === requestId && pending.controller.signal.aborted;
  };
  let pendingReuseConfirmation: {
    requestId: string;
    documentToken: string;
    documentRevision: number;
    conversationUrl: string;
    conversationIdentity: string;
    conversationIdentities: string[];
    expiresAt: number;
  } | undefined;
  const maximumHealingAttempts = 3;
  const healingRetryDelayMs = 1_500;
  let healingAttemptDocumentKey = "";
  let healingAttemptCount = 0;
  let healingNextAllowedAt = 0;
  let healingInFlight = false;
  let optionalSendHealingDocumentKey = "";

  const registerCurrentDocument = async (): Promise<Omit<GenericSendResult, "markdown" | "text" | "segments" | "providerIdleConfirmed" | "completionSource">> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = {
        documentToken,
        documentRevision,
        conversationUrl: canonicalConversationUrl(),
        conversationIdentity: currentConversationIdentity(),
      };
      const response = await chrome.runtime.sendMessage({
        type: "BACHATA_GENERIC_REGISTER",
        origin: location.origin,
        url: snapshot.conversationUrl,
        title: document.title,
        documentRevision: snapshot.documentRevision,
        documentToken: snapshot.documentToken,
      });
      if (!response || typeof response !== "object" || (response as Record<string, unknown>).ok !== true) {
        throw new Error("The generic browser document registration could not be confirmed");
      }
      if (snapshot.documentRevision === documentRevision
        && snapshot.conversationUrl === canonicalConversationUrl()
        && snapshot.conversationIdentity === currentConversationIdentity()) {
        return snapshot;
      }
    }
    throw new Error("The generic browser document kept changing while final response identity was registered");
  };

  const registerDocument = (): void => {
    void registerCurrentDocument().catch(() => undefined);
  };

  const advanceDocumentRevision = (): void => {
    pendingReuseConfirmation = undefined;
    documentRevision += 1;
    registerDocument();
  };

  const observeDocumentReplacement = (): void => {
    let lastBody = document.body;
    new MutationObserver(() => {
      if (document.body !== lastBody) {
        lastBody = document.body;
        if (activeRequest) {
          if (activeRequest.submitted) quarantineConversations(activeRequest.conversationIdentity);
          else activeRequest.controller.abort();
        }
        advanceDocumentRevision();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };

  // N1. Content scripts run in an isolated world with their own DOM wrappers, so assigning
  // history.pushState here only shadows this world's copy: the page's own calls resolve on the
  // main world's prototype and never reach it. Those patches were dead code and are gone.
  //
  // What replaced the 250 ms href poll is Chrome itself. The background subscribes
  // `webNavigation.onCommitted`, `onHistoryStateUpdated` and `onReferenceFragmentUpdated`,
  // which report a `pushState` and a `replaceState` the poll could only notice up to a quarter
  // second late, and report them without confusing a subframe or a prerender for the bound
  // conversation. A permanent interval is also what kept this entry unfinishable in a test:
  // nothing could observe a route change without waiting out a real timer.
  //
  // popstate and hashchange stay. They are real events that do cross worlds, they cost nothing
  // when nothing navigates, and they are the immediate local signal that lets an in-flight
  // request stop before the background's event arrives. They are last-moment safety, not a
  // second navigation detector: neither one is what the bridge treats as authority.
  const observeNavigation = (): void => {
    let lastUrl = location.href;
    const changed = (): void => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (activeRequest) {
        if (activeRequest.submitted) quarantineConversations(activeRequest.conversationIdentity);
        else activeRequest.controller.abort();
      }
      advanceDocumentRevision();
    };
    // queueMicrotask lets the event's own handlers settle before the URL is read.
    const changedSoon = (): void => { queueMicrotask(changed); };
    window.addEventListener("popstate", changedSoon);
    window.addEventListener("hashchange", changedSoon);
  };

  // BB-A4-N03. An answer that cannot be attributed is not a binding fault, so the healing retry
  // must not treat it as one: capturing again would take a second answer out of the conversation
  // the page moved to and offer it under the request that was made in the first.
  const unattributableAnswer =
    "The generic browser page changed conversation while this answer was being finalized, so the answer cannot be attributed";

  const canonicalConversationUrl = (): string => {
    const url = new URL(location.href);
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  };

  const currentConversationIdentity = (): string => `generic:${canonicalConversationUrl()}`;
  const quarantineProvider = "generic";
  const uniqueConversationIdentities = (...identities: Array<string | undefined>): string[] =>
    [...new Set(identities.filter((identity): identity is string => Boolean(identity)))];
  // Uncertain covers both a held verdict and an authority that cannot answer: neither one is
  // proof that this conversation is safe to send to again.
  const conversationIsUncertain = async (...identities: Array<string | undefined>): Promise<boolean> => {
    for (const identity of uniqueConversationIdentities(...identities)) {
      if (await conversationIsQuarantined(quarantineProvider, identity)) return true;
    }
    return false;
  };
  const conversationUncertaintyReason = async (
    ...identities: Array<string | undefined>
  ): Promise<"quarantined" | "unavailable" | undefined> => {
    let unavailable = false;
    for (const identity of uniqueConversationIdentities(...identities)) {
      const state = await conversationQuarantineState(quarantineProvider, identity);
      if (state === "quarantined") return "quarantined";
      if (state === "unavailable") unavailable = true;
    }
    return unavailable ? "unavailable" : undefined;
  };
  const quarantineConversations = (...identities: Array<string | undefined>): void => {
    const involved = uniqueConversationIdentities(...identities, currentConversationIdentity());
    if (activeRequest?.submitted) {
      activeRequest.conversationIdentities = uniqueConversationIdentities(
        ...activeRequest.conversationIdentities,
        ...involved,
      );
    }
    for (const identity of involved) {
      quarantineConversation(quarantineProvider, identity);
    }
  };
  const clearConversationUncertainty = (...identities: Array<string | undefined>): void => {
    for (const identity of uniqueConversationIdentities(...identities, currentConversationIdentity())) {
      clearConversationQuarantine(quarantineProvider, identity);
    }
  };
  const profileAlignedToCurrentRoute = (profile: GenericBindingProfile): GenericBindingProfile => {
    const routePattern = currentRoutePattern();
    if (profile.routePattern === routePattern) return profile;
    const aligned: GenericBindingProfile = {
      ...withoutGenericLifecycleEvidence(profile),
      routePattern,
      documentRevision,
    };
    return replaceGenericBindingProfileState(profile, aligned);
  };
  const persistProfileEvidence = async (
    profile: GenericBindingProfile,
    next: GenericBindingProfile,
  ): Promise<void> => {
    replaceGenericBindingProfileState(profile, next);
    await saveBindingProfile(profile).catch(() => undefined);
  };
  const recordObservedStopControl = async (profile: GenericBindingProfile): Promise<void> => {
    const aligned = profileAlignedToCurrentRoute(profile);
    await persistProfileEvidence(aligned, withObservedStopControlEvidence(aligned));
  };
  const recordCompletedLifecycle = async (profile: GenericBindingProfile): Promise<void> => {
    const aligned = profileAlignedToCurrentRoute(profile);
    await persistProfileEvidence(aligned, withCompletedLifecycleEvidence(aligned));
  };
  const recordConfirmedInterruption = async (profile: GenericBindingProfile): Promise<void> => {
    const aligned = profileAlignedToCurrentRoute(profile);
    await persistProfileEvidence(aligned, withConfirmedInterruptionEvidence(aligned));
  };

  const sameConversationOrigin = (request: Extract<GenericRequest, { type: "BACHATA_GENERIC_SEND" }>): boolean => {
    try {
      return new URL(request.conversationUrl).origin === location.origin;
    } catch {
      return false;
    }
  };

  const requestMatchesCurrentDocument = (request: Extract<GenericRequest, { type: "BACHATA_GENERIC_SEND" }>): boolean => {
    if (request.documentToken !== documentToken) return false;
    if (activeRequest?.requestId === request.requestId && activeRequest.submitted) {
      return sameConversationOrigin(request);
    }
    return request.documentRevision === documentRevision
      && request.conversationUrl === canonicalConversationUrl()
      && request.conversationIdentity === currentConversationIdentity();
  };

  const assertRequestMatchesCurrentDocument = (request: Extract<GenericRequest, { type: "BACHATA_GENERIC_SEND" }>): void => {
    if (!requestMatchesCurrentDocument(request)) {
      throw new Error("The generic browser document or conversation is no longer compatible with the active request");
    }
  };

  /**
   * BR-G6-14. Everything between the deadline check that admits a request and the click that
   * submits it is an await: the composer has to accept the whole prompt, and the Send control has
   * to become active, which can run bounded healing. A deadline that expired inside one of those
   * waits has to stop the submission rather than be discovered after it, so the deadline is
   * re-read wherever the document identity is.
   */
  const assertRequestStillSendable = (
    request: Extract<GenericRequest, { type: "BACHATA_GENERIC_SEND" }>,
  ): void => {
    if (now() >= request.deadlineAt) {
      rememberCancellation(request.requestId);
      throw new Error("The generic browser request deadline expired before submission");
    }
    assertRequestMatchesCurrentDocument(request);
  };

  const withCurrentConversationIdentity = async (response: { markdown: string; text: string; segments: GenericCapturedSegment[] }): Promise<Omit<GenericSendResult, "providerIdleConfirmed" | "completionSource">> => ({
    ...response,
    ...await registerCurrentDocument(),
  });

  const healingDocumentKey = (): string =>
    `${documentToken}:${canonicalConversationUrl()}:${String(documentRevision)}`;

  const reserveHealingAttempt = (): boolean => {
    const key = healingDocumentKey();
    if (healingAttemptDocumentKey !== key) {
      healingAttemptDocumentKey = key;
      healingAttemptCount = 0;
      healingNextAllowedAt = 0;
    }
    const attemptedAt = now();
    if (healingAttemptCount >= maximumHealingAttempts || attemptedAt < healingNextAllowedAt) return false;
    healingAttemptCount += 1;
    healingNextAllowedAt = attemptedAt + healingRetryDelayMs;
    return true;
  };

  const clearHealingAttempts = (): void => {
    healingAttemptDocumentKey = healingDocumentKey();
    healingAttemptCount = 0;
    healingNextAllowedAt = 0;
  };

  const isActiveControl = (element: Element | undefined): element is HTMLElement =>
    element instanceof HTMLElement
    && !(element instanceof HTMLButtonElement && element.disabled)
    && element.getAttribute("aria-disabled") !== "true";

  const healedElementMatchesRole = (
    element: Element | undefined,
    role: "composer" | "conversationRoot" | "sendButton" | "stopButton" | "newConversationButton" | "responseMessage",
  ): boolean => {
    if (!element) return false;
    const hint = classifyDomElement(element);
    const buttonLike = element instanceof HTMLButtonElement || element.getAttribute("role") === "button";
    if (role === "composer") return hint === "composer" || isWritableElement(element);
    if (role === "conversationRoot") {
      return hint === "conversationRoot"
        || element.matches("main,[role=main],[role=feed],[role=log],[role=region]");
    }
    if (role === "sendButton" || role === "stopButton" || role === "newConversationButton") {
      const interpretableUnknown = hint === "unknown"
        && Boolean(element.getAttribute("aria-label")?.trim() || element.textContent?.trim());
      return buttonLike && (hint === role || interpretableUnknown);
    }
    return hint === "message"
      || hint === "responseMessage"
      || element.matches("article,[role=article]")
      || (hint === "unknown" && element instanceof HTMLElement && !buttonLike && !isWritableElement(element));
  };

  const bindingSourceForRole = (profile: GenericBindingProfile, role: GenericBindingRole) =>
    profile.bindingSources?.[role] ?? profile.createdBy;

  const autoHealedElementMatchesRole = (
    profile: GenericBindingProfile,
    element: Element | undefined,
    role: GenericBindingRole,
  ): boolean => {
    if (!element) return false;
    if (bindingSourceForRole(profile, role) === "autoHeal") return healedElementMatchesRole(element, role);
    if (role === "composer") return isWritableElement(element);
    if (role === "sendButton" || role === "stopButton" || role === "newConversationButton") {
      if (!(element instanceof HTMLButtonElement || element.getAttribute("role") === "button")) {
        return false;
      }
      // BR-G6-12. A control a person bound is not re-judged on shape: they picked it
      // deliberately, and it may look like anything the page wants. What it may not do is become
      // a *different* known control. A Stop recipe that now resolves onto Send would otherwise
      // read as generation in progress on an idle page, and interrupting the turn would click
      // Send and submit whatever the composer holds. An unknown or ambiguous shape is still
      // accepted, exactly as before.
      const hint = classifyDomElement(element);
      return hint === role
        || (hint !== "sendButton" && hint !== "stopButton" && hint !== "newConversationButton");
    }
    return element instanceof HTMLElement;
  };


  const setComposerValue = (element: HTMLElement, value: string): void => {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, value);
    if (!inserted) element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  };

  const normalizeComposerValue = (value: string): string => value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");

  const readComposerValue = (element: HTMLElement): string => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
    return element.innerText || element.textContent || "";
  };

  const waitForComposerValue = async (element: HTMLElement, expected: string, timeoutMs = 1_500): Promise<boolean> => {
    const deadline = now() + timeoutMs;
    const normalizedExpected = normalizeComposerValue(expected);
    while (now() <= deadline) {
      if (!element.isConnected) return false;
      if (normalizeComposerValue(readComposerValue(element)) === normalizedExpected) return true;
      await delay(25);
    }
    return false;
  };

  const waitForActiveSendControl = async (profile: GenericBindingProfile, timeoutMs = 3_000): Promise<HTMLElement | undefined> => {
    if (!profile.sendButton) return undefined;
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const current = resolveLocatorRecipe(profile.sendButton);
      if (isActiveControl(current) && autoHealedElementMatchesRole(profile, current, "sendButton")) return current;
      await delay(50);
    }
    return undefined;
  };

  const resolveProfile = async (allowUnvalidated = false): Promise<GenericBindingProfile> => {
    const direct = allowUnvalidated
      ? await loadUnvalidatedBindingProfile()
      : await loadBindingProfile();
    const profile = direct ?? await adoptCompatibleProfileForCurrentRoute(allowUnvalidated);
    if (!profile) {
      throw new Error(allowUnvalidated
        ? "No generic browser binding is available"
        : "No validated generic browser binding is available");
    }
    return profile;
  };

  const profileIsStructurallyReady = (profile: GenericBindingProfile): boolean => {
    const composer = resolveLocatorRecipe(profile.composer);
    const root = resolveLocatorRecipe(profile.conversationRoot);
    const send = profile.sendButton ? resolveLocatorRecipe(profile.sendButton) : undefined;
    const stop = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
    return Boolean(
      autoHealedElementMatchesRole(profile, composer, "composer")
      && autoHealedElementMatchesRole(profile, root, "conversationRoot")
      && (!profile.sendButton || autoHealedElementMatchesRole(profile, send, "sendButton"))
      && (!stop || autoHealedElementMatchesRole(profile, stop, "stopButton")),
    );
  };

  const adoptCompatibleProfileForCurrentRoute = async (allowUnvalidated: boolean): Promise<GenericBindingProfile | undefined> => {
    const profiles = (await loadBindingProfiles())
      .filter((profile) => allowUnvalidated || profile.validated)
      .sort((left, right) => (right.lastSuccessfulAt ?? "").localeCompare(left.lastSuccessfulAt ?? ""));
    for (const profile of profiles) {
      if (!profileIsStructurallyReady(profile)) continue;
      const adopted: GenericBindingProfile = {
        ...withoutGenericLifecycleEvidence(profile),
        routePattern: currentRoutePattern(),
        validated: profile.validated,
        consecutiveFailures: 0,
        documentRevision,
      };
      await saveBindingProfile(adopted, profile);
      return adopted;
    }
    return undefined;
  };

  const providerGenerationActive = (profile: GenericBindingProfile): boolean => {
    const stop = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
    return Boolean(isActiveControl(stop) && autoHealedElementMatchesRole(profile, stop, "stopButton"));
  };

  const conversationMessageCount = (profile: GenericBindingProfile): number => {
    const root = resolveLocatorRecipe(profile.conversationRoot);
    if (!(root instanceof Element)) return 0;
    return root.querySelectorAll("article,[role=article],[data-message-author-role],[data-testid*=message i],[data-role*=message i]").length;
  };

  const normalizedConversationText = (profile: GenericBindingProfile): string => {
    const root = resolveLocatorRecipe(profile.conversationRoot);
    return (root?.textContent ?? "").replace(/\s+/g, " ").trim();
  };

  const stableEmptyConversation = async (
    timeoutMs = genericInitialEmptyStabilityMs + 2_500,
  ): Promise<boolean> => {
    const deadline = now() + timeoutMs;
    let stableSince: number | undefined;
    while (now() < deadline) {
      const profile = await resolveProfile().catch(() => undefined);
      const generationActive = Boolean(profile && providerGenerationActive(profile));
      const messageCount = profile ? conversationMessageCount(profile) : 0;
      const textLength = profile ? normalizedConversationText(profile).length : 0;
      const structurallyReady = Boolean(profile && profileIsStructurallyReady(profile));
      const empty = document.readyState === "complete"
        && structurallyReady
        && !generationActive
        && messageCount === 0
        && textLength === 0;
      if (!empty) {
        stableSince = undefined;
        if (structurallyReady && (messageCount > 0 || textLength > 0)) return false;
      } else {
        stableSince ??= now();
        if (genericEmptyConversationStable({
          documentReady: true,
          generationActive: false,
          messageCount,
          textLength,
          stableForMs: now() - stableSince,
        })) return true;
      }
      await delay(100);
    }
    return false;
  };

  const startFreshConversation = async (): Promise<{
    freshnessConfirmed: true;
    conversationUrl: string;
    conversationIdentity: string;
    documentRevision: number;
    documentToken: string;
  }> => {
    if (activeRequest || acceptingRequestIds.size > 0) {
      throw new Error("Cannot start a new generic conversation while a request is active");
    }
    let profile = await resolveProfile();
    if (providerGenerationActive(profile)) {
      throw new Error("Cannot start a new generic conversation while the provider is generating");
    }
    const beforeUrl = canonicalConversationUrl();
    const beforeRevision = documentRevision;
    const beforeCount = conversationMessageCount(profile);
    const beforeText = normalizedConversationText(profile);
    if (beforeCount === 0
      && beforeText.length === 0
      && !(await conversationIsUncertain(currentConversationIdentity()))
      && await stableEmptyConversation()) {
      const registration = await registerCurrentDocument();
      pendingReuseConfirmation = undefined;
      clearConversationUncertainty(registration.conversationIdentity);
      return { freshnessConfirmed: true, ...registration };
    }
    let control = profile.newConversationButton ? resolveLocatorRecipe(profile.newConversationButton) : undefined;
    if (!isActiveControl(control) || !autoHealedElementMatchesRole(profile, control, "newConversationButton")) {
      if (await autoHeal().catch(() => false)) {
        profile = await resolveProfile();
        control = profile.newConversationButton ? resolveLocatorRecipe(profile.newConversationButton) : undefined;
      }
    }
    if (!isActiveControl(control) || !autoHealedElementMatchesRole(profile, control, "newConversationButton")) {
      throw new Error("No valid new-conversation control is available; bind it or configure selector healing");
    }
    control.click();

    const deadline = now() + 15_000;
    let resetStableSince: number | undefined;
    let resetStableSignature: string | undefined;
    while (now() < deadline) {
      await delay(100);
      const currentUrl = canonicalConversationUrl();
      const currentProfile = await resolveProfile().catch(() => undefined);
      if (!currentProfile || !profileIsStructurallyReady(currentProfile) || providerGenerationActive(currentProfile)) {
        resetStableSince = undefined;
        resetStableSignature = undefined;
        continue;
      }
      const currentCount = conversationMessageCount(currentProfile);
      const currentText = normalizedConversationText(currentProfile);
      const freshnessObserved = genericFreshnessObserved({
        beforeUrl,
        currentUrl,
        beforeRevision,
        currentRevision: documentRevision,
        beforeMessageCount: beforeCount,
        currentMessageCount: currentCount,
        beforeTextLength: beforeText.length,
        currentTextLength: currentText.length,
        explicitResetRequested: true,
      });
      if (freshnessObserved) {
        const stableSignature = `${currentUrl}\u0000${String(documentRevision)}\u0000${String(currentCount)}\u0000${currentText}`;
        if (stableSignature !== resetStableSignature) {
          resetStableSignature = stableSignature;
          resetStableSince = now();
        }
        if (resetStableSince !== undefined && now() - resetStableSince >= genericFreshnessStabilityMs) {
          const registration = await registerCurrentDocument();
          pendingReuseConfirmation = undefined;
          clearConversationUncertainty(registration.conversationIdentity);
          return { freshnessConfirmed: true, ...registration };
        }
      } else {
        resetStableSince = undefined;
        resetStableSignature = undefined;
      }
    }
    throw new Error("The provider did not produce observable evidence of a fresh generic conversation");
  };

  /**
   * BB-A4-N02. Why this interruption no longer owns the page, or nothing.
   *
   * A `pushState` route change is invisible to every signal the content script has: the document
   * is not replaced, so the revision does not move; popstate and hashchange never fire; the
   * composer, the conversation root and the Stop control all resolve to the same nodes. What
   * does change is the address bar and the transcript under those nodes. So ownership is asked
   * for again — the turn, the document, the conversation this request named, and the request's
   * own nonce still being in the conversation the page is showing — after every await, and on
   * every poll of the idle confirmation, not once before the first one.
   */
  const cancellationOwnershipLost = (
    current: NonNullable<typeof activeRequest>,
    profile?: GenericBindingProfile,
  ): string | undefined => {
    if (activeRequest !== current) {
      return "The generic browser turn being interrupted ended before the interruption was confirmed";
    }
    if (documentRevision !== current.documentRevisionAtStart) {
      return "The generic browser document changed after submission, so the interruption cannot be confirmed";
    }
    if (!current.conversationIdentities.includes(currentConversationIdentity())) {
      return "The generic browser page moved to another conversation, so the interruption cannot be confirmed";
    }
    if (profile === undefined) {
      return undefined;
    }
    const root = resolveLocatorRecipe(profile.conversationRoot);
    if (!root || !autoHealedElementMatchesRole(profile, root, "conversationRoot")) {
      return "The generic browser conversation is no longer resolvable, so the interruption cannot be confirmed";
    }
    if (!conversationHoldsNonce(root, current.nonce)) {
      return "The submitted request nonce is no longer present in the active generic conversation, so the interruption cannot be confirmed";
    }
    return undefined;
  };

  const waitForProviderIdle = async (
    profile: GenericBindingProfile,
    requestId: string,
    timeoutMs = 5_000,
  ): Promise<boolean> => await waitForStableCondition({
    timeoutMs,
    stableMs: 1_000,
    pollIntervalMs: 100,
    signal: activeRequest?.controller.signal,
    observe: () => {
      const current = activeRequest;
      if (current?.requestId !== requestId) return false;
      // BB-A4-N02. Ten seconds of idle polling is ten seconds in which the page can become
      // another conversation, and a quiet page that is not this turn's page confirms nothing.
      if (current.submitted && cancellationOwnershipLost(current, profile) !== undefined) {
        return false;
      }
      return !providerGenerationActive(profile);
    },
  });


  const learnTransientStopBinding = async (
    profile: GenericBindingProfile,
    timeoutMs = 3_000,
    lifecycle?: GenericResponseLifecycleState,
  ): Promise<void> => {
    const bindObservedStop = async (element: Element): Promise<void> => {
      profile.stopButton = createLocatorRecipe(element);
      profile.bindingSources = { ...profile.bindingSources, stopButton: "autoHeal" };
      if (lifecycle) lifecycle.sawGeneration = true;
      await recordObservedStopControl(profile);
    };
    const existing = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
    if (isActiveControl(existing) && autoHealedElementMatchesRole(profile, existing, "stopButton")) {
      if (lifecycle) lifecycle.sawGeneration = true;
      if (!profileHasObservedStopControl(profile)) await recordObservedStopControl(profile);
      return;
    }
    let lastCandidateSignature = "";
    const found = await waitForTransientControl<Element>({
      timeoutMs,
      pollIntervalMs: 100,
      signal: activeRequest?.controller.signal,
      resolveCurrent: () => {
        const current = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
        return isActiveControl(current) && autoHealedElementMatchesRole(profile, current, "stopButton")
          ? current
          : undefined;
      },
      collectHeuristicCandidates: () => [...collectDomCandidates().values()]
        .filter((entry) => classifyDomElement(entry.element) === "stopButton" && isActiveControl(entry.element))
        .map((entry) => entry.element),
      startHealing: () => {
        const candidates = collectDomCandidates();
        if (candidates.size < 2) return undefined;
        const signature = JSON.stringify([...candidates.values()].map(({ candidate }) => [
          candidate.kindHint,
          candidate.tag,
          candidate.role,
          candidate.accessibleName,
          candidate.textPreview,
        ]));
        if (signature === lastCandidateSignature) return undefined;
        lastCandidateSignature = signature;
        return healWithLocalModel(
          [...candidates.values()].map((entry) => entry.candidate),
          lifecycle?.deadlineAt,
        )
          .then((decision) => {
            const stopId = decision.status === "selected" ? decision.stopButtonIds[0] : undefined;
            const stopEntry = stopId ? candidates.get(stopId) : undefined;
            return stopEntry
              && stopEntry.element.isConnected
              && isActiveControl(stopEntry.element)
              && healedElementMatchesRole(stopEntry.element, "stopButton")
              ? stopEntry.element
              : undefined;
          });
      },
      maximumHealingAttempts: 2,
      isValid: (candidate): candidate is Element => Boolean(
        candidate
        && candidate.isConnected
        && isActiveControl(candidate)
        && healedElementMatchesRole(candidate, "stopButton"),
      ),
    });
    if (!found) return;
    const current = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
    if (current === found && autoHealedElementMatchesRole(profile, current, "stopButton")) {
      if (lifecycle) lifecycle.sawGeneration = true;
      if (!profileHasObservedStopControl(profile)) await recordObservedStopControl(profile);
      return;
    }
    await bindObservedStop(found);
  };

  const healResponseBinding = async (
    profile: GenericBindingProfile,
    deadlineAt?: number,
  ): Promise<boolean> => {
    if (!reserveHealingAttempt()) return false;
    const candidates = collectDomCandidates();
    if (candidates.size === 0) return false;
    const decision = await healResponseWithLocalModel(
      [...candidates.values()].map((entry) => entry.candidate),
      deadlineAt,
    );
    const responseId = decision.responseMessageIds[0];
    if (decision.status !== "selected" || !responseId) return false;
    const responseEntry = candidates.get(responseId);
    if (!responseEntry || classifyDomElement(responseEntry.element) !== "message") return false;
    profile.responseMessage = createLocatorRecipe(responseEntry.element);
    profile.bindingSources = { ...profile.bindingSources, responseMessage: "autoHeal" };
    await saveBindingProfile(profile);
    return true;
  };

  const submitPrompt = async (
    profile: GenericBindingProfile,
    request: Extract<GenericRequest, { type: "BACHATA_GENERIC_SEND" }>,
  ): Promise<GenericSendResult> => {
    const { requestId, prompt } = request;
    if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= now()) {
      throw new Error("The generic browser request deadline has already expired");
    }
    assertRequestMatchesCurrentDocument(request);
    if (cancelledRequestIds.has(requestId)) {
      throw new Error("The generic browser request was interrupted before submission");
    }
    if (activeRequest || providerGenerationActive(profile)) {
      throw new Error("The generic browser conversation is already generating a response");
    }
    const composer = resolveLocatorRecipe(profile.composer);
    const root = resolveLocatorRecipe(profile.conversationRoot);
    const send = profile.sendButton ? resolveLocatorRecipe(profile.sendButton) : undefined;
    const stop = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
    if (!composer
      || !root
      || !isWritableElement(composer)
      || !autoHealedElementMatchesRole(profile, composer, "composer")
      || !autoHealedElementMatchesRole(profile, root, "conversationRoot")
      || (profile.sendButton && !autoHealedElementMatchesRole(profile, send, "sendButton"))
      || (stop && !autoHealedElementMatchesRole(profile, stop, "stopButton"))) {
      throw new Error("The saved browser binding is no longer valid");
    }
    const controller = new AbortController();
    const lifecycle = createGenericResponseLifecycleState(request.deadlineAt);
    type CapturedCompletion = {
      captured: { markdown: string; text: string; segments: GenericCapturedSegment[] };
      completionSource: GenericSendResult["completionSource"];
      // BB-A4-N03. The page this answer was taken from, recorded by whoever accepted it, in the
      // same synchronous run that accepted it.
      attestation: GenericCaptureAttestation;
    };
    let resolveManual!: (
      response: { markdown: string; text: string; segments: GenericCapturedSegment[] },
      attestation: GenericCaptureAttestation,
    ) => void;
    const manualResponse = new Promise<CapturedCompletion>((resolve) => {
      resolveManual = (captured, attestation) =>
        resolve({ captured, completionSource: "manualSelection", attestation });
    });
    activeRequest = {
      requestId,
      controller,
      resolveManual,
      submitted: false,
      lifecycle,
      conversationIdentity: request.conversationIdentity,
      conversationIdentities: [request.conversationIdentity],
      providerIdleConfirmed: false,
      documentRevisionAtStart: documentRevision,
      nonce: `BACHATA-${requestId}`,
    };
    const token = `BACHATA-${requestId}`;
    const payload = `${prompt}\n\n[${token}]`;
    let submitted = false;
    try {
      if (controller.signal.aborted || cancelledRequestIds.has(requestId)) {
        throw new Error("The generic browser request was interrupted before submission");
      }
      assertRequestStillSendable(request);
      if (normalizeComposerValue(readComposerValue(composer)).trim()) {
        throw new Error("The generic browser composer contains existing text");
      }
      setComposerValue(composer, payload);
      if (!(await waitForComposerValue(composer, payload))) {
        throw new Error("The browser composer did not accept the complete request");
      }
      if (controller.signal.aborted || cancelledRequestIds.has(requestId)) {
        throw new Error("The generic browser request was interrupted before submission");
      }
      assertRequestStillSendable(request);
      if (profile.sendButton) {
        const activeSend = await waitForActiveSendControl(profile);
        if (!activeSend) throw new Error("The bound send control did not become available after the request was written");
        if (controller.signal.aborted || cancelledRequestIds.has(requestId)) {
          throw new Error("The generic browser request was interrupted before submission");
        }
        assertRequestStillSendable(request);
        submitted = true;
        if (activeRequest?.requestId === requestId) activeRequest.submitted = true;
        quarantineConversations(request.conversationIdentity);
        activeSend.click();
      } else {
        if (controller.signal.aborted || cancelledRequestIds.has(requestId)) {
          throw new Error("The generic browser request was interrupted before submission");
        }
        assertRequestStillSendable(request);
        submitted = true;
        if (activeRequest?.requestId === requestId) activeRequest.submitted = true;
        quarantineConversations(request.conversationIdentity);
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      }
      await chrome.runtime.sendMessage({
        type: "BACHATA_GENERIC_SUBMITTED",
        requestId,
        documentToken: request.documentToken,
        documentRevision: request.documentRevision,
        conversationUrl: request.conversationUrl,
        conversationIdentity: request.conversationIdentity,
      }).catch(() => undefined);
      const initialRemainingMs = Math.max(1, request.deadlineAt - now());
      void learnTransientStopBinding(profile, Math.min(30_000, initialRemainingMs), lifecycle).catch(() => undefined);
      const generationActive = () => {
        if (!profile.stopButton) return false;
        const activeStop = resolveLocatorRecipe(profile.stopButton);
        return isActiveControl(activeStop) && autoHealedElementMatchesRole(profile, activeStop, "stopButton");
      };
      const stream = async (text: string): Promise<void> => {
        await chrome.runtime.sendMessage({
          type: "BACHATA_GENERIC_STREAM",
          requestId,
          documentToken,
          text,
        }).catch(() => undefined);
      };
      const capture = async (): Promise<CapturedCompletion> => {
        const captured = await captureGenericResponse(
          () => {
            const currentRoot = resolveLocatorRecipe(profile.conversationRoot);
            return currentRoot && autoHealedElementMatchesRole(profile, currentRoot, "conversationRoot") ? currentRoot : undefined;
          },
          `[${token}]`,
          controller.signal,
          Math.max(1, request.deadlineAt - now()),
          generationActive,
          profile.responseMessage,
          () => assertRequestMatchesCurrentDocument(request),
          stream,
          lifecycle,
          () => ({
            requestId,
            documentRevision,
            conversationUrl: canonicalConversationUrl(),
            conversationIdentity: currentConversationIdentity(),
          }),
        );
        return {
          captured: { markdown: captured.markdown, text: captured.text, segments: captured.segments },
          completionSource: "verifiedLifecycle",
          attestation: captured.attestation,
        };
      };
      let providerIdleConfirmed = false;
      const finalizeResponse = async (
        completion: CapturedCompletion,
      ): Promise<GenericSendResult> => {
        const { captured, completionSource, attestation: attested } = completion;
        // BB-A4-N03. The conversation this answer belongs to was recorded by whoever accepted
        // the answer, in the same synchronous run that accepted it. Reading it here instead
        // would name the conversation the page moved to between the acceptance and this line —
        // a window an await cannot see and a same-document route change crosses invisibly.
        // Everything after this is persistence, and the record is revalidated after each of its
        // awaits rather than re-read.
        const attestationBroken = (): boolean =>
          documentRevision !== attested.documentRevision
          || canonicalConversationUrl() !== attested.conversationUrl
          || currentConversationIdentity() !== attested.conversationIdentity
          || (attested.promptElement !== undefined && (
            !attested.promptElement.isConnected
            || !conversationHoldsNonce(attested.promptElement, attested.nonce)
          ))
          || (attested.responseElement !== undefined && !attested.responseElement.isConnected)
          || (attested.conversationRoot !== undefined && attested.responseElement !== undefined
            && !attested.conversationRoot.contains(attested.responseElement));
        const refuseUnattributableAnswer = (...identities: readonly string[]): never => {
          pendingReuseConfirmation = undefined;
          quarantineConversations(
            request.conversationIdentity,
            attested.conversationIdentity,
            ...identities,
          );
          throw new Error(unattributableAnswer);
        };
        if (attestationBroken()) refuseUnattributableAnswer();
        providerIdleConfirmed = Boolean(
          activeRequest?.requestId === requestId && activeRequest.providerIdleConfirmed,
        ) || Boolean(
          lifecycle.sawGeneration
          && lifecycle.generationEndedAt !== undefined
          && !providerGenerationActive(profile),
        );
        if (activeRequest?.requestId === requestId) {
          activeRequest.providerIdleConfirmed = providerIdleConfirmed;
        }
        if (completionSource === "verifiedLifecycle" && !providerIdleConfirmed) {
          throw new Error("The generic browser response lifecycle ended without confirmed provider idle state");
        }
        if (providerIdleConfirmed) {
          await recordCompletedLifecycle(profile);
          if (attestationBroken()) refuseUnattributableAnswer();
        }
        const response = await withCurrentConversationIdentity(captured);
        if (attestationBroken()) refuseUnattributableAnswer(response.conversationIdentity);
        // BB-A4-N03. The registration is only allowed to describe the conversation the answer
        // was attested in. A page that moved during persistence has no identity this answer may
        // carry, so the answer is refused and every conversation it could have belonged to is
        // quarantined rather than one of them being stamped onto it.
        if (response.documentRevision !== attested.documentRevision
          || response.conversationUrl !== attested.conversationUrl
          || response.conversationIdentity !== attested.conversationIdentity) {
          refuseUnattributableAnswer(response.conversationIdentity);
        }
        if (providerIdleConfirmed) {
          pendingReuseConfirmation = {
            requestId,
            documentToken: response.documentToken,
            documentRevision: response.documentRevision,
            conversationUrl: response.conversationUrl,
            conversationIdentity: response.conversationIdentity,
            conversationIdentities: uniqueConversationIdentities(
              request.conversationIdentity,
              response.conversationIdentity,
              ...(activeRequest?.conversationIdentities ?? []),
            ),
            expiresAt: now() + 15_000,
          };
        } else {
          pendingReuseConfirmation = undefined;
          quarantineConversations(request.conversationIdentity, response.conversationIdentity);
        }
        return { ...response, providerIdleConfirmed, completionSource };
      };
      try {
        return await finalizeResponse(await Promise.race([capture(), manualResponse]));
      } catch (error) {
        const continuityLost = error instanceof Error && /submitted request nonce is no longer present/i.test(error.message);
        const unattributable = error instanceof Error && error.message === unattributableAnswer;
        if (controller.signal.aborted
          || continuityLost
          || unattributable
          || now() >= request.deadlineAt
          || !(await healResponseBinding(profile, request.deadlineAt))) {
          throw error;
        }
        return await finalizeResponse(await Promise.race([capture(), manualResponse]));
      }
    } catch (error) {
      if (!submitted && composer.isConnected && normalizeComposerValue(readComposerValue(composer)) === normalizeComposerValue(payload)) {
        setComposerValue(composer, "");
      }
      if (submitted) {
        quarantineConversations(request.conversationIdentity, activeRequest?.conversationIdentity);
      }
      throw error;
    } finally {
      if (activeRequest?.requestId === requestId) {
        activeRequest = undefined;
      }
      controller.abort();
    }
  };

  const validateProfile = async (): Promise<boolean> => {
    const profile = await resolveProfile(true);
    const valid = profileIsStructurallyReady(profile);
    await markProfileValidation(profile, valid, documentRevision, !valid);
    return valid;
  };

  const autoHeal = async (): Promise<boolean> => {
    if (healingInFlight) return false;
    healingInFlight = true;
    const healingKey = healingDocumentKey();
    try {
      const existingProfile = await loadUnvalidatedBindingProfile();
      if (activeRequest || (existingProfile && providerGenerationActive(existingProfile)) || !reserveHealingAttempt()) return false;
      const candidates = collectDomCandidates();
      if (candidates.size < 2) return false;
      const decision = await healWithLocalModel(
        [...candidates.values()].map((entry) => entry.candidate),
      );
      if (healingDocumentKey() !== healingKey || activeRequest) return false;
      const composerId = decision.composerIds[0];
      const conversationRootId = decision.conversationRootIds[0];
      if (decision.status !== "selected" || !composerId || !conversationRootId) return false;
      const composerEntry = candidates.get(composerId);
      const rootEntry = candidates.get(conversationRootId);
      if (!composerEntry || !rootEntry) return false;
      const sendId = decision.sendButtonIds[0];
      const stopId = decision.stopButtonIds[0];
      const freshId = decision.newConversationButtonIds[0];
      const responseId = decision.responseMessageIds[0];
      const sendEntry = sendId ? candidates.get(sendId) : undefined;
      const stopEntry = stopId ? candidates.get(stopId) : undefined;
      const freshEntry = freshId ? candidates.get(freshId) : undefined;
      const responseEntry = responseId ? candidates.get(responseId) : undefined;
      if ((sendId && !sendEntry) || (stopId && !stopEntry) || (freshId && !freshEntry) || (responseId && !responseEntry)) return false;
      if (!healedElementMatchesRole(composerEntry.element, "composer")
        || !healedElementMatchesRole(rootEntry.element, "conversationRoot")
        || (sendEntry && !healedElementMatchesRole(sendEntry.element, "sendButton"))
        || (stopEntry && !healedElementMatchesRole(stopEntry.element, "stopButton"))
        || (freshEntry && !healedElementMatchesRole(freshEntry.element, "newConversationButton"))
        || (responseEntry && !healedElementMatchesRole(responseEntry.element, "responseMessage"))) return false;
      const candidateProfile: GenericBindingProfile = {
        protocol: "bachata-generic-binding-v1",
        origin: location.origin,
        routePattern: currentRoutePattern(),
        framePath: [],
        composer: createLocatorRecipe(composerEntry.element),
        conversationRoot: createLocatorRecipe(rootEntry.element),
        ...(sendEntry ? { sendButton: createLocatorRecipe(sendEntry.element) } : {}),
        ...(stopEntry ? { stopButton: createLocatorRecipe(stopEntry.element) } : {}),
        ...(freshEntry ? { newConversationButton: createLocatorRecipe(freshEntry.element) } : {}),
        ...(responseEntry ? { responseMessage: createLocatorRecipe(responseEntry.element) } : {}),
        createdBy: "autoHeal",
        bindingSources: {
          composer: "autoHeal",
          conversationRoot: "autoHeal",
          ...(sendEntry ? { sendButton: "autoHeal" as const } : {}),
          ...(stopEntry ? { stopButton: "autoHeal" as const } : {}),
          ...(freshEntry ? { newConversationButton: "autoHeal" as const } : {}),
          ...(responseEntry ? { responseMessage: "autoHeal" as const } : {}),
        },
        validated: false,
        consecutiveFailures: 0,
        documentRevision,
      };
      try {
        await saveBindingProfile(candidateProfile, existingProfile);
        if (!profileIsStructurallyReady(candidateProfile)) {
          await markProfileValidation(candidateProfile, false, documentRevision, true);
          return false;
        }
        await markProfileValidation(candidateProfile, true, documentRevision);
        return true;
      } catch {
        return false;
      }
    } finally {
      healingInFlight = false;
    }
  };

  const profileStatus = async (): Promise<{
    status: "ready" | "notReady" | "streaming";
    origin: string;
    url: string;
    title: string;
    documentRevision: number;
    documentToken: string;
    capabilities: {
      submission: "verifiedSend" | "syntheticEnter";
      completion: "verifiedLifecycle" | "manualOnly";
      interruption: "confirmed" | "unavailable";
      assets: "textOnly";
      conversationState: "confirmed" | "uncertain";
    };
  }> => {
    const validatedProfile = await resolveProfile().catch(() => undefined);
    const profile = validatedProfile ?? await resolveProfile(true).catch(() => undefined);
    const ready = Boolean(validatedProfile && profileIsStructurallyReady(validatedProfile));
    const busy = acceptingRequestIds.size > 0 || Boolean(activeRequest) || Boolean(profile && providerGenerationActive(profile));
    if (!ready && !busy && profile && profile.consecutiveFailures > 0) {
      void autoHeal().catch(() => undefined);
    }
    const send = profile?.sendButton ? resolveLocatorRecipe(profile.sendButton) : undefined;
    const stop = profile?.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
    const sendReady = Boolean(profile && send && autoHealedElementMatchesRole(profile, send, "sendButton"));
    const stopCurrentlyResolved = Boolean(
      profile
      && isActiveControl(stop)
      && autoHealedElementMatchesRole(profile, stop, "stopButton"),
    );
    if (profile && stopCurrentlyResolved && !profileHasObservedStopControl(profile)) {
      void recordObservedStopControl(profile).catch(() => undefined);
    }
    const lifecycleReady = profileHasVerifiedLifecycle(profile);
    const interruptionReady = profileHasConfirmedInterruption(profile);
    const uncertain = await conversationIsUncertain(currentConversationIdentity(), activeRequest?.conversationIdentity);
    return {
      status: busy ? "streaming" : ready && !uncertain ? "ready" : "notReady",
      origin: location.origin,
      url: location.href,
      title: document.title,
      documentRevision,
      documentToken,
      capabilities: {
        submission: sendReady ? "verifiedSend" : "syntheticEnter",
        completion: lifecycleReady ? "verifiedLifecycle" : "manualOnly",
        interruption: interruptionReady ? "confirmed" : "unavailable",
        assets: "textOnly",
        conversationState: uncertain ? "uncertain" : "confirmed",
      },
    };
  };

  const sendWithProfileTracking = async (
    request: Extract<GenericRequest, { type: "BACHATA_GENERIC_SEND" }>,
  ): Promise<GenericSendResult> => {
    const { requestId } = request;
    const uncertaintyReason = await conversationUncertaintyReason(
      request.conversationIdentity,
      currentConversationIdentity(),
    );
    if (uncertaintyReason === "quarantined") {
      throw new Error("The generic browser conversation is quarantined because provider idle state is uncertain; start a verified fresh conversation before sending again");
    }
    if (uncertaintyReason === "unavailable") {
      throw new Error("The conversation quarantine authority is unavailable, so this generic browser conversation cannot be proven safe to reuse; retry once the extension background is reachable");
    }
    if (activeRequest || acceptingRequestIds.size > 0) throw new Error("The generic browser conversation already has an active request");
    acceptingRequestIds.add(requestId);
    try {
      // The admission deadline check belongs to `runGenericSend`, which runs next and reports an
      // already-expired request in its own words. This is the binding check that precedes it.
      assertRequestMatchesCurrentDocument(request);
      if (cancelledRequestIds.has(requestId)) {
        throw new Error("The generic browser request was interrupted before submission");
      }
      let profile = await resolveProfile();
      if (!profile.sendButton) {
        const documentKey = healingDocumentKey();
        if (optionalSendHealingDocumentKey !== documentKey) {
          optionalSendHealingDocumentKey = documentKey;
          if (await autoHeal().catch(() => false)) {
            profile = await resolveProfile();
          }
        }
      }
      if (cancelledRequestIds.has(requestId)) {
        throw new Error("The generic browser request was interrupted before submission");
      }
      if (providerGenerationActive(profile)) {
        throw new Error("The generic browser conversation is already generating a response");
      }
      try {
        const response = await submitPrompt(profile, request);
        await markProfileValidation(profile, true, documentRevision);
        clearHealingAttempts();
        return response;
      } catch (error) {
        const cancelled = cancelledRequestIds.has(requestId) || isRequestAborted(requestId);
        const bindingInvalid = error instanceof Error && error.message === "The saved browser binding is no longer valid";
        if (!cancelled && bindingInvalid) {
          await markProfileValidation(profile, false, documentRevision);
          if (await autoHeal()) {
            const healed = await resolveProfile();
            try {
              const response = await submitPrompt(healed, request);
              await markProfileValidation(healed, true, documentRevision);
              clearHealingAttempts();
              return response;
            } catch (retryError) {
              const retryCancelled = cancelledRequestIds.has(requestId) || isRequestAborted(requestId);
              if (!retryCancelled && retryError instanceof Error && retryError.message === "The saved browser binding is no longer valid") {
                await markProfileValidation(healed, false, documentRevision);
              }
              throw retryError;
            }
          }
        }
        throw error;
      }
    } finally {
      acceptingRequestIds.delete(requestId);
      cancelledRequestIds.delete(requestId);
    }
  };

  let closeSetup: (() => void) | undefined;
  const handle = async (request: GenericRequest): Promise<GenericResponse> => {
    try {
      if (request.type === "BACHATA_GENERIC_SETUP") {
        closeSetup?.();
        closeSetup = showGenericSetup({
          revision: () => documentRevision,
          assertIdle: () => {
            if (activeRequest || acceptingRequestIds.size > 0) throw new Error("Finish the active request before changing its binding.");
          },
          validate: validateProfile,
          autoDetect: autoHeal,
          capabilities: async () => (await profileStatus()).capabilities,
        });
        return { ok: true };
      }
      if (request.type === "BACHATA_GENERIC_BIND") {
        return { ok: true, value: await pickBindingElement(request.role, documentRevision) };
      }
      if (request.type === "BACHATA_GENERIC_VALIDATE") {
        return { ok: true, value: await validateProfile() };
      }
      if (request.type === "BACHATA_GENERIC_STATUS") {
        return { ok: true, value: await profileStatus() };
      }
      if (request.type === "BACHATA_GENERIC_NEW_CONVERSATION") {
        return { ok: true, value: await startFreshConversation() };
      }
      if (request.type === "BACHATA_GENERIC_SEND") {
        return { ok: true, value: await sendWithProfileTracking(request) };
      }
      if (request.type === "BACHATA_GENERIC_CONFIRM_REUSE") {
        const deadline = now() + 2_000;
        while (activeRequest && now() < deadline) {
          await delay(25);
        }
        const pending = pendingReuseConfirmation;
        if (activeRequest || !pending || pending.expiresAt < now()) {
          pendingReuseConfirmation = undefined;
          throw new Error("No current generic browser reuse attestation is available");
        }
        if (pending.requestId !== request.requestId
          || pending.documentToken !== request.documentToken
          || pending.documentRevision !== request.documentRevision
          || pending.conversationUrl !== request.conversationUrl
          || pending.conversationIdentity !== request.conversationIdentity
          || documentToken !== request.documentToken
          || documentRevision !== request.documentRevision
          || canonicalConversationUrl() !== request.conversationUrl
          || currentConversationIdentity() !== request.conversationIdentity) {
          pendingReuseConfirmation = undefined;
          throw new Error("The generic browser reuse attestation no longer matches the current document");
        }
        const profile = await resolveProfile(true);
        const providerIdleStable = await waitForStableCondition({
          timeoutMs: 2_000,
          stableMs: 750,
          pollIntervalMs: 100,
          observe: () => Boolean(
            pendingReuseConfirmation === pending
            && documentToken === request.documentToken
            && documentRevision === request.documentRevision
            && canonicalConversationUrl() === request.conversationUrl
            && currentConversationIdentity() === request.conversationIdentity
            && profileIsStructurallyReady(profile)
            && !providerGenerationActive(profile)
          ),
        });
        if (!providerIdleStable) {
          pendingReuseConfirmation = undefined;
          throw new Error("The generic browser provider did not remain idle while reuse was confirmed");
        }
        clearConversationUncertainty(...pending.conversationIdentities);
        pendingReuseConfirmation = undefined;
        return { ok: true, value: { reuseConfirmed: true } };
      }
      if (request.type === "BACHATA_GENERIC_CANCEL") {
        if (activeRequest?.requestId !== request.requestId) {
          rememberCancellation(request.requestId);
          return { ok: true, value: { interrupted: true, submissionPrevented: true } };
        }
        if (!activeRequest.submitted) {
          rememberCancellation(request.requestId);
          activeRequest.controller.abort();
          return { ok: true, value: { interrupted: true, submissionPrevented: true } };
        }
        const current = activeRequest;
        // N1 / BB-A4-N02. Last-moment safety before a bound control on the page is activated,
        // and again after every await that follows. A submitted request whose document has been
        // replaced — or whose page has quietly become another conversation — cannot be
        // interrupted here: the Stop control this would click belongs to a page that is no
        // longer this turn's, and clicking it would report an interruption of work that was
        // never stopped. The conversation is quarantined instead, which is what an unproven
        // provider state already means.
        const ownershipRefusal = (
          profile?: GenericBindingProfile,
        ): { ok: false; error: string } | undefined => {
          const lost = cancellationOwnershipLost(current, profile);
          if (lost === undefined) return undefined;
          quarantineConversations(current.conversationIdentity);
          return { ok: false, error: lost };
        };
        const beforeProfile = ownershipRefusal();
        if (beforeProfile) return beforeProfile;
        const profile = await resolveProfile(true);
        const afterProfile = ownershipRefusal(profile);
        if (afterProfile) return afterProfile;
        await learnTransientStopBinding(
          profile,
          Math.min(3_000, Math.max(1, current.lifecycle.deadlineAt - now())),
          current.lifecycle,
        );
        const afterBinding = ownershipRefusal(profile);
        if (afterBinding) return afterBinding;
        let stopControlActivated = false;
        let providerIdleConfirmed = current.lifecycle.sawGeneration
          && current.lifecycle.generationEndedAt !== undefined
          && !providerGenerationActive(profile);
        if (!providerIdleConfirmed) {
          const stop = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
          if (!isActiveControl(stop) || !autoHealedElementMatchesRole(profile, stop, "stopButton")) {
            quarantineConversations(current.conversationIdentity);
            return { ok: false, error: "No active bound stop control is available to confirm interruption" };
          }
          await recordObservedStopControl(profile);
          const beforeClick = ownershipRefusal(profile);
          if (beforeClick) return beforeClick;
          stopControlActivated = true;
          stop.click();
          providerIdleConfirmed = await waitForProviderIdle(profile, request.requestId);
        }
        const afterIdle = ownershipRefusal(profile);
        if (afterIdle) return afterIdle;
        if (!providerIdleConfirmed) {
          quarantineConversations(current.conversationIdentity);
          return { ok: false, error: "The provider did not confirm that generation stopped" };
        }
        current.lifecycle.sawGeneration = true;
        current.lifecycle.generationEndedAt = now();
        current.providerIdleConfirmed = true;
        if (stopControlActivated) await recordConfirmedInterruption(profile);
        else await recordCompletedLifecycle(profile);
        const afterRecord = ownershipRefusal(profile);
        if (afterRecord) return afterRecord;
        const registration = await registerCurrentDocument();
        const afterRegistration = ownershipRefusal(profile);
        if (afterRegistration) return afterRegistration;
        pendingReuseConfirmation = {
          requestId: request.requestId,
          documentToken: registration.documentToken,
          documentRevision: registration.documentRevision,
          conversationUrl: registration.conversationUrl,
          conversationIdentity: registration.conversationIdentity,
          conversationIdentities: uniqueConversationIdentities(
            current.conversationIdentity,
            registration.conversationIdentity,
            ...current.conversationIdentities,
          ),
          expiresAt: now() + 15_000,
        };
        rememberCancellation(request.requestId);
        current.controller.abort();
        const releaseDeadline = now() + 2_000;
        while (activeRequest?.requestId === request.requestId && now() < releaseDeadline) {
          await delay(25);
        }
        return {
          ok: true,
          value: {
            interrupted: true,
            stopConfirmed: true,
            documentToken: registration.documentToken,
            documentRevision: registration.documentRevision,
            conversationUrl: registration.conversationUrl,
            conversationIdentity: registration.conversationIdentity,
          },
        };
      }
      if (request.type === "BACHATA_GENERIC_SELECTED_TEXT") {
        const selection = getSelection();
        const selected = selection ? selectionToCapturedResponse(selection) : { text: "", segments: [] };
        const text = selected.text;
        if (text && activeRequest) {
          const current = activeRequest;
          const requestId = current.requestId;
          const lifecycle = current.lifecycle;
          const selectedRevision = documentRevision;
          const selectedIdentity = currentConversationIdentity();
          const assertSelectionOwner = (profile?: GenericBindingProfile): void => {
            const lost = cancellationOwnershipLost(current, profile);
            if (lost || documentRevision !== selectedRevision || currentConversationIdentity() !== selectedIdentity) {
              quarantineConversations(current.conversationIdentity);
              throw new Error(lost ?? "The conversation changed after the answer was selected");
            }
          };
          assertSelectionOwner();
          const profile = await resolveProfile(true);
          assertSelectionOwner(profile);
          await learnTransientStopBinding(
            profile,
            Math.min(3_000, Math.max(1, lifecycle.deadlineAt - now())),
            lifecycle,
          );
          assertSelectionOwner(profile);
          let stopControlActivated = false;
          let providerIdleConfirmed = lifecycle.sawGeneration
            && lifecycle.generationEndedAt !== undefined
            && !providerGenerationActive(profile);
          if (providerGenerationActive(profile)) {
            const stop = profile.stopButton ? resolveLocatorRecipe(profile.stopButton) : undefined;
            if (isActiveControl(stop) && autoHealedElementMatchesRole(profile, stop, "stopButton")) {
              await recordObservedStopControl(profile);
              assertSelectionOwner(profile);
              stopControlActivated = true;
              stop.click();
              providerIdleConfirmed = await waitForProviderIdle(profile, requestId);
              assertSelectionOwner(profile);
              if (providerIdleConfirmed) {
                lifecycle.sawGeneration = true;
                lifecycle.generationEndedAt = now();
              }
            }
          }
          current.providerIdleConfirmed = providerIdleConfirmed;
          if (providerIdleConfirmed) {
            if (stopControlActivated) await recordConfirmedInterruption(profile);
            else await recordCompletedLifecycle(profile);
            assertSelectionOwner(profile);
          } else {
            quarantineConversations(current.conversationIdentity);
          }
          if (activeRequest?.requestId === requestId) {
            assertSelectionOwner(profile);
            // BB-A4-N03. The page this manually selected answer was taken from, recorded in the
            // same synchronous run that accepts it, exactly as the automatic capture does.
            current.resolveManual({
              markdown: text,
              text,
              segments: selected.segments,
            }, {
              requestId,
              nonce: current.nonce,
              documentRevision,
              conversationUrl: canonicalConversationUrl(),
              conversationIdentity: currentConversationIdentity(),
            });
            setTimeout(() => current.controller.abort(), 0);
          }
        }
        return { ok: true, value: text };
      }
      if (request.type === "BACHATA_GENERIC_READABLE") {
        return { ok: true, value: extractReadablePage() };
      }
      if (request.type === "BACHATA_GENERIC_AUTO_HEAL") {
        return { ok: true, value: await autoHeal() };
      }
      return { ok: false, error: "Unknown generic browser request" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  window.addEventListener("pagehide", () => {
    if (activeRequest?.submitted) {
      quarantineConversations(activeRequest.conversationIdentity);
    }
  });
  observeDocumentReplacement();
  observeNavigation();
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || !String((message as Record<string, unknown>).type).startsWith("BACHATA_GENERIC_")) {
      return false;
    }
    void handle(message as GenericRequest).then(sendResponse);
    return true;
  });
  registerDocument();
}
