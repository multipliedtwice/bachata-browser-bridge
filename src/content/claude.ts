(() => {
const bachataAssetLogic = (globalThis as BachataAssetGlobal).__pairAssetLogic;
const bachataProviderControls = (
  globalThis as BachataProviderControlsGlobal
).__pairProviderControls;

// BB-4. What this file reads out of the shared logic is the shared logic's own type. A
// hand-written copy of it here was a second declaration of one contract, and it drifted the
// moment the shared implementation grew.
const bachataClaudeLogic = (globalThis as BachataClaudeGlobal).__pairClaudeLogic;
const bachataDomHealing = (globalThis as BachataDomHealingGlobal).__pairDomHealing;
if (!bachataClaudeLogic || !bachataAssetLogic || !bachataProviderControls || !bachataDomHealing) {
  throw new Error("Bachata Claude logic was not initialized");
}

const {
  assertTextWithinLimit,
  canonicalConversationUrl,
  canonicalizeRenderedPrompt,
  composeCapturedResponse,
  conversationIdentityFor,
  createAssetTransferDriver,
  captureResponseParts,
  createInterruptControl,
  createInterruptHandler,
  createProviderStatusReader,
  createCancellationRegistry,
  createComposerGuard,
  createRegistrationCoordinator,
  createInterruptLease,
  createRequestTeardown,
  createIndeterminateMonitor,
  createResponseActivityObserver,
  createStreamSender,
  createSubmittedPromptWaiter,
  createResponseBinder,
  createAssetSourceStore,
  createAttachmentStaging,
  createComposerResolver,
  createConversationBinder,
  attachmentFile,
  writeStagedAttachments,
  installProviderDocument,
  startLifecycleObserver,
  sendBackground,
  isBusyState,
  shouldCompleteResponse,
  uniqueItem,
} = bachataClaudeLogic;

const {
  createInlineAsset,
  discoverLinkedAssets,
  serializedByteLength,
  toPublicMetadata,
  transferAsset,
} = bachataAssetLogic;

const {
  waitForResolvedControl,
  queryUniqueWithin,
  conversationQuarantineState,
  conversationIsQuarantined,
  quarantineConversation,
  clearConversationQuarantine,
} = bachataProviderControls;

type BrowserAttachment = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  dataBase64: string;
};

type ConversationBinding = {
  requestId: string;
  agentId: string;
  provider: "claude";
  sessionId: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
};

type SendMessage = ConversationBinding & {
  type: "conversation.send";
  text: string;
  attachments: BrowserAttachment[];
  allowInitialConversationTransition: boolean;
  deadlineAt: number;
};

type ActiveSendMessage = SendMessage & {
  /**
   * BR-G6-04. The conversation the controller authorized, kept apart from the one this request
   * is dispatched against, which an accepted first-turn transition rewrites.
   */
  authorizedConversationIdentity: string;
  transitionUsed: boolean;
  submissionCommitted: boolean;
  initialArtifacts: ReadonlyMap<HTMLElement, string>;
};

type InterruptMessage = ConversationBinding & {
  type: "conversation.interrupt";
};

type AssetFetchMessage = {
  type: "asset.fetch";
  transferId: string;
  assetId: string;
  maxBytes: number;
};

type AssetCancelMessage = {
  type: "asset.cancel";
  transferId: string;
  assetId: string;
};

type SubmittedUserBinding = {
  element: HTMLElement;
  providerMessageId?: string;
  previousUsers: ReadonlySet<HTMLElement>;
  text: string;
};

type ResponseBinding = {
  element: HTMLElement;
  providerMessageId?: string;
  previousAssistants: ReadonlySet<HTMLElement>;
  submittedUser: SubmittedUserBinding;
};

type LifecycleObserver = {
  observer: MutationObserver;
  busyObserved: boolean;
};

const composerSelectors = [
  "[data-testid='chat-input']",
  "div.ProseMirror[contenteditable='true']",
  "div[contenteditable='true'][role='textbox']",
];
const sendSelectors = [
  "button[aria-label='Send message']",
  "button[aria-label='Send Message']",
  "button[type='submit'][aria-label*='Send' i]",
];
const stopSelectors = [
  "button[aria-label='Stop response']",
  "button[aria-label='Stop Response']",
  "button[aria-label*='Stop' i]",
];
const assistantSelector = "div.font-claude-response, [data-testid='assistant-message']";
const userSelector = "[data-testid='user-message'], div.font-user-message";
const documentToken = crypto.randomUUID();
const maximumResponseBytes = 52_428_800;
const requiredQuietMs = 2_500;
const busyObservationTimeoutMs = 15_000;
const cancelledRequests = createCancellationRegistry({
  isActive: (requestId) => activeRequest?.requestId === requestId,
});
const globalKey = "__pairBrowserBridgeClaudeV6";
let activeRequest: ActiveSendMessage | undefined;
let composerBlockedReason: string | undefined;
const { sources: assetSources, remember: rememberAssetSources } = createAssetSourceStore({
  maximumSources: 128,
  maximumInlineBytes: 64 * 1024 * 1024,
});

const globalState = globalThis as typeof globalThis & Record<string, unknown>;
if (!globalState[globalKey]) {
  globalState[globalKey] = true;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const queryUnique = <T extends Element>(selectors: string[]): T | undefined =>
  uniqueItem(
    selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll<T>(selector)),
    ),
  );

const healedControls = (): BachataDomHealingSelection | undefined =>
  bachataDomHealing.cached("claude");

const controlDisabled = (element: HTMLElement | undefined): boolean =>
  element instanceof HTMLButtonElement
    ? element.disabled
    : element?.getAttribute("aria-disabled") === "true";

const composer = (): HTMLTextAreaElement | HTMLInputElement | HTMLElement | undefined => {
  try {
    return queryUnique<HTMLTextAreaElement | HTMLElement>(composerSelectors) ?? healedControls()?.composer;
  } catch (cause) {
    const healed = healedControls()?.composer;
    if (healed) return healed;
    throw cause;
  }
};

const composerControlRoot = (): Element | undefined => {
  const element = composer();
  return element?.closest("form") ?? element?.parentElement ?? undefined;
};

const sendButton = (): HTMLElement | undefined => {
  try {
    return queryUniqueWithin<HTMLButtonElement>(
      composerControlRoot(),
      sendSelectors,
      "Claude composer contains ambiguous Send controls",
    ) ?? healedControls()?.sendButton;
  } catch (cause) {
    const healed = healedControls()?.sendButton;
    if (healed) return healed;
    throw cause;
  }
};

const stopButton = (): HTMLElement | undefined => {
  try {
    return queryUniqueWithin<HTMLButtonElement>(
      composerControlRoot(),
      stopSelectors,
      "Claude composer contains ambiguous Stop controls",
    ) ?? healedControls()?.stopButton;
  } catch (cause) {
    const healed = healedControls()?.stopButton;
    if (healed) return healed;
    throw cause;
  }
};

const healDom = async (force = false, deadlineAt?: number): Promise<boolean> => {
  try {
    return await bachataDomHealing.heal("claude", force, deadlineAt);
  } catch {
    return false;
  }
};

// BB-4. Resolving the composer and waiting for a really-enabled send control are the shared
// implementation in `providerLogic.ts`; what this file supplies is which elements those are.
const { resolveComposer, waitForEnabledSendButton } = createComposerResolver({
  composer,
  sendButton,
  healDom,
  healedControls,
  controlDisabled,
  delay,
  cancelled: (requestId) => cancelledRequests.has(requestId),
  waitForResolvedControl,
});


const readComposer = (element: HTMLTextAreaElement | HTMLInputElement | HTMLElement): string =>
  element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
    ? element.value
    : element.innerText.replace(/\n$/, "");

const writeComposer = (
  element: HTMLTextAreaElement | HTMLInputElement | HTMLElement,
  text: string,
): void => {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) {
      throw new Error("Claude composer value setter is unavailable");
    }
    setter.call(element, text);
  } else {
    const lines = text.split("\n");
    element.replaceChildren(
      ...lines.map((line) => {
        const paragraph = document.createElement("p");
        paragraph.append(document.createTextNode(line || " "));
        return paragraph;
      }),
    );
  }
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const attachmentButtonSelectors = [
  "button[aria-label*='Attach' i]",
  "button[aria-label*='Upload' i]",
  "button[data-testid*='file' i]",
].map(String);

// BB-4. Claude trusts no detached upload control: the picker must be inside the composer it is
// staging for. That difference is data; what the page then introduces is judged by the shared
// implementation.
const { attachmentInput, openAttachmentInput } = createAttachmentStaging({
  controls: bachataProviderControls,
  attachmentRoot: () => composer()?.closest("form") ?? undefined,
  page: () => document,
  associatedSelectors: attachmentButtonSelectors,
  delay,
  cancelled: (requestId) => cancelledRequests.has(requestId),
});

// BB-4. The composer conflict check, its cleanup, the pre-submission refusal and the
// attachment-staging helpers they use are the shared implementation in `providerLogic.ts`; only
// this provider's composer access and its own blocked-composer record are supplied here. The
// wording the user sees is unchanged: the provider's name comes from the configured label.
const {
  captureAttachmentBaseline,
  commitAttachmentOwnership,
  recordStagedFiles,
  recordInsertedText,
  stagingWriteRefusal,
  foreignAttachmentRefusal,
  stagedAttachmentRefusal,
  composerConflict,
  rejectBeforeSubmission,
} = createComposerGuard<
  HTMLTextAreaElement | HTMLElement
>({
  readComposer,
  writeComposer,
  attachmentInput,
  delay,
  blockComposer: (reason) => {
    composerBlockedReason = reason;
  },
});

type AttachmentStagingRun = {
  attachments: readonly BrowserAttachment[];
  requestId?: string;
  requestDeadlineAt?: number;
  // BR-G6-02 residue. The ownership commit, run after every refusal has answered and with the
  // native setter as the next statement.
  onBeforeWrite?: () => void;
  // BR-G6-02. Called with the exact files the moment they reach the input, so a refusal raised
  // after that still leaves the cleanup able to name what it may take back out.
  onStaged?: (files: readonly File[]) => void;
  // BR-G6-02 residue. The synchronous last look, run with the resolved input in hand and with
  // nothing awaited between its answer and the native setter.
  refuseBeforeWrite?: (input: HTMLInputElement) => string | undefined;
  // BR-G6-02 residue. The same question after the write and after every await that follows it.
  refuseAfterAwait?: () => string | undefined;
};

const attachImages = async ({
  attachments,
  requestId,
  requestDeadlineAt,
  onBeforeWrite,
  onStaged,
  refuseBeforeWrite,
  refuseAfterAwait,
}: AttachmentStagingRun): Promise<void> => {
  if (attachments.length === 0) {
    return;
  }
  if (requestId && cancelledRequests.has(requestId)) throw new Error("Claude request was interrupted before attachments were staged");
  if (requestDeadlineAt !== undefined && Date.now() >= requestDeadlineAt) throw new Error("Claude request deadline expired before attachments were staged");
  const input = await openAttachmentInput(requestId, requestDeadlineAt);
  if (!input) {
    if (requestId && cancelledRequests.has(requestId)) throw new Error("Claude request was interrupted before attachments were staged");
    if (requestDeadlineAt !== undefined && Date.now() >= requestDeadlineAt) throw new Error("Claude request deadline expired before attachments were staged");
    throw new Error("Claude image attachment input is unavailable");
  }
  if (requestId && cancelledRequests.has(requestId)) throw new Error("Claude request was interrupted before attachments were staged");
  writeStagedAttachments({
    input,
    files: attachments.map((attachment) => attachmentFile(attachment)),
    refuseBeforeWrite,
    onBeforeWrite,
    onStaged,
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const foreign = refuseAfterAwait?.();
    if (foreign) {
      throw new Error(foreign);
    }
    const send = sendButton();
    if (send && !controlDisabled(send)) {
      return;
    }
    await delay(100);
  }
  throw new Error("Claude did not finish staging the image attachments");
};

const currentUrl = (): string => canonicalConversationUrl(location.href);
const currentIdentity = (): string => conversationIdentityFor(currentUrl());

const assetTransferDriver = createAssetTransferDriver({
  documentToken,
  unavailableMessage: "The Claude asset is no longer available in this document",
  assetSources,
  sendBackground,
  transferAsset,
});

const fetchAsset = (message: AssetFetchMessage): Promise<void> =>
  assetTransferDriver.fetchAsset(message);

const cancelAsset = (message: AssetCancelMessage): boolean =>
  assetTransferDriver.cancelAsset(message);

// BB-4. The seven-answer status projection both providers held byte-identically, now decided
// once in `providerLogic.ts`. What differs is the provider name the quarantine authority is
// asked about and the page shapes below, which stay here.
const providerStatus = createProviderStatusReader({
  provider: "claude",
  documentToken,
  currentUrl,
  conversationIdentityFor,
  conversationIsQuarantined,
  resolveComposer,
  onAuthenticationPath: () => location.pathname.includes("auth"),
  composerBlockedReason: () => composerBlockedReason,
  generationActive: () => Boolean(activeRequest || stopButton()),
  composerConflict,
});

const registration = createRegistrationCoordinator({
  currentUrl,
  registerUrl: async (conversationUrl) => {
    await sendBackground({
      type: "content.register",
      provider: "claude",
      documentToken,
      conversationUrl,
      conversationIdentity: conversationIdentityFor(conversationUrl),
    });
  },
});

const registerDocument = (): Promise<void> => registration.register();

const ensureRegisteredUrl = (verify = false): void => {
  if (!activeRequest) {
    void registration.ensure(verify).catch(() => undefined);
  }
};

// BB-4. Every exit from a turn ends the same way: the request is no longer cancellable, it is no
// longer the active one, and the document re-registers whatever URL it is on now.
// BB-A4-N01. A request being stopped is not a request that has ended. The lease keeps the
// cancellation record and the active request alive for the interrupt that is confirming the
// native Stop, and the teardown that arrives meanwhile runs when the interrupt lets go.
const interruptLease = createInterruptLease();

const forgetRequest = createRequestTeardown({
  cancelledRequests,
  activeRequestId: () => activeRequest?.requestId,
  clearActiveRequest: () => {
    activeRequest = undefined;
  },
  ensureRegisteredUrl: () => ensureRegisteredUrl(),
  lease: interruptLease,
});

const currentMessages = (selector: string): HTMLElement[] => {
  const direct = Array.from(document.querySelectorAll<HTMLElement>(selector));
  const healed = bachataDomHealing.messageElements("claude").filter((candidate) =>
    !direct.some((element) => element === candidate || element.contains(candidate) || candidate.contains(element)),
  );
  const elements = [...new Set([...direct, ...healed])];
  return elements.sort((left, right) => {
    if (left === right) return 0;
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
};

const messageId = (element: HTMLElement): string | undefined => {
  const candidate =
    element.getAttribute("data-message-id") ??
    element.closest<HTMLElement>("[data-message-id]")?.getAttribute(
      "data-message-id",
    );
  return candidate?.trim() || undefined;
};

const isAfter = (candidate: Node, reference: Node): boolean =>
  Boolean(
    reference.compareDocumentPosition(candidate) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );

// BB-4. The one navigation a running request may make, decided and announced once in
// `providerLogic.ts`.
const ensureConversationBinding = createConversationBinder({
  documentToken,
  provider: "claude",
  currentUrl,
  sendBackground,
  registerDocument,
});

const matchingNewUsers = (
  binding: SubmittedUserBinding,
): HTMLElement[] =>
  currentMessages(userSelector).filter(
    (element) =>
      !binding.previousUsers.has(element) &&
      canonicalizeRenderedPrompt(element.innerText) === binding.text,
  );

const resolveSubmittedUser = (binding: SubmittedUserBinding): HTMLElement => {
  if (binding.providerMessageId) {
    const matches = currentMessages(userSelector).filter(
      (element) => messageId(element) === binding.providerMessageId,
    );
    if (matches.length !== 1) {
      throw new Error("The submitted Claude message identifier became ambiguous");
    }
    const match = matches[0];
    if (!match) throw new Error("The submitted Claude message disappeared");
    binding.element = match;
    return binding.element;
  }
  if (
    binding.element.isConnected &&
    canonicalizeRenderedPrompt(binding.element.innerText) === binding.text
  ) {
    return binding.element;
  }
  const matches = matchingNewUsers(binding);
  if (matches.length !== 1) {
    throw new Error("The submitted Claude message became ambiguous");
  }
  const match = matches[0];
  if (!match) throw new Error("The submitted Claude message disappeared");
  binding.element = match;
  const nextProviderMessageId = messageId(binding.element);
  if (nextProviderMessageId) binding.providerMessageId = nextProviderMessageId;
  return binding.element;
};

// BB-4. Waiting for the submitted prompt to appear is the shared implementation; which elements
// are user messages is this file's.
const waitForSubmittedPrompt = createSubmittedPromptWaiter({
  cancelled: (requestId) => cancelledRequests.has(requestId),
  ensureConversationBinding,
  userMessages: () => currentMessages(userSelector),
  messageId,
  healDom: () => healDom(),
  delay,
});

// BB-4. What a stream update is, and when there is nothing to send, is decided once in
// `providerLogic.ts`.
const sendStream = createStreamSender({ documentToken, maximumResponseBytes });

const newAssistantsAfterUser = (
  previousAssistants: ReadonlySet<HTMLElement>,
  submittedUser: SubmittedUserBinding,
): HTMLElement[] => {
  const user = resolveSubmittedUser(submittedUser);
  return currentMessages(assistantSelector).filter(
    (element) => !previousAssistants.has(element) && isAfter(element, user),
  );
};

const resolveBoundResponse = (binding: ResponseBinding): HTMLElement => {
  if (binding.providerMessageId) {
    const matches = currentMessages(assistantSelector).filter(
      (element) => messageId(element) === binding.providerMessageId,
    );
    if (matches.length !== 1) {
      throw new Error("The bound Claude response identifier became ambiguous");
    }
    const match = matches[0];
    if (!match) throw new Error("The bound Claude response disappeared");
    binding.element = match;
    return binding.element;
  }

  if (binding.element.isConnected) {
    const candidates = newAssistantsAfterUser(
      binding.previousAssistants,
      binding.submittedUser,
    );
    if (candidates.length === 1 && candidates[0] === binding.element) {
      return binding.element;
    }
  }

  const replacements = newAssistantsAfterUser(
    binding.previousAssistants,
    binding.submittedUser,
  );
  return rebindResponse(binding, replacements);
};

// BB-4. Waiting for the response this turn produced, and re-attaching it when the provider
// replaces the node, are the shared implementation; the selectors that find a message are not.
const { waitForResponseBinding, rebindResponse } = createResponseBinder({
  cancelled: (requestId) => cancelledRequests.has(requestId),
  ensureConversationBinding,
  newAssistantsAfterUser,
  messageId,
  healDom: () => healDom(),
  delay,
});


const artifactInteractiveSelector =
  "button, a, input, select, textarea, [contenteditable='true'], [role='button'], [role='menuitem'], [role='tab']";
const artifactPaneSelectors = [
  "[data-testid='artifact-panel']",
  "[data-testid='artifact-pane']",
  "[data-testid='artifact-content']",
  "[data-artifact-id]",
  "aside [class*='artifact' i]",
  "[role='dialog'] [class*='artifact' i]",
];

const artifactText = (element: HTMLElement): string => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll<HTMLElement>(artifactInteractiveSelector)
    .forEach((interactive) => interactive.remove());
  return (clone.innerText || clone.textContent || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const artifactFingerprint = (element: HTMLElement): string =>
  [
    element.getAttribute("data-artifact-id") ?? "",
    element.getAttribute("data-testid") ?? "",
    element.getAttribute("aria-label") ?? "",
    artifactText(element),
  ].join("\u0000");

const currentClaudeArtifacts = (): Map<HTMLElement, string> => {
  const candidates = artifactPaneSelectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)),
  );
  const unique = Array.from(new Set(candidates)).filter((element) => {
    if (!element.isConnected || element.closest(artifactInteractiveSelector)) {
      return false;
    }
    if (!artifactText(element)) {
      return false;
    }
    return !candidates.some(
      (other) => other !== element && other.contains(element),
    );
  });
  return new Map(unique.map((element) => [element, artifactFingerprint(element)]));
};

const claudeArtifactSources = (
  initialArtifacts: ReadonlyMap<HTMLElement, string>,
): BachataAssetSource[] =>
  Array.from(currentClaudeArtifacts().keys())
    .filter(
      (element) =>
        initialArtifacts.get(element) !== artifactFingerprint(element),
    )
    .map((element, index) => {
      const text = artifactText(element);
      const heading = element.querySelector<HTMLElement>(
        "h1, h2, h3, [data-testid='artifact-title']",
      );
      const name =
        element.getAttribute("data-artifact-title")?.trim() ||
        heading?.innerText.trim() ||
        element.getAttribute("aria-label")?.trim() ||
        `Claude artifact ${String(index + 1)}.txt`;
      const providerAssetId =
        element.getAttribute("data-artifact-id") ??
        element.getAttribute("data-testid") ??
        undefined;
      const source = createInlineAsset({
        provider: "claude",
        documentToken,
        kind: element.querySelector("pre, code") ? "codeArtifact" : "artifact",
        name,
        mimeType: "text/plain",
        sourceElement: "artifactPane",
        ...(providerAssetId ? { providerAssetId } : {}),
        text,
        previewText: text.slice(0, 2_000),
      });
      source.reveal = () => {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        element.focus({ preventScroll: true });
      };
      return source;
    });

const captureResponse = async (
  request: ActiveSendMessage,
  previousAssistants: ReadonlySet<HTMLElement>,
  submittedUser: SubmittedUserBinding,
  lifecycle: LifecycleObserver,
): Promise<void> => {
  const startedAt = new Date().toISOString();
  // BB-4. Whether the bound response is still changing is watched by the shared observer in
  // `providerLogic.ts`; which element is the response stays here.
  const responseActivity = createResponseActivityObserver();
  try {
    const binding = await waitForResponseBinding(
      request,
      previousAssistants,
      submittedUser,
    );
    let lastText = "";
    let idleSince: number | undefined;
    const deadline = request.deadlineAt;
    const busyDeadline = Math.min(deadline, Date.now() + busyObservationTimeoutMs);

    while (Date.now() < deadline) {
      if (cancelledRequests.has(request.requestId)) {
        return;
      }
      await ensureConversationBinding(request);
      const response = resolveBoundResponse(binding);
      responseActivity.bind(response);
      const text = response.innerText;
      if (text !== lastText) {
        await sendStream(request, lastText, text);
        lastText = text;
        responseActivity.touch();
      }

      const currentlyBusy = isBusyState(Boolean(stopButton()));
      if (currentlyBusy) {
        lifecycle.busyObserved = true;
        idleSince = undefined;
      } else if (lifecycle.busyObserved) {
        idleSince ??= Date.now();
      }
      if (!lifecycle.busyObserved && Date.now() >= busyDeadline) {
        throw new Error(
          "Claude response appeared without an observable generation lifecycle",
        );
      }

      if (
        shouldCompleteResponse({
          busyObserved: lifecycle.busyObserved,
          currentlyBusy,
          responseText: text,
          quietForMs: Date.now() - responseActivity.lastMutationAt(),
          requiredQuietMs,
          idleForMs: idleSince === undefined ? 0 : Date.now() - idleSince,
          requiredIdleMs: requiredQuietMs,
        })
      ) {
        const finalResponse = resolveBoundResponse(binding);
        const captured = composeCapturedResponse(
          captureResponseParts(finalResponse),
        );
        assertTextWithinLimit(
          captured.text,
          maximumResponseBytes,
          "Claude captured response",
        );
        const sources = [
          ...discoverLinkedAssets(
            "claude",
            finalResponse,
            documentToken,
          ),
          ...claudeArtifactSources(request.initialArtifacts),
        ];
        rememberAssetSources(sources);
        const message = {
          type: "content.response",
          documentToken,
          response: {
            requestId: request.requestId,
            agentId: request.agentId,
            sessionId: request.sessionId,
            provider: "claude",
            text: captured.text,
            segments: captured.segments,
            assets: sources.map(toPublicMetadata),
            captureFormat: "renderedText",
            fidelity: "bestEffort",
            finalConversationUrl: request.conversationUrl,
            startedAt,
            completedAt: new Date().toISOString(),
          },
        };
        if (serializedByteLength(message) > maximumResponseBytes) {
          throw new Error("Claude captured response exceeds the transport limit");
        }
        clearConversationQuarantine("claude", request.conversationIdentity);
        await sendBackground(message);
        return;
      }
      await delay(100);
    }
    throw new Error("Timed out waiting for Claude response completion");
  } catch (cause) {
    if (!cancelledRequests.has(request.requestId)) {
      quarantineConversation("claude", request.conversationIdentity);
      await sendBackground({
        type: "content.error",
        documentToken,
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        code: "RESPONSE_CAPTURE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
      }).catch(() => undefined);
    }
  } finally {
    responseActivity.disconnect();
    lifecycle.observer.disconnect();
    forgetRequest(request.requestId);
  }
};

// BB-4. Stopping a turn and confirming it stopped is decided in `providerLogic.ts`; what this
// file supplies is which element is Stop, what busy means here, and how a lost control is found
// again.
const interruptControl = createInterruptControl({
  stopButton,
  isBusy: () => isBusyState(Boolean(stopButton())),
  heal: async (deadlineAt) => await healDom(Boolean(healedControls()), deadlineAt),
  delay,
  waitForResolvedControl,
  rememberCancellation: (requestId) => cancelledRequests.add(requestId),
  forgetCancellation: (requestId) => { cancelledRequests.delete(requestId); },
  // BR-G6-05. The turn this document is still running, in the conversation it is still running
  // it in. An accepted first-turn transition moves `conversationIdentity` with the page, so a
  // legitimately rebound turn stays bound; a page that became somebody else's conversation, a
  // replaced document, or a turn that ended does not.
  stillBound: (requestId) =>
    activeRequest?.requestId === requestId
    && activeRequest.documentToken === documentToken
    && activeRequest.conversationIdentity === conversationIdentityFor(currentUrl()),
  lease: interruptLease,
  retireRequest: (requestId) => forgetRequest(requestId),
});

const interruptAndConfirm = (
  requestId: string,
  requireStopControl = true,
): Promise<boolean> => interruptControl.interruptAndConfirm(requestId, requireStopControl);

// BB-4. Watching a turn nobody could verify or interrupt is the shared implementation; what
// busy means on this page, and which conversation is quarantined, are this file's.
const monitorIndeterminateRequest = createIndeterminateMonitor({
  isBusy: () => isBusyState(Boolean(stopButton())),
  delay,
  stillActive: (requestId) => activeRequest?.requestId === requestId,
  quarantine: (conversationIdentity) => quarantineConversation("claude", conversationIdentity),
  clearQuarantine: (conversationIdentity) =>
    clearConversationQuarantine("claude", conversationIdentity),
  settle: forgetRequest,
  forget: (requestId) => {
    cancelledRequests.delete(requestId);
  },
});

// BB-4. Stopping a turn, and the commitment boundary that decides whether a stop may be
// reported, are the shared implementation in `providerLogic.ts`.
const interrupt = createInterruptHandler({
  provider: "claude",
  documentToken,
  currentUrl,
  currentIdentity,
  activeRequest: () => activeRequest,
  rememberPreSubmit: (requestId) => cancelledRequests.rememberPreSubmit(requestId),
  cancelHealing: () => bachataDomHealing.cancel("claude"),
  ensureConversationBinding,
  interruptAndConfirm: (requestId) => interruptAndConfirm(requestId),
  quarantine: (conversationIdentity) =>
    quarantineConversation("claude", conversationIdentity),
  clearQuarantine: (conversationIdentity) =>
    clearConversationQuarantine("claude", conversationIdentity),
});

const submit = async (
  incoming: SendMessage,
): Promise<{ submitted: boolean; error?: string }> => {
  ensureRegisteredUrl();
  const request: ActiveSendMessage = {
    ...incoming,
    conversationUrl: canonicalConversationUrl(incoming.conversationUrl),
    authorizedConversationIdentity: incoming.conversationIdentity,
    transitionUsed: false,
    submissionCommitted: false,
    initialArtifacts: currentClaudeArtifacts(),
  };
  if (
    request.provider !== "claude" ||
    request.documentToken !== documentToken ||
    request.frameId !== 0 ||
    request.conversationUrl !== currentUrl() ||
    request.conversationIdentity !== currentIdentity()
  ) {
    return {
      submitted: false,
      error: "The selected Claude document no longer matches the request",
    };
  }
  if (cancelledRequests.has(request.requestId)) {
    cancelledRequests.delete(request.requestId);
    return { submitted: false, error: "Claude request was interrupted before submission" };
  }
  if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= Date.now()) {
    return { submitted: false, error: "Claude request deadline expired before submission" };
  }
  if (activeRequest) {
    return { submitted: false, error: "A Claude response is already active" };
  }
  // An authority that cannot answer blocks the send exactly like a held verdict, but says so in
  // its own words: one is a conversation to abandon, the other is a condition that passes.
  const quarantineState = await conversationQuarantineState("claude", request.conversationIdentity);
  if (quarantineState !== "clear") {
    return {
      submitted: false,
      error: quarantineState === "quarantined"
        ? "This Claude conversation is quarantined because provider idle state could not be confirmed. Open a fresh conversation before continuing."
        : "The conversation quarantine authority is unavailable, so this Claude conversation cannot be proven safe to reuse. Retry once the extension background is reachable.",
    };
  }

  // BB-AUD-10. `stopButton()` throws when a control it needs is ambiguous and no healed
  // binding resolves it — the stop control itself, or the composer whose control root scopes
  // the lookup. Ambiguity is not proof of an idle conversation, and this guard exists to
  // refuse exactly the case it cannot rule out, so it refuses rather than sending into a
  // turn that may still be running. The message names no single control, because the throw
  // does not say which one was ambiguous.
  try {
    if (stopButton()) {
      return { submitted: false, error: "A Claude response is already active" };
    }
  } catch {
    return {
      submitted: false,
      error: "The Claude page offers more than one matching control, so an active response cannot be ruled out. Reload the conversation, then retry.",
    };
  }

  activeRequest = request;
  let element: HTMLTextAreaElement | HTMLInputElement | HTMLElement | undefined;
  // BR-G6-02. What this request has put into the composer, so a refusal removes its own
  // insertion and never a draft or an attachment the person left there.
  const composerOwnership: ComposerOwnership = {};
  let lifecycle: LifecycleObserver | undefined;
  const failBeforeSubmission = async (error: string): Promise<{ submitted: boolean; error?: string }> => {
    lifecycle?.observer.disconnect();
    const result = element
      ? await rejectBeforeSubmission(element, error, composerOwnership)
      : { submitted: false as const, error };
    forgetRequest(request.requestId);
    return result;
  };
  // BR-G6-02 residue. The whole pre-submission state in one synchronous read, so the answer can
  // be taken with the native `files` setter as the very next statement. Everything the
  // asynchronous check does is here except the conversation binder, whose pre-commitment
  // decision is exactly this comparison.
  const preSubmitRefusal = (
    expectedComposerText?: string,
    attachmentRefusal: (ownership: ComposerOwnership) => string | undefined = stagedAttachmentRefusal,
  ): string | undefined => {
    if (cancelledRequests.has(request.requestId) || activeRequest?.requestId !== request.requestId) {
      return "Claude request was interrupted before submission";
    }
    if (Date.now() >= request.deadlineAt) {
      return "Claude request deadline expired before submission";
    }
    if (
      request.documentToken !== documentToken ||
      request.frameId !== 0 ||
      request.conversationUrl !== currentUrl() ||
      request.conversationIdentity !== currentIdentity()
    ) {
      return "The Claude conversation changed during the active request";
    }
    // BR-G6-02 residue. Asked before the composer questions: a file on the input that this
    // request did not place is the more specific fact, and it is the one that decides whether a
    // submission may continue at all.
    const attachments = attachmentRefusal(composerOwnership);
    if (attachments) {
      return attachments;
    }
    if (!element?.isConnected) {
      return "Claude composer changed before submission";
    }
    let currentComposer: HTMLElement | undefined;
    try { currentComposer = composer(); } catch { currentComposer = healedControls()?.composer; }
    if (currentComposer !== element) {
      return "Claude composer changed before submission";
    }
    const composerText = readComposer(element);
    if (expectedComposerText === undefined ? composerText.trim().length > 0 : composerText !== expectedComposerText) {
      return "Claude composer changed the prompt text";
    }
    return undefined;
  };
  const assertPreSubmitState = async (expectedComposerText?: string, button?: HTMLElement): Promise<void> => {
    if (cancelledRequests.has(request.requestId) || activeRequest?.requestId !== request.requestId) {
      throw new Error("Claude request was interrupted before submission");
    }
    if (Date.now() >= request.deadlineAt) {
      cancelledRequests.add(request.requestId);
      throw new Error("Claude request deadline expired before submission");
    }
    await ensureConversationBinding(request);
    // BR-G6-02 residue. One implementation of the pre-submission state, asked here after the
    // binder and asked synchronously immediately before the native `files` setter. Two copies of
    // it would be two chances for them to disagree about what a safe composer is.
    const refusal = preSubmitRefusal(expectedComposerText);
    if (refusal) throw new Error(refusal);
    if (button) {
      if (!button.isConnected || controlDisabled(button)) throw new Error("Claude send button changed before submission");
      let currentSend: HTMLElement | undefined;
      try { currentSend = sendButton(); } catch { currentSend = healedControls()?.sendButton; }
      if (currentSend !== button) throw new Error("Claude send button changed before submission");
    }
  };

  try {
    element = await resolveComposer(request.deadlineAt);
    if (!element) return await failBeforeSubmission("Claude composer is unavailable");
    // BR-G6-02, reopened. A document blocked by an unverified cleanup says so first. Its
    // composer still holds whatever the cleanup refused to take back out, so the state check
    // would otherwise report that as a changed prompt and hide the reason reuse is refused.
    if (composerBlockedReason) return await failBeforeSubmission(composerBlockedReason);
    await assertPreSubmitState();
    const conflict = composerConflict(element);
    if (conflict) return await failBeforeSubmission(conflict);

    // BR-G6-02 residue. A reading, not a claim: input discovery, payload construction, setter
    // discovery and the last refusal all still lie ahead, and a claim standing across them would
    // make an untouched composer look like staging that never finished.
    captureAttachmentBaseline(element, composerOwnership, request.attachments.length);
    await attachImages({
      attachments: request.attachments,
      requestId: request.requestId,
      requestDeadlineAt: request.deadlineAt,
      // The claim begins where the write does, with nothing awaited in between.
      onBeforeWrite: () => commitAttachmentOwnership(composerOwnership),
      onStaged: (files) => recordStagedFiles(composerOwnership, files),
      refuseBeforeWrite: (input) =>
        preSubmitRefusal() ??
          (element ? stagingWriteRefusal(element, input, composerOwnership) : "Claude composer is unavailable"),
      refuseAfterAwait: () => preSubmitRefusal(undefined, foreignAttachmentRefusal),
    });
    await assertPreSubmitState();

    const previousAssistants = new Set(currentMessages(assistantSelector));
    const previousUsers = new Set(currentMessages(userSelector));
    lifecycle = startLifecycleObserver({ stopButton });
    recordInsertedText(composerOwnership, request.text);
    writeComposer(element, request.text);
    await delay(50);
    await assertPreSubmitState(request.text);

    const remainingMs = request.deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("Claude request deadline expired before submission");
    const button = await waitForEnabledSendButton(Math.min(10_000, remainingMs), request.deadlineAt, request.requestId);
    if (!button) throw new Error("Claude send button is unavailable");

    await assertPreSubmitState(request.text, button);
    request.submissionCommitted = true;
    button.click();
    const submittedUser = await waitForSubmittedPrompt(request, previousUsers);
    void captureResponse(request, previousAssistants, submittedUser, lifecycle);
    lifecycle = undefined;
    return { submitted: true };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (!request.submissionCommitted) return await failBeforeSubmission(error);
    lifecycle?.observer.disconnect();
    if (await interruptAndConfirm(request.requestId, true)) {
      clearConversationQuarantine("claude", request.conversationIdentity);
      activeRequest = undefined;
      cancelledRequests.delete(request.requestId);
      return { submitted: false, error };
    }
    quarantineConversation("claude", request.conversationIdentity);
    cancelledRequests.add(request.requestId);
    void monitorIndeterminateRequest(request);
    return {
      submitted: false,
      error: "Claude may still be generating because submission could not be verified or interrupted. Stop it manually before continuing.",
    };
  }
};

// BB-4. Installing the document — the navigation notice, the message listener, the first
// registration and the periodic re-registration — is the shared wiring in `providerLogic.ts`.
installProviderDocument({
  activeRequest: () => activeRequest,
  ensureRegisteredUrl: (verify) => ensureRegisteredUrl(verify),
  registerDocument,
  providerStatus,
  submit: (message) => submit(message as SendMessage),
  interrupt: (message) => interrupt(message as InterruptMessage),
  assetSources,
  publicAssetMetadata: toPublicMetadata,
  fetchAsset: (message) => {
    void fetchAsset(message as AssetFetchMessage);
  },
  cancelAsset: (message) => cancelAsset(message as AssetCancelMessage),
});
}

})();
