(() => {
const bachataChatGptLogic = (globalThis as BachataChatGptGlobal).__pairChatGptLogic;
const bachataAssetLogic = (globalThis as BachataAssetGlobal).__pairAssetLogic;
const bachataProviderControls = (
  globalThis as BachataProviderControlsGlobal
).__pairProviderControls;
const bachataDomHealing = (globalThis as BachataDomHealingGlobal).__pairDomHealing;
if (!bachataChatGptLogic || !bachataAssetLogic || !bachataProviderControls || !bachataDomHealing) {
  throw new Error("Bachata ChatGPT logic was not initialized");
}

const {
  canonicalConversationUrl,
  canonicalizeRenderedPrompt,
  composeCapturedResponse,
  conversationIdentityFor,
  chatGptAlertCandidates,
  chatGptAlertErrorCode,
  chatGptAlertSnapshot,
  chatGptCompletionActionVisible,
  chatGptObservationFaultVerdict,
  chatGptTurnRootSelectors,
  completionSettled,
  classifyChatGptAlert,
  createAssetTransferDriver,
  captureResponseParts,
  createInterruptControl,
  createInterruptHandler,
  createProviderStatusReader,
  createCancellationRegistry,
  createComposerGuard,
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
  createRegistrationCoordinator,
  isBusyState,
  completionOutcome,
  uniqueItem,
} = bachataChatGptLogic;

const {
  discoverLinkedAssets,
  serializedByteLength,
  toPublicMetadata,
  transferAsset,
} = bachataAssetLogic;

const {
  waitForResolvedControl,
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
  provider: "chatgpt";
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
  "#prompt-textarea",
  "textarea[data-testid='prompt-textarea']",
  "div[contenteditable='true'][data-testid='prompt-textarea']",
];
const sendSelectors = ["button[data-testid='send-button']"];
const stopSelectors = ["button[data-testid='stop-button']"];
const assistantSelector = "[data-message-author-role='assistant']";
const userSelector = "[data-message-author-role='user']";
const documentToken = crypto.randomUUID();
const maximumResponseBytes = 52_428_800;
const requiredQuietMs = 2_500;
// The named stopped-without-action grace: Stop is gone, the candidate has held still, and ChatGPT
// has still not rendered its own end-of-turn control. Its clock starts only once all three hold,
// so no part of generation or of ordinary idle settling is spent against it, and it is shorter
// than any turn deadline. Expiry is a DOM-drift error, not a completion, because quiet time is
// not evidence a turn ended.
const stoppedWithoutActionGraceMs = 2_000;
// Gate / L1. The response-scoped terminal control has not been observed on an authenticated
// ChatGPT page by this project, and an upstream selector is not that evidence. Until L1 is
// recorded this adapter supplies no completion-action evidence, so the shared lifecycle rule
// decides exactly as it did before. Flipping this on without L1 would redefine C1 silently.
const chatGptTerminalControlProven = false;
// Consecutive reader faults tolerated inside one turn's observation step. The turn is already
// accepted by ChatGPT when this loop runs, and no failure here may resend it.
const maximumObservationFaults = 8;
// How long a refusal is given to render before an upload that never staged is called a failure.
const attachmentRefusalSettleMs = 1_500;
const busyObservationTimeoutMs = 15_000;
const cancelledRequests = createCancellationRegistry({
  isActive: (requestId) => activeRequest?.requestId === requestId,
});
const globalKey = "__pairBrowserBridgeChatGptV6";
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
  bachataDomHealing.cached("chatgpt");

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

const sendButton = (): HTMLElement | undefined => {
  try {
    return queryUnique<HTMLButtonElement>(sendSelectors) ?? healedControls()?.sendButton;
  } catch (cause) {
    const healed = healedControls()?.sendButton;
    if (healed) return healed;
    throw cause;
  }
};

const stopButton = (): HTMLElement | undefined => {
  try {
    return queryUnique<HTMLButtonElement>(stopSelectors) ?? healedControls()?.stopButton;
  } catch (cause) {
    const healed = healedControls()?.stopButton;
    if (healed) return healed;
    throw cause;
  }
};

const healDom = async (force = false, deadlineAt?: number): Promise<boolean> => {
  try {
    return await bachataDomHealing.heal("chatgpt", force, deadlineAt);
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
      throw new Error("ChatGPT composer value setter is unavailable");
    }
    setter.call(element, text);
  } else {
    element.replaceChildren(document.createTextNode(text));
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

// Provider alerts are read only from roots this adapter already owns: the response it bound,
// the composer's own form, and modal dialogs. A `[role="alert"]` anywhere else on the page is
// left alone, so a cookie banner or an unrelated toast can never end a turn.
const dialogAlertElements = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));

const composerAlertRoot = (): HTMLElement | undefined => {
  try {
    const element = composer();
    return element?.closest("form") ?? undefined;
  } catch {
    return undefined;
  }
};

type AlertSourceOptions = {
  attachmentsStaged?: boolean;
  ignoreElements?: ReadonlyMap<BachataChatGptAlertElement, string>;
};

// The half of visibility only the live document knows: computed style, and any hidden ancestor
// between the element and the root. An alert nobody can read is not a refusal anybody was given,
// and a control nobody can see is not evidence the provider finished its turn.
const elementIsVisible = (element: BachataChatGptAlertElement): boolean => {
  if (!(element instanceof HTMLElement)) return true;
  if (!element.isConnected) return false;
  if (element.closest('[hidden], [aria-hidden="true"]') !== null) return false;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
  }
  return true;
};

// One observer over the composer form, stamping a revision on any alert region it sees touched.
// A live region that clears and then says the same thing again has been touched twice, so its
// token differs from the one remembered before the action even though node and wording match.
const alertRevisions = new WeakMap<Node, number>();
let alertRevisionObserver: MutationObserver | undefined;
let observedAlertRoot: HTMLElement | undefined;

const bumpAlertRevision = (node: Node, root: HTMLElement): void => {
  for (
    let current: Node | null = node;
    current && current !== root.parentNode;
    current = current.parentNode
  ) {
    alertRevisions.set(current, (alertRevisions.get(current) ?? 0) + 1);
  }
};

const applyAlertMutations = (records: MutationRecord[], root: HTMLElement): void => {
  for (const record of records) {
    bumpAlertRevision(record.target, root);
    record.addedNodes.forEach((node) => bumpAlertRevision(node, root));
  }
};

const observeAlertRevisions = (root: HTMLElement | undefined): void => {
  if (!root || observedAlertRoot === root) return;
  alertRevisionObserver?.disconnect();
  observedAlertRoot = root;
  alertRevisionObserver = new MutationObserver((records) => applyAlertMutations(records, root));
  alertRevisionObserver.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
};

// Observer callbacks are delivered at the end of a microtask checkpoint, but an upload can be
// refused and re-rendered synchronously inside the event handler that took the files. Reading the
// pending records here is what makes the revision current at the moment of the decision rather
// than one turn late.
const drainAlertMutations = (): void => {
  if (!alertRevisionObserver || !observedAlertRoot) return;
  applyAlertMutations(alertRevisionObserver.takeRecords(), observedAlertRoot);
};

const alertToken = (element: BachataChatGptAlertElement, text: string): string =>
  `${String(alertRevisions.get(element as unknown as Node) ?? 0)}\u0000${text}`;

const alertSources = (responseRoot?: HTMLElement, options?: AlertSourceOptions) => {
  const composerForm = composerAlertRoot();
  const attachmentsStaged = options?.attachmentsStaged
    ?? (attachmentInput()?.files?.length ?? 0) > 0;
  observeAlertRevisions(composerForm);
  drainAlertMutations();
  return {
    ...(responseRoot ? { responseRoot } : {}),
    ...(composerForm ? { composerForm } : {}),
    dialogs: dialogAlertElements(),
    attachmentsStaged,
    isVisible: elementIsVisible,
    alertToken,
    ...(options?.ignoreElements ? { ignoreElements: options.ignoreElements } : {}),
  };
};

// Each alert node on screen right now, with the words it is showing. Both halves matter: a node
// that is replaced is new, and a live region that rewrites itself in place is new as well.
const alertsNow = (
  options?: AlertSourceOptions,
): ReadonlyMap<BachataChatGptAlertElement, string> =>
  chatGptAlertSnapshot(alertSources(undefined, options));

const providerAlert = (
  responseRoot?: HTMLElement,
  options?: AlertSourceOptions,
): BachataChatGptAlert | undefined =>
  classifyChatGptAlert(chatGptAlertCandidates(alertSources(responseRoot, options)));

// The wire code travels beside the error rather than inside its text, so the controller reads a
// stable machine code and a human reads the provider's own words.
const alertWireCodes = new WeakMap<Error, string>();

const codedError = (code: string, message: string): Error => {
  const error = new Error(message);
  alertWireCodes.set(error, code);
  return error;
};

const providerAlertError = (alert: BachataChatGptAlert): Error =>
  codedError(chatGptAlertErrorCode(alert.code), alert.message);

const alertWireCode = (cause: unknown): string | undefined =>
  cause instanceof Error ? alertWireCodes.get(cause) : undefined;

const attachmentButtonSelectors = [
  "button[data-testid='composer-button-file-upload']",
  "button[aria-label*='Attach' i]",
  "button[aria-label*='Upload' i]",
].map(String);
const trustedDetachedAttachmentButtonSelectors = [
  "button[data-testid='composer-button-file-upload']",
].map(String);

// BB-4. Which control opens the picker, and whether a detached input may be trusted, are this
// provider's data; what the page then introduces is judged by the shared implementation.
const { attachmentInput, openAttachmentInput } = createAttachmentStaging({
  controls: bachataProviderControls,
  attachmentRoot: () => composer()?.closest("form") ?? undefined,
  page: () => document,
  associatedSelectors: attachmentButtonSelectors,
  trustedDetachedSelectors: trustedDetachedAttachmentButtonSelectors,
  delay,
  cancelled: (requestId) => cancelledRequests.has(requestId),
});

// BB-4. The composer conflict check, its cleanup, the pre-submission refusal and the
// attachment-staging helpers they use are the shared implementation in `providerLogic.ts`; only
// this provider's composer access and its own blocked-composer record are supplied here. The
// wording the user sees is unchanged: the provider's name comes from the configured label.
const {
  attachmentRemovalControls,
  captureAttachmentBaseline,
  commitAttachmentOwnership,
  recordStagedFiles,
  recordInsertedText,
  stagingWriteRefusal,
  foreignAttachmentRefusal,
  stagedAttachmentRefusal,
  composerConflict,
  rejectBeforeSubmission,
} = createComposerGuard<HTMLTextAreaElement | HTMLElement>({
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
  if (requestId && cancelledRequests.has(requestId)) throw new Error("ChatGPT request was interrupted before attachments were staged");
  if (requestDeadlineAt !== undefined && Date.now() >= requestDeadlineAt) throw new Error("ChatGPT request deadline expired before attachments were staged");
  const input = await openAttachmentInput(requestId, requestDeadlineAt);
  if (!input) {
    if (requestId && cancelledRequests.has(requestId)) throw new Error("ChatGPT request was interrupted before attachments were staged");
    if (requestDeadlineAt !== undefined && Date.now() >= requestDeadlineAt) throw new Error("ChatGPT request deadline expired before attachments were staged");
    throw new Error("ChatGPT image attachment input is unavailable");
  }
  if (requestId && cancelledRequests.has(requestId)) throw new Error("ChatGPT request was interrupted before attachments were staged");
  // Alerts already on screen belong to whatever happened before this upload. Node and wording
  // together: a replaced node is new, and a live region that rewrites itself in place is new too.
  const priorAlerts = alertsNow({ attachmentsStaged: true });
  writeStagedAttachments({
    input,
    files: attachments.map((attachment) => attachmentFile(attachment)),
    refuseBeforeWrite,
    onBeforeWrite,
    onStaged,
  });

  // ChatGPT accepts or refuses an upload asynchronously: the setter can succeed and the refusal
  // arrive a render later, which a single immediate check and a blind 100 ms wait both miss.
  // Two exits only: the provider's own proof that the upload reached the composer, or the whole
  // refusal window elapsing. There is no measured "a refusal always renders within N ms" for
  // ChatGPT, so shortening the wait for a retained `input.files` would be a guess about the
  // provider dressed as a fast path. Retained files are not acceptance.
  const refusalDeadline = Math.min(
    Date.now() + attachmentRefusalSettleMs,
    requestDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  let staged = false;
  for (;;) {
    if (requestId && cancelledRequests.has(requestId)) {
      throw new Error("ChatGPT request was interrupted before attachments were staged");
    }
    const alert = providerAlert(undefined, {
      attachmentsStaged: true,
      ignoreElements: priorAlerts,
    });
    if (alert) throw providerAlertError(alert);
    // BR-G6-02 residue. The provider's own words come first: an upload it refuses is a refusal
    // it should explain. What may not wait is a file the person added, because the settle loop
    // is the window in which one can arrive.
    const foreign = refuseAfterAwait?.();
    if (foreign) {
      throw new Error(foreign);
    }
    staged = input.files?.length === attachments.length;
    // Draining again before the early exit: an attachment control can appear in the same
    // synchronous turn as the refusal that follows it, and accepting on the control alone would
    // leave that refusal unread.
    drainAlertMutations();
    if (staged
      && attachmentRemovalControls(input).length > 0
      && !providerAlert(undefined, { attachmentsStaged: true, ignoreElements: priorAlerts })) {
      return;
    }
    if (Date.now() >= refusalDeadline) break;
    await delay(50);
  }
  if (!staged) throw new Error("ChatGPT did not accept the image attachments");
  // Files present, whole window elapsed, nothing raised. Not every composer renders an attachment
  // control, so its absence cannot be read as refusal either.
};

const currentUrl = (): string => canonicalConversationUrl(location.href);
const currentIdentity = (): string => conversationIdentityFor(currentUrl());

const assetTransferDriver = createAssetTransferDriver({
  documentToken,
  unavailableMessage: "The ChatGPT asset is no longer available in this document",
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
  provider: "chatgpt",
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
      provider: "chatgpt",
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
  const healed = bachataDomHealing.messageElements("chatgpt").filter((candidate) =>
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
  provider: "chatgpt",
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
      throw new Error("The submitted ChatGPT message identifier became ambiguous");
    }
    const match = matches[0];
    if (!match) throw new Error("The submitted ChatGPT message disappeared");
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
    throw new Error("The submitted ChatGPT message became ambiguous");
  }
  const match = matches[0];
  if (!match) throw new Error("The submitted ChatGPT message disappeared");
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
      throw new Error("The bound ChatGPT response identifier became ambiguous");
    }
    const match = matches[0];
    if (!match) throw new Error("The bound ChatGPT response disappeared");
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

  return rebindResponse(
    binding,
    newAssistantsAfterUser(binding.previousAssistants, binding.submittedUser),
  );
};

// What the adapter treats as "the same candidate answer". Serialized content cannot answer this:
// a replacement node can carry the same markup, and a same-length edit far into a long answer can
// leave any bounded digest unchanged. Node identity can. The response itself, the turn holding it
// and its parent are compared by identity, and a mutation revision counted from the turn's own
// observer covers every change inside it. Rebind, reparent and virtualization all change one of
// the three; a rerender in place changes the revision.
type ResponseObservation = {
  response: HTMLElement;
  text: string;
  terminalAlert: BachataChatGptAlert | undefined;
  stopVisible: boolean;
  turnRoot?: HTMLElement;
  completionActionVisible?: boolean;
};

type ResponseCandidate = {
  response: HTMLElement;
  turnRoot: HTMLElement;
  parent: Node | null;
  revision: number;
};

const turnRootOf = (response: HTMLElement): HTMLElement =>
  chatGptTurnRootSelectors
    .map((selector) => response.closest<HTMLElement>(selector))
    .find((element): element is HTMLElement => element !== null)
  ?? response;

const sameCandidate = (
  previous: ResponseCandidate | undefined,
  current: ResponseCandidate,
): boolean =>
  previous !== undefined &&
  previous.response === current.response &&
  previous.turnRoot === current.turnRoot &&
  previous.parent === current.parent &&
  previous.revision === current.revision;

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
  // All completion-evidence state exists only while the terminal control is proven. With the gate
  // off the loop never observes the turn and never reads the response beyond the text it already
  // streams, so the disabled path costs nothing and can fail nowhere new.
  let candidate: ResponseCandidate | undefined;
  let candidateStableSince = Date.now();
  let candidateRevision = 0;
  let candidateObserver: MutationObserver | undefined;
  let candidateObservedRoot: HTMLElement | undefined;
  let missingActionSince: number | undefined;
  let observationFaults = 0;
  let lastResolvedResponse: HTMLElement | undefined;

  const bindCandidateObserver = (root: HTMLElement): void => {
    if (candidateObservedRoot === root) return;
    candidateObserver?.disconnect();
    candidateObservedRoot = root;
    candidateObserver = new MutationObserver(() => {
      candidateRevision += 1;
    });
    candidateObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  };
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

    // Resolution commits: it may rebind `binding` to a replacement node and remember that node's
    // provider id. A replacement is a fresh reading, so the budget is cleared here, the moment the
    // new node is known, rather than after the reads that follow it. Otherwise the first fault on
    // a replacement would be counted against the faults of the node it replaced.
    const resolveObservedResponse = (): HTMLElement => {
      const response = resolveBoundResponse(binding);
      if (response !== lastResolvedResponse) {
        lastResolvedResponse = response;
        observationFaults = 0;
      }
      return response;
    };

    // One look at the page, and the only region the fault budget covers: a fault here is this
    // adapter misreading the document rather than the provider saying something.
    //
    // It is read-only in what it decides, not in every byte it touches. Resolution rebinds as
    // described above; reading alerts re-selects the composer's attachment input, binds the alert
    // observer to the composer form when it is not already bound, and drains that observer's
    // pending records into the revision map. All three are idempotent under retry: each re-derives
    // from the live DOM, the observer binding is a no-op once bound, and drained revisions are
    // stamped per node rather than consumed, so a fault after any of them loses nothing and
    // repeating them changes nothing.
    const readResponse = (response: HTMLElement): ResponseObservation => {
      return {
        response,
        text: response.innerText,
        terminalAlert: providerAlert(response),
        stopVisible: Boolean(stopButton()),
        ...(chatGptTerminalControlProven
          ? {
              turnRoot: turnRootOf(response),
              completionActionVisible: chatGptCompletionActionVisible({
                response,
                isVisible: elementIsVisible,
              }),
            }
          : {}),
      };
    };

    while (Date.now() < deadline) {
      if (cancelledRequests.has(request.requestId)) {
        return;
      }
      await ensureConversationBinding(request);

      let observation: ResponseObservation;
      try {
        observation = readResponse(resolveObservedResponse());
      } catch (cause) {
        // Resolution can commit a replacement and then fault before returning it, so the fault
        // would otherwise land on the budget of the node that was replaced. The binding is the
        // authority on which node this turn now reads: if it moved, this is a rebind, whether or
        // not the observation that moved it ever finished.
        if (binding.element !== lastResolvedResponse) {
          lastResolvedResponse = binding.element;
          observationFaults = 0;
        }
        const consecutiveFaults = observationFaults + 1;
        if (
          chatGptObservationFaultVerdict({
            isTypeError: cause instanceof TypeError,
            consecutiveFaults,
            maximumFaults: maximumObservationFaults,
          }) === "rethrow"
        ) {
          throw cause;
        }
        observationFaults = consecutiveFaults;
        await delay(100);
        continue;
      }
      // A complete look clears the budget as well; a rebind has already cleared it above.
      observationFaults = 0;

      const response = observation.response;
      const text = observation.text;
      responseActivity.bind(response);
      if (text !== lastText) {
        await sendStream(request, lastText, text);
        lastText = text;
        responseActivity.touch();
      }

      // A provider alert bound to this exact response is terminal evidence: waiting out the
      // deadline after ChatGPT has said the turn failed only delays the same failure, and loses
      // the provider's own words on the way.
      const terminalAlert = observation.terminalAlert;
      if (terminalAlert && terminalAlert.scope !== "attachment") {
        throw providerAlertError(terminalAlert);
      }

      const currentlyBusy = isBusyState(observation.stopVisible);
      if (currentlyBusy) {
        lifecycle.busyObserved = true;
        idleSince = undefined;
      } else if (lifecycle.busyObserved) {
        idleSince ??= Date.now();
      }
      if (!lifecycle.busyObserved && Date.now() >= busyDeadline) {
        throw new Error(
          "ChatGPT response appeared without an observable generation lifecycle",
        );
      }

      const lifecycleState = {
        busyObserved: lifecycle.busyObserved,
        currentlyBusy,
        responseText: text,
        quietForMs: Date.now() - responseActivity.lastMutationAt(),
        requiredQuietMs,
        idleForMs: idleSince === undefined ? 0 : Date.now() - idleSince,
        requiredIdleMs: requiredQuietMs,
      };

      let completionEvidence = {};
      if (chatGptTerminalControlProven && observation.turnRoot !== undefined) {
        const turnRoot = observation.turnRoot;
        bindCandidateObserver(turnRoot);
        const current: ResponseCandidate = {
          response,
          turnRoot,
          parent: response.parentNode,
          revision: candidateRevision,
        };
        if (!sameCandidate(candidate, current)) {
          candidate = current;
          candidateStableSince = Date.now();
        }
        const candidateStable = Date.now() - candidateStableSince >= requiredQuietMs;
        const completionActionVisible = observation.completionActionVisible === true;
        // The grace has its own clock, started only once a settled and stable candidate is found
        // to have no control. Generation time and ordinary idle settling are never spent against
        // it, and anything that moves the candidate again puts it back to nothing.
        if (completionSettled(lifecycleState) && candidateStable && !completionActionVisible) {
          missingActionSince ??= Date.now();
        } else {
          missingActionSince = undefined;
        }
        completionEvidence = {
          completionActionVisible,
          candidateStable,
          actionMissingForMs:
            missingActionSince === undefined ? 0 : Date.now() - missingActionSince,
          actionGraceMs: stoppedWithoutActionGraceMs,
        };
      }

      const outcome = completionOutcome({ ...lifecycleState, ...completionEvidence });

      if (outcome === "domDrift") {
        throw codedError(
          "PROVIDER_COMPLETION_UNPROVEN",
          "ChatGPT stopped generating on a stable answer without rendering its own end-of-turn control, so this turn's completion could not be proven.",
        );
      }

      if (outcome === "complete") {
        const finalResponse = resolveBoundResponse(binding);
        const captured = composeCapturedResponse(
          captureResponseParts(finalResponse),
        );
        const sources = discoverLinkedAssets(
          "chatgpt",
          finalResponse,
          documentToken,
        );
        rememberAssetSources(sources);
        const message = {
          type: "content.response",
          documentToken,
          response: {
            requestId: request.requestId,
            agentId: request.agentId,
            sessionId: request.sessionId,
            provider: "chatgpt",
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
          throw new Error("ChatGPT captured response exceeds the transport limit");
        }
        clearConversationQuarantine("chatgpt", request.conversationIdentity);
        await sendBackground(message);
        return;
      }
      await delay(100);
    }
    throw new Error("Timed out waiting for ChatGPT response completion");
  } catch (cause) {
    if (!cancelledRequests.has(request.requestId)) {
      quarantineConversation("chatgpt", request.conversationIdentity);
      await sendBackground({
        type: "content.error",
        documentToken,
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        code: alertWireCode(cause) ?? "RESPONSE_CAPTURE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
      }).catch(() => undefined);
    }
  } finally {
    responseActivity.disconnect();
    candidateObserver?.disconnect();
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
  quarantine: (conversationIdentity) => quarantineConversation("chatgpt", conversationIdentity),
  clearQuarantine: (conversationIdentity) =>
    clearConversationQuarantine("chatgpt", conversationIdentity),
  settle: forgetRequest,
  forget: (requestId) => {
    cancelledRequests.delete(requestId);
  },
});

// BB-4. Stopping a turn, and the commitment boundary that decides whether a stop may be
// reported, are the shared implementation in `providerLogic.ts`.
const interrupt = createInterruptHandler({
  provider: "chatgpt",
  documentToken,
  currentUrl,
  currentIdentity,
  activeRequest: () => activeRequest,
  rememberPreSubmit: (requestId) => cancelledRequests.rememberPreSubmit(requestId),
  cancelHealing: () => bachataDomHealing.cancel("chatgpt"),
  ensureConversationBinding,
  interruptAndConfirm: (requestId) => interruptAndConfirm(requestId),
  quarantine: (conversationIdentity) =>
    quarantineConversation("chatgpt", conversationIdentity),
  clearQuarantine: (conversationIdentity) =>
    clearConversationQuarantine("chatgpt", conversationIdentity),
});

const submit = async (
  incoming: SendMessage,
): Promise<{ submitted: boolean; error?: string; code?: string }> => {
  ensureRegisteredUrl();
  const request: ActiveSendMessage = {
    ...incoming,
    conversationUrl: canonicalConversationUrl(incoming.conversationUrl),
    authorizedConversationIdentity: incoming.conversationIdentity,
    transitionUsed: false,
    submissionCommitted: false,
  };
  if (
    request.provider !== "chatgpt" ||
    request.documentToken !== documentToken ||
    request.frameId !== 0 ||
    request.conversationUrl !== currentUrl() ||
    request.conversationIdentity !== currentIdentity()
  ) {
    return {
      submitted: false,
      error: "The selected ChatGPT document no longer matches the request",
    };
  }
  if (cancelledRequests.has(request.requestId)) {
    cancelledRequests.delete(request.requestId);
    return { submitted: false, error: "ChatGPT request was interrupted before submission" };
  }
  if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= Date.now()) {
    return { submitted: false, error: "ChatGPT request deadline expired before submission" };
  }
  if (activeRequest) {
    return { submitted: false, error: "A ChatGPT response is already active" };
  }
  // An authority that cannot answer blocks the send exactly like a held verdict, but says so in
  // its own words: one is a conversation to abandon, the other is a condition that passes.
  const quarantineState = await conversationQuarantineState("chatgpt", request.conversationIdentity);
  if (quarantineState !== "clear") {
    return {
      submitted: false,
      error: quarantineState === "quarantined"
        ? "This ChatGPT conversation is quarantined because provider idle state could not be confirmed. Open a fresh conversation before continuing."
        : "The conversation quarantine authority is unavailable, so this ChatGPT conversation cannot be proven safe to reuse. Retry once the extension background is reachable.",
    };
  }

  // BB-AUD-10. `stopButton()` throws only when the page shows more than one stop control and
  // no healed binding resolves it. Ambiguity is not proof of an idle conversation, and this
  // guard exists to refuse exactly the case it cannot rule out, so it refuses rather than
  // sending into a turn that may still be running.
  try {
    if (stopButton()) {
      return { submitted: false, error: "A ChatGPT response is already active" };
    }
  } catch {
    return {
      submitted: false,
      error: "The ChatGPT page offers more than one matching control, so an active response cannot be ruled out. Reload the conversation, then retry.",
    };
  }

  // An account-level refusal is visible before the composer matters: sending into it would only
  // produce a turn that cannot start.
  const blockingAlert = providerAlert();
  if (blockingAlert && blockingAlert.scope === "dialog") {
    return {
      submitted: false,
      error: blockingAlert.message,
      code: chatGptAlertErrorCode(blockingAlert.code),
    };
  }

  activeRequest = request;
  let element: HTMLTextAreaElement | HTMLInputElement | HTMLElement | undefined;
  // BR-G6-02. What this request has put into the composer, so a refusal removes its own
  // insertion and never a draft or an attachment the person left there.
  const composerOwnership: ComposerOwnership = {};
  let lifecycle: LifecycleObserver | undefined;
  const failBeforeSubmission = async (
    error: string,
    code?: string,
  ): Promise<{ submitted: boolean; error?: string; code?: string }> => {
    lifecycle?.observer.disconnect();
    const result = element
      ? await rejectBeforeSubmission(element, error, composerOwnership)
      : { submitted: false as const, error };
    forgetRequest(request.requestId);
    return code === undefined ? result : { ...result, code };
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
      return "ChatGPT request was interrupted before submission";
    }
    if (Date.now() >= request.deadlineAt) {
      return "ChatGPT request deadline expired before submission";
    }
    if (
      request.documentToken !== documentToken ||
      request.frameId !== 0 ||
      request.conversationUrl !== currentUrl() ||
      request.conversationIdentity !== currentIdentity()
    ) {
      return "The ChatGPT conversation changed during the active request";
    }
    // BR-G6-02 residue. Asked before the composer questions: a file on the input that this
    // request did not place is the more specific fact, and it is the one that decides whether a
    // submission may continue at all.
    const attachments = attachmentRefusal(composerOwnership);
    if (attachments) {
      return attachments;
    }
    if (!element?.isConnected) {
      return "ChatGPT composer changed before submission";
    }
    let currentComposer: HTMLElement | undefined;
    try { currentComposer = composer(); } catch { currentComposer = healedControls()?.composer; }
    if (currentComposer !== element) {
      return "ChatGPT composer changed before submission";
    }
    const composerText = readComposer(element);
    if (expectedComposerText === undefined ? composerText.trim().length > 0 : composerText !== expectedComposerText) {
      return "ChatGPT composer changed the prompt text";
    }
    return undefined;
  };
  const assertPreSubmitState = async (expectedComposerText?: string, button?: HTMLElement): Promise<void> => {
    if (cancelledRequests.has(request.requestId) || activeRequest?.requestId !== request.requestId) {
      throw new Error("ChatGPT request was interrupted before submission");
    }
    if (Date.now() >= request.deadlineAt) {
      cancelledRequests.add(request.requestId);
      throw new Error("ChatGPT request deadline expired before submission");
    }
    await ensureConversationBinding(request);
    // BR-G6-02 residue. One implementation of the pre-submission state, asked here after the
    // binder and asked synchronously immediately before the native `files` setter. Two copies of
    // it would be two chances for them to disagree about what a safe composer is.
    const refusal = preSubmitRefusal(expectedComposerText);
    if (refusal) throw new Error(refusal);
    if (button) {
      if (!button.isConnected || controlDisabled(button)) throw new Error("ChatGPT send button changed before submission");
      let currentSend: HTMLElement | undefined;
      try { currentSend = sendButton(); } catch { currentSend = healedControls()?.sendButton; }
      if (currentSend !== button) throw new Error("ChatGPT send button changed before submission");
    }
  };

  try {
    element = await resolveComposer(request.deadlineAt);
    if (!element) return await failBeforeSubmission("ChatGPT composer is unavailable");
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
          (element ? stagingWriteRefusal(element, input, composerOwnership) : "ChatGPT composer is unavailable"),
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
    if (remainingMs <= 0) throw new Error("ChatGPT request deadline expired before submission");
    const button = await waitForEnabledSendButton(Math.min(10_000, remainingMs), request.deadlineAt, request.requestId);
    if (!button) throw new Error("ChatGPT send button is unavailable");

    await assertPreSubmitState(request.text, button);
    request.submissionCommitted = true;
    button.click();
    const submittedUser = await waitForSubmittedPrompt(request, previousUsers);
    void captureResponse(request, previousAssistants, submittedUser, lifecycle);
    lifecycle = undefined;
    return { submitted: true };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const code = alertWireCode(cause);
    if (!request.submissionCommitted) return await failBeforeSubmission(error, code);
    lifecycle?.observer.disconnect();
    if (await interruptAndConfirm(request.requestId, true)) {
      clearConversationQuarantine("chatgpt", request.conversationIdentity);
      activeRequest = undefined;
      cancelledRequests.delete(request.requestId);
      return code === undefined ? { submitted: false, error } : { submitted: false, error, code };
    }
    quarantineConversation("chatgpt", request.conversationIdentity);
    cancelledRequests.add(request.requestId);
    void monitorIndeterminateRequest(request);
    return {
      submitted: false,
      error: "ChatGPT may still be generating because submission could not be verified or interrupted. Stop it manually before continuing.",
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
