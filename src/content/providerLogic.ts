// ChatGPT and Claude ran two copies of this module that differed only in the initial-conversation
// transition rule and the provider name: 283 of 286 lines were identical. One implementation,
// configured per provider, removes the copy without changing either provider's behaviour.
//
// Loaded as a classic script before the provider logic file, in the same globalThis handoff
// style as __pairAssetLogic and __pairProviderControls, because content scripts injected with
// chrome.scripting.executeScript are not modules and cannot import.

type StreamUpdate = {
  mode: "append" | "replace";
  text: string;
};

type CapturedSegment = {
  type: "text" | "codeBlock" | "quote";
  text: string;
  start: number;
  end: number;
  language?: string;
};

type CapturedPart = {
  type: "text" | "codeBlock" | "quote";
  text: string;
  language?: string;
};

type CapturedResponse = {
  text: string;
  segments: CapturedSegment[];
};

type RegistrationCoordinator = {
  register: () => Promise<void>;
  ensure: (verify?: boolean) => Promise<void>;
  registeredUrl: () => string;
};

type BachataRegistrationOptions = {
  currentUrl: () => string;
  registerUrl: (url: string) => Promise<void>;
  now?: () => number;
  verificationIntervalMs?: number;
};

type CancellationRegistry = {
  add: (requestId: string) => void;
  has: (requestId: string) => boolean;
  delete: (requestId: string) => boolean;
  rememberPreSubmit: (requestId: string) => void;
  size: () => number;
};



type AssetTransferHooks = {
  start: (metadata: {
    name: string;
    mimeType?: string | undefined;
    size?: number | undefined;
  }) => Promise<void>;
  chunk: (sequence: number, dataBase64: string) => Promise<void>;
};

type AssetTransferOptions<Source> = {
  documentToken: string;
  unavailableMessage: string;
  assetSources: { get: (assetId: string) => Source | undefined };
  sendBackground: (message: unknown) => Promise<unknown>;
  transferAsset: (
    source: Source,
    maximumBytes: number,
    signal: AbortSignal,
    hooks: AssetTransferHooks,
  ) => Promise<{ size: number; sha256: string }>;
};

type AssetTransferDriver = {
  fetchAsset: (message: {
    transferId: string;
    assetId: string;
    maxBytes: number;
  }) => Promise<void>;
  cancelAsset: (message: { transferId: string; assetId: string }) => boolean;
  activeTransfers: () => number;
};

type ProviderStatusValue = {
  status: string;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
  conversationState: "confirmed" | "uncertain";
};

type ProviderStatusOptions = {
  provider: string;
  documentToken: string;
  currentUrl: () => string;
  conversationIdentityFor: (url: string) => string;
  conversationIsQuarantined: (
    provider: string,
    conversationIdentity: string,
  ) => Promise<boolean>;
  resolveComposer: () => Promise<HTMLElement | undefined> | HTMLElement | undefined;
  /** Whether the page the composer is missing from is the provider's sign-in path. */
  onAuthenticationPath: () => boolean;
  /** Why the composer may not be written to, or nothing. Read, never called into. */
  composerBlockedReason: () => string | undefined;
  generationActive: () => boolean;
  /** Why this composer cannot be used even though it resolved, or nothing. */
  composerConflict: (composer: HTMLElement) => string | undefined;
};

type InterruptControlOptions = {
  /** The provider's Stop control, or nothing while the page shows none. */
  stopButton: () => HTMLElement | undefined;
  /** Whether the provider considers itself generating right now. */
  isBusy: () => boolean;
  /** Try to re-locate the page's controls; the deadline is the caller's, not a new one. */
  heal: (deadlineAt: number) => Promise<boolean>;
  delay: (milliseconds: number) => Promise<void>;
  /**
   * The polling resolver, passed in rather than reached for. It lives in `providerControls.ts`,
   * a separately injected file, and depending on it as an ambient global would make this module
   * work only in the load order a page happens to give it.
   */
  waitForResolvedControl: BachataProviderControls["waitForResolvedControl"];
  now?: (() => number) | undefined;
  rememberCancellation: (requestId: string) => void;
  forgetCancellation: (requestId: string) => void;
  /**
   * BR-G6-05. Whether the document and conversation that authorized this Stop are still the
   * ones in front of us. Resolving a Stop control costs a poll loop and a full DOM heal, and
   * confirming one costs ten seconds of polling; every await in between is a chance for the
   * page to become a different conversation or for the turn to end. A control resolved for one
   * turn must never be clicked, or believed, on behalf of another.
   */
  stillBound: (requestId: string) => boolean;
  /**
   * BB-A4-N01. The lease this interrupt holds over the request while it is stopping it. Without
   * it, recording the cancellation is what ends the request: the capture loop sees the
   * cancellation, returns, and its teardown clears the active request and the cancellation
   * record — so `stillBound` goes false and the interrupt abandons its own confirmation.
   */
  lease?: InterruptLease | undefined;
  /** BB-A4-N01. Retire a request whose teardown the lease deferred. */
  retireRequest?: ((requestId: string) => void) | undefined;
};

/**
 * BB-A4-N01. Which requests are being stopped right now, and which of them owe a teardown that
 * ran while they were.
 *
 * Capture cleanup and request retirement are two different things and were one. A cancelled
 * capture must stop reading the page immediately; the request it belongs to must survive until
 * the native Stop it is waiting on has been confirmed or given up on, because confirming a stop
 * is the thing that needs to know whose turn this still is.
 */
type InterruptLease = {
  hold: (requestId: string) => void;
  held: (requestId: string) => boolean;
  /** Record a teardown that arrived while the lease was held. */
  defer: (requestId: string) => void;
  /** Release the lease, answering whether a deferred teardown is still owed. */
  release: (requestId: string) => boolean;
};

type InterruptControl = {
  confirmStopped: (stillBound?: () => boolean) => Promise<boolean>;
  waitForStopButton: (
    timeoutMs: number,
    stillBound?: () => boolean,
  ) => Promise<HTMLElement | undefined>;
  interruptAndConfirm: (requestId: string, requireStopControl?: boolean) => Promise<boolean>;
};

type BachataCancellationOptions = {
  isActive: (requestId: string) => boolean;
  preSubmitTtlMs?: number;
  schedule?: (callback: () => void, delayMs: number) => void;
};

type ProviderMessage = {
  type: string;
};

type AssetRevealer = (() => void) | undefined;

type ProviderMessageHandlers = {
  ensureRegisteredUrl: () => void;
  providerStatus: () => Promise<unknown>;
  registerDocument: () => Promise<unknown>;
  submit: (message: ProviderMessage) => Promise<unknown>;
  interrupt: (message: ProviderMessage) => Promise<unknown>;
  assetMetadata: (message: ProviderMessage) => unknown;
  assetRevealer: (message: ProviderMessage) => AssetRevealer;
  fetchAsset: (message: ProviderMessage) => void;
  cancelAsset: (message: ProviderMessage) => boolean;
};

type ProviderMessageListener = (
  message: ProviderMessage,
  sender: unknown,
  respond: (value: unknown) => void,
) => boolean;


type BachataProviderLogic = {
  canonicalizeRenderedPrompt: (text: string) => string;
  streamUpdate: (
    previous: string,
    current: string,
  ) => StreamUpdate | undefined;
  singleNewItem: <T>(
    previous: ReadonlySet<T>,
    current: readonly T[],
  ) => T | undefined;
  uniqueItem: <T>(items: readonly T[]) => T | undefined;
  utf8ByteLength: (text: string) => number;
  assertTextWithinLimit: (
    text: string,
    maximumBytes: number,
    label: string,
  ) => void;
  canonicalConversationUrl: (value: string) => string;
  conversationIdentityFor: (value: string) => string;
  sessionIdForConversation: (
    tabId: number,
    documentToken: string,
    conversationIdentity: string,
  ) => string;
  isSupportedInitialTransition: (
    previousUrl: string,
    nextUrl: string,
  ) => boolean;
  composeCapturedResponse: (
    parts: readonly CapturedPart[],
  ) => CapturedResponse;
  isBusyState: (hasStopButton: boolean) => boolean;
  shouldCompleteResponse: (input: CompletionInput) => boolean;
  completionOutcome: (input: CompletionInput) => CompletionOutcome;
  completionSettled: (input: SettledInput) => boolean;
  createComposerGuard: <TElement extends Element>(
    hooks: ComposerGuardHooks<TElement>,
  ) => ComposerGuard<TElement>;
  sendBackground: <T extends BackgroundAck>(message: unknown) => Promise<T>;
  createRegistrationCoordinator: (
    options: BachataRegistrationOptions,
  ) => RegistrationCoordinator;
  createCancellationRegistry: (
    options: BachataCancellationOptions,
  ) => CancellationRegistry;
  createAssetTransferDriver: <Source>(
    options: AssetTransferOptions<Source>,
  ) => AssetTransferDriver;
  createProviderStatusReader: (
    options: ProviderStatusOptions,
  ) => () => Promise<ProviderStatusValue>;
  captureResponseParts: (root: HTMLElement) => CapturedPart[];
  createInterruptControl: (options: InterruptControlOptions) => InterruptControl;
  createProviderMessageListener: (
    handlers: ProviderMessageHandlers,
  ) => ProviderMessageListener;
  startLifecycleObserver: (
    hooks: BachataLifecycleObserverHooks,
  ) => BachataLifecycleObserver;
  createInterruptLease: () => InterruptLease;
  createRequestTeardown: (
    hooks: BachataRequestTeardownHooks,
  ) => (requestId: string) => void;
  createComposerResolver: (
    hooks: BachataComposerResolverHooks,
  ) => BachataComposerResolver;
  createAttachmentStaging: (
    hooks: BachataAttachmentStagingHooks,
  ) => BachataAttachmentStaging;
  attachmentFile: (attachment: {
    dataBase64: string;
    name: string;
    mimeType: string;
    size: number;
  }) => File;
  writeStagedAttachments: (options: {
    input: HTMLInputElement;
    files: readonly File[];
    refuseBeforeWrite?: ((input: HTMLInputElement) => string | undefined) | undefined;
    onBeforeWrite?: (() => void) | undefined;
    onStaged?: ((files: readonly File[]) => void) | undefined;
  }) => readonly File[];
  createResponseBinder: (hooks: BachataResponseBinderHooks) => BachataResponseBinder;
  createConversationBinder: (
    hooks: BachataConversationBinderHooks,
  ) => (request: BachataActiveRequest) => Promise<void>;
  createAssetSourceStore: (
    options: BachataAssetSourceStoreOptions,
  ) => BachataAssetSourceStore;
  installProviderDocument: (hooks: BachataDocumentWiringHooks) => void;
  createResponseActivityObserver: (options?: {
    now?: (() => number) | undefined;
  }) => BachataResponseActivityObserver;
  createSubmittedPromptWaiter: (
    hooks: BachataSubmittedPromptHooks,
  ) => (
    request: BachataActiveRequest & { text: string },
    previousUsers: ReadonlySet<HTMLElement>,
  ) => Promise<BachataSubmittedUserBinding>;
  createStreamSender: (
    hooks: BachataStreamSenderHooks,
  ) => (
    request: BachataActiveRequest,
    previous: string,
    current: string,
  ) => Promise<void>;
  createIndeterminateMonitor: (
    hooks: BachataIndeterminateMonitorHooks,
  ) => (request: { requestId: string; conversationIdentity: string }) => Promise<void>;
  /** Whether a message names the document, frame and conversation this script is bound to. */
  requestMatchesDocument: (input: {
    provider: string;
    documentToken: string;
    frameId: number;
    conversationUrl: string;
    conversationIdentity: string;
    boundProvider: string;
    boundDocumentToken: string;
    boundUrl: string;
    boundIdentity: string;
  }) => boolean;
  createInterruptHandler: (
    hooks: BachataInterruptHandlerHooks,
  ) => (
    request: BachataInterruptRequest,
  ) => Promise<{ interrupted: boolean; error?: string }>;
};

type CompletionOutcome = "wait" | "complete" | "domDrift";

// The lifecycle half: what every provider reports.
type SettledInput = {
  busyObserved: boolean;
  currentlyBusy: boolean;
  responseText: string;
  quietForMs: number;
  requiredQuietMs: number;
  idleForMs: number;
  requiredIdleMs: number;
};

// `completionActionVisible` is absent for a provider whose end-of-turn control has not been proven
// on the live page. `candidateStable` says the response node, its turn, its place in the document
// and its contents have all held still. `actionMissingForMs` is measured by its own clock, which
// starts only once a settled and stable candidate is found to have no control, so no part of
// generation or of ordinary idle settling is ever spent against the grace.
type CompletionInput = SettledInput & {
  completionActionVisible?: boolean;
  candidateStable?: boolean;
  actionMissingForMs?: number;
  actionGraceMs?: number;
};

/**
 * BB-4. The composer guard both providers run before a prompt goes in, and the refusal both run
 * when it cannot.
 *
 * The three functions were identical in `chatgpt.ts` and `claude.ts` but for the provider's name
 * inside three user-facing sentences. The name comes from `config.label`, so the wording each
 * provider shows is unchanged; everything the DOM differs about — how a composer is read and
 * written, where attachments are staged, which controls remove them — stays in the provider file
 * as a hook. No provider policy moves here: the guard refuses, and what a provider does after a
 * refusal is still the provider's own.
 */
type ComposerGuardHooks<TElement extends Element> = {
  readComposer: (element: TElement) => string;
  writeComposer: (element: TElement, text: string) => void;
  /** Where this provider stages files for upload, if it has resolved one. */
  attachmentInput: () => HTMLInputElement | undefined;
  delay: (milliseconds: number) => Promise<void>;
  /** Record the reason this document may no longer be used to send. */
  blockComposer: (reason: string) => void;
  now?: () => number;
  cleanupTimeoutMs?: number;
};

/**
 * BR-G6-02. What this request put into the composer, and therefore everything a refusal is
 * allowed to take back out.
 *
 * A flag saying "this request wrote something" is not ownership. It answers "did Bachata touch
 * the composer", when the only safe question is "is what is in the composer right now still the
 * exact thing Bachata put there". A person who edits the inserted prompt while the request waits
 * for an enabled Send control, or who attaches a file of their own while it stages, leaves a
 * composer that no longer holds Bachata's insertion — and a cleanup driven by the flag deletes
 * their work anyway.
 *
 * So ownership is evidence, not a boolean: the exact text that was written, and the removal
 * controls and the `File` objects that existed before staging began. Cleanup withdraws only what
 * still matches that evidence. Anything else present is the person's, is left alone, and makes
 * the cleanup unverified — which blocks the composer instead of clearing it.
 */
type OwnedAttachments = {
  /** The removal controls already on the composer when this request began staging. */
  before: readonly HTMLButtonElement[];
  /** The files this request itself put on the provider's input. */
  files: readonly File[];
  /** How many attachments this request set out to stage. */
  expected: number;
};

/**
 * BR-G6-02 residue. What the composer carried before this request staged anything, and how many
 * attachments it set out to place.
 *
 * A measurement, never a claim. Nothing here says this request wrote to the document, so a
 * failure while this is the only thing recorded owns nothing, cleans nothing and blocks nothing.
 */
type AttachmentBaseline = {
  before: readonly HTMLButtonElement[];
  expected: number;
};

type ComposerOwnership = {
  /** The exact text this request wrote into the composer. Absent while it has written none. */
  text?: string;
  /** BR-G6-02 residue. The pre-staging reading, kept apart from any claim taken against it. */
  baseline?: AttachmentBaseline;
  /** What this request staged. Absent while it has staged none. */
  attachments?: OwnedAttachments;
};

const ownsNothing = (ownership: ComposerOwnership): boolean =>
  ownership.text === undefined && ownership.attachments === undefined;

type ComposerGuard<TElement extends Element> = {
  /**
   * The controls that remove something already staged on this composer. Named by what they say
   * they do rather than by a provider selector, which is why one implementation serves both.
   */
  attachmentRemovalControls: (element: TElement) => HTMLButtonElement[];
  /**
   * BR-G6-02. Read, before a single file is staged, what the composer already carried, so a
   * later cleanup can tell this request's attachments from the person's.
   *
   * BR-G6-02 residue. This takes no claim. Input discovery, payload construction and setter
   * discovery all sit between here and the write, and every one of them can fail; a claim
   * standing across them would be read as staging that never finished and would block a composer
   * this request never wrote to.
   */
  captureAttachmentBaseline: (
    element: TElement,
    ownership: ComposerOwnership,
    expected: number,
  ) => void;
  /**
   * BR-G6-02 residue. Turn the baseline into a claim, immediately before the native `files`
   * setter is attempted and after everything that could still refuse has answered.
   *
   * It is committed *before* the setter rather than after it because a setter that throws may
   * already have mutated the input: the write is the first instant this request can no longer
   * prove it placed nothing, so it is the instant ownership begins.
   */
  commitAttachmentOwnership: (ownership: ComposerOwnership) => void;
  /** BR-G6-02. Record the exact `File` objects this request put on the provider input. */
  recordStagedFiles: (
    ownership: ComposerOwnership,
    files: readonly File[],
  ) => void;
  /** BR-G6-02. Record the exact text this request is about to write into the composer. */
  recordInsertedText: (ownership: ComposerOwnership, text: string) => void;
  /**
   * BR-G6-02 residue. The files on the provider input that this request did not put there,
   * compared by `File` identity. A filename is metadata the page and the person can both repeat;
   * the object this request constructed is the only thing that identifies it.
   */
  foreignStagedFiles: (ownership: ComposerOwnership) => readonly File[];
  /**
   * BR-G6-02 residue. The last look before the native `files` setter runs. It is synchronous on
   * purpose: an await between this answer and the write reopens the exact window the answer
   * closes, because the setter replaces the whole list and would carry away a file the person
   * added in it. Refuses while anything at all is staged or while any removal control has
   * appeared since ownership began.
   */
  stagingWriteRefusal: (
    element: TElement,
    input: HTMLInputElement,
    ownership: ComposerOwnership,
  ) => string | undefined;
  /**
   * BR-G6-02 residue. The half of the question that holds even while the provider is still
   * settling an upload: has anything appeared on the input that this request did not place. The
   * settle window is the one time the provider itself may take this request's files away — that
   * is how it refuses an upload — so only the foreign direction is asked there.
   */
  foreignAttachmentRefusal: (ownership: ComposerOwnership) => string | undefined;
  /**
   * BR-G6-02 residue. The whole question, asked after the write has settled and after every
   * await that follows it, up to and including the one before Send: does the provider input
   * still hold exactly the `File` objects this request placed. A foreign file means the
   * submission must not proceed; a missing one means this request can no longer prove its own
   * attachments are in it.
   */
  stagedAttachmentRefusal: (ownership: ComposerOwnership) => string | undefined;
  composerConflict: (element: TElement) => string | undefined;
  cleanupComposer: (
    element: TElement,
    ownership: ComposerOwnership,
  ) => Promise<boolean>;
  rejectBeforeSubmission: (
    element: TElement,
    error: string,
    ownership: ComposerOwnership,
  ) => Promise<{ submitted: boolean; error: string }>;
};

/**
 * BB-4. Every message a provider content script sends the service worker goes through one
 * function, and both providers had the same copy of it: send, refuse anything that is not an
 * acknowledgement, and raise the background's own words when it names them. Nothing in it is
 * provider-specific.
 */
type BackgroundAck = {
  success: boolean;
  error?: string;
};

/**
 * BB-4. The document-level behaviour both provider entries ran identically.
 *
 * What was duplicated here was never the page: it was everything around the page. Watching for
 * the busy signal, forgetting a finished request, staging an attachment, waiting for the
 * response node to appear, re-binding it when the provider replaces it, moving a request onto
 * the conversation the page navigated to, streaming what was captured, and wiring the document
 * up to the service worker are the same in both files, and were the same line for line but for
 * the provider's name inside the sentences a user reads. The name comes from `config.label`, so
 * every message stays exactly what it was.
 *
 * What differs between the providers is the page: which element is the composer, which is Stop,
 * which button opens the file picker, which selectors name a message. Those arrive as typed
 * hooks and typed selector lists, and no provider policy moves here — the attachment completion
 * policies, the alert-settle loop and the send-control wait stay in the files that own them.
 */

type BachataResponseActivityObserver = {
  /** Watch this element for change, replacing whatever was watched before. */
  bind: (element: HTMLElement) => void;
  /** Treat now as the moment of the last change, without waiting for a mutation record. */
  touch: () => void;
  disconnect: () => void;
  lastMutationAt: () => number;
};

type BachataSubmittedPromptHooks = {
  cancelled: (requestId: string) => boolean;
  ensureConversationBinding: (request: BachataActiveRequest) => Promise<void>;
  /** Every user message the page currently shows, in document order. */
  userMessages: () => HTMLElement[];
  messageId: (element: HTMLElement) => string | undefined;
  healDom: () => Promise<unknown>;
  delay: (milliseconds: number) => Promise<void>;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
  healAfterMs?: number | undefined;
  pollIntervalMs?: number | undefined;
};

type BachataStreamSenderHooks = {
  documentToken: string;
  maximumResponseBytes: number;
};

type BachataIndeterminateMonitorHooks = {
  isBusy: () => boolean;
  delay: (milliseconds: number) => Promise<void>;
  /** Whether the request being monitored is still this document's active one. */
  stillActive: (requestId: string) => boolean;
  quarantine: (conversationIdentity: string) => void;
  clearQuarantine: (conversationIdentity: string) => void;
  /** The turn settled: forget the request and re-register the document. */
  settle: (requestId: string) => void;
  /** Something else took the document over: forget the request and nothing more. */
  forget: (requestId: string) => void;
  now?: (() => number) | undefined;
  /** Idle needed after the page was seen busy: the turn plainly ran and plainly stopped. */
  settledAfterBusyMs?: number | undefined;
  /** Idle needed when the page was never seen busy: it may never have started. */
  settledWithoutBusyMs?: number | undefined;
  pollIntervalMs?: number | undefined;
};

type BachataInterruptRequest = {
  provider: string;
  requestId: string;
  documentToken: string;
  frameId: number;
  conversationUrl: string;
  conversationIdentity: string;
};

type BachataInterruptHandlerHooks = {
  provider: string;
  documentToken: string;
  currentUrl: () => string;
  currentIdentity: () => string;
  /** The turn this document is running, if it is running one. */
  activeRequest: () => BachataActiveRequest | undefined;
  /** Record that this request was cancelled before anything could have been submitted. */
  rememberPreSubmit: (requestId: string) => void;
  /** Stop any repair this provider has in flight: nothing more will be sent. */
  cancelHealing: () => void;
  ensureConversationBinding: (request: BachataActiveRequest) => Promise<void>;
  interruptAndConfirm: (requestId: string) => Promise<boolean>;
  quarantine: (conversationIdentity: string) => void;
  clearQuarantine: (conversationIdentity: string) => void;
};

type BachataComposerElement = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

type BachataLifecycleObserver = {
  observer: MutationObserver;
  busyObserved: boolean;
};

type BachataSubmittedUserBinding = {
  element: HTMLElement;
  providerMessageId?: string;
  previousUsers: ReadonlySet<HTMLElement>;
  text: string;
};

type BachataResponseBinding = {
  element: HTMLElement;
  providerMessageId?: string;
  previousAssistants: ReadonlySet<HTMLElement>;
  submittedUser: BachataSubmittedUserBinding;
};

/** Only the parts of a running send that the shared behaviour reads or moves. */
type BachataActiveRequest = {
  requestId: string;
  agentId: string;
  sessionId: string;
  provider: string;
  documentToken: string;
  frameId: number;
  conversationUrl: string;
  conversationIdentity: string;
  /**
   * BR-G6-04. The conversation the controller authorized this request against, which an
   * accepted first-turn transition does not move. `conversationIdentity` follows the provider
   * onto the conversation it created for this turn; the controller's Stop still names the one
   * it sent, and both are this request.
   */
  authorizedConversationIdentity: string;
  allowInitialConversationTransition: boolean;
  transitionUsed: boolean;
  /** BR-G6-03. Whether the irreversible Send for this request has already happened. */
  submissionCommitted: boolean;
  deadlineAt: number;
};

type BachataLifecycleObserverHooks = {
  /** The provider's own Stop control, or nothing when the page shows none. */
  stopButton: () => Element | undefined;
  root?: Node | undefined;
};

type BachataComposerResolverHooks = {
  composer: () => BachataComposerElement | undefined;
  sendButton: () => HTMLElement | undefined;
  healDom: (force?: boolean, deadlineAt?: number) => Promise<boolean>;
  healedControls: () => BachataDomHealingSelection | undefined;
  controlDisabled: (element: HTMLElement | undefined) => boolean;
  delay: (milliseconds: number) => Promise<void>;
  cancelled: (requestId: string) => boolean;
  waitForResolvedControl: <T>(
    options: BachataResolvedControlWait<T>,
  ) => Promise<T | undefined>;
  now?: (() => number) | undefined;
};

type BachataComposerResolver = {
  resolveComposer: (deadlineAt?: number) => Promise<BachataComposerElement | undefined>;
  waitForEnabledSendButton: (
    timeoutMs: number,
    requestDeadlineAt?: number,
    requestId?: string,
  ) => Promise<HTMLElement | undefined>;
};

type BachataAttachmentStagingHooks = {
  controls: BachataProviderControls;
  /** The element the provider stages attachments against: its composer's form. */
  attachmentRoot: () => Element | undefined;
  page: () => ParentNode;
  associatedSelectors: readonly string[];
  trustedDetachedSelectors?: readonly string[] | undefined;
  delay: (milliseconds: number) => Promise<void>;
  cancelled: (requestId: string) => boolean;
  now?: (() => number) | undefined;
  openTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
};

type BachataAttachmentStaging = {
  /** The input already associated with this composer, remembered across calls. */
  attachmentInput: () => HTMLInputElement | undefined;
  /** Open the provider's own picker and resolve whichever input it introduced. */
  openAttachmentInput: (
    requestId?: string,
    requestDeadlineAt?: number,
  ) => Promise<HTMLInputElement | undefined>;
  forgetAttachmentInput: () => void;
};

type BachataResponseBinderHooks = {
  cancelled: (requestId: string) => boolean;
  ensureConversationBinding: (request: BachataActiveRequest) => Promise<void>;
  newAssistantsAfterUser: (
    previousAssistants: ReadonlySet<HTMLElement>,
    submittedUser: BachataSubmittedUserBinding,
  ) => HTMLElement[];
  messageId: (element: HTMLElement) => string | undefined;
  healDom: () => Promise<unknown>;
  delay: (milliseconds: number) => Promise<void>;
  now?: (() => number) | undefined;
  healAfterMs?: number | undefined;
  pollIntervalMs?: number | undefined;
};

type BachataResponseBinder = {
  waitForResponseBinding: (
    request: BachataActiveRequest,
    previousAssistants: ReadonlySet<HTMLElement>,
    submittedUser: BachataSubmittedUserBinding,
  ) => Promise<BachataResponseBinding>;
  /** Re-attach a bound response the provider replaced, or refuse when it became ambiguous. */
  rebindResponse: (
    binding: BachataResponseBinding,
    replacements: readonly HTMLElement[],
  ) => HTMLElement;
};

type BachataConversationBinderHooks = {
  documentToken: string;
  provider: string;
  currentUrl: () => string;
  sendBackground: (message: unknown) => Promise<unknown>;
  registerDocument: () => Promise<void>;
};

type BachataAssetSourceStoreOptions = {
  maximumSources: number;
  maximumInlineBytes: number;
};

type BachataAssetSourceStore = {
  sources: Map<string, BachataAssetSource>;
  remember: (sources: readonly BachataAssetSource[]) => void;
};

type BachataRequestTeardownHooks = {
  cancelledRequests: { delete: (requestId: string) => unknown };
  activeRequestId: () => string | undefined;
  clearActiveRequest: () => void;
  ensureRegisteredUrl: () => void;
  /** BB-A4-N01. The interrupt that is still stopping this request, if one is. */
  lease?: InterruptLease | undefined;
};

type BachataDocumentWiringHooks = {
  activeRequest: () => unknown;
  ensureRegisteredUrl: (verify?: boolean) => void;
  registerDocument: () => Promise<void>;
  providerStatus: () => Promise<unknown>;
  submit: (message: ProviderMessage) => Promise<unknown>;
  interrupt: (message: ProviderMessage) => Promise<unknown>;
  /** The assets this document published, by id. */
  assetSources: ReadonlyMap<string, BachataAssetSource>;
  /** What of an asset the controller may be told about. */
  publicAssetMetadata: (source: BachataAssetSource) => unknown;
  fetchAsset: (message: ProviderMessage) => void;
  cancelAsset: (message: ProviderMessage) => boolean;
  reregisterIntervalMs?: number | undefined;
};

type BachataProviderConfig = {
  provider: string;
  label: string;
  origin: string;
  freshPathnames: readonly string[];
  conversationPathPrefixes: readonly string[];
};

type BachataProviderLogicGlobal = typeof globalThis & {
  __pairProviderLogic?: (config: BachataProviderConfig) => BachataProviderLogic;
};

const createProviderLogic = (config: BachataProviderConfig): BachataProviderLogic => {
  const canonicalizeRenderedPrompt = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/\n$/, "");

  const streamUpdate = (
  previous: string,
  current: string,
  ): StreamUpdate | undefined => {
  if (previous === current) {
    return undefined;
  }
  if (current.startsWith(previous)) {
    return { mode: "append", text: current.slice(previous.length) };
  }
  return { mode: "replace", text: current };
  };

  const singleNewItem = <T>(
  previous: ReadonlySet<T>,
  current: readonly T[],
  ): T | undefined => {
  const added = current.filter((item) => !previous.has(item));
  if (added.length > 1) {
    throw new Error(`More than one new ${config.label} message appeared`);
  }
  return added.at(0);
  };

  const uniqueItem = <T>(items: readonly T[]): T | undefined => {
  const unique = Array.from(new Set(items));
  if (unique.length > 1) {
    throw new Error(`${config.label} page contains ambiguous provider controls`);
  }
  return unique.at(0);
  };

  const utf8ByteLength = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

  const assertTextWithinLimit = (
  text: string,
  maximumBytes: number,
  label: string,
  ): void => {
  if (utf8ByteLength(text) > maximumBytes) {
    throw new Error(`${label} exceeds ${String(maximumBytes)} bytes`);
  }
  };

  const canonicalConversationUrl = (value: string): string => {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
  };

  const conversationIdentityFor = (value: string): string =>
    `${config.provider}:${canonicalConversationUrl(value)}`;

  const sessionIdForConversation = (
    tabId: number,
    documentToken: string,
    conversationIdentity: string,
  ): string =>
    `${config.provider}:${String(tabId)}:${documentToken}:${encodeURIComponent(conversationIdentity)}`;

  // The only rule that ever differed between providers: which page counts as "not yet a
  // conversation", and what a real conversation URL looks like once one exists.
  const isSupportedInitialTransition = (
    previousUrl: string,
    nextUrl: string,
  ): boolean => {
    try {
      const previous = new URL(previousUrl);
      const next = new URL(nextUrl);
      return (
        previous.origin === config.origin &&
        next.origin === previous.origin &&
        config.freshPathnames.includes(previous.pathname) &&
        config.conversationPathPrefixes.some((prefix) => next.pathname.startsWith(prefix))
      );
    } catch {
      return false;
    }
  };

  const normalizePartText = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");

  const composeCapturedResponse = (
  parts: readonly CapturedPart[],
  ): CapturedResponse => {
  const compacted: CapturedPart[] = [];
  for (const part of parts) {
    const text = normalizePartText(part.text);
    if (!text) {
      continue;
    }
    const previous = compacted.at(-1);
    if (
      previous &&
      previous.type === part.type &&
      previous.language === part.language
    ) {
      previous.text += text;
    } else {
      compacted.push({
        type: part.type,
        text,
        ...(part.language ? { language: part.language } : {}),
      });
    }
  }

  while (compacted[0]?.type === "text") {
    compacted[0].text = compacted[0].text.replace(/^\n+/, "");
    if (compacted[0].text) {
      break;
    }
    compacted.shift();
  }
  while (compacted.at(-1)?.type === "text") {
    const last = compacted.at(-1);
    if (!last) {
      break;
    }
    last.text = last.text.replace(/\n+$/, "");
    if (last.text) {
      break;
    }
    compacted.pop();
  }

  const segments: CapturedSegment[] = [];
  let text = "";
  for (const part of compacted) {
    const start = text.length;
    text += part.text;
    segments.push({
      type: part.type,
      text: part.text,
      start,
      end: text.length,
      ...(part.language ? { language: part.language } : {}),
    });
  }
  return { text, segments };
  };

  // A disabled Send button is not authoritative: providers disable it while composing, while
  // uploading, and on an empty composer. Only the Stop control marks generation.
  const isBusyState = (hasStopButton: boolean): boolean => hasStopButton;

  // Silence is the absence of evidence, not evidence of an ended turn. A provider that renders a
  // control only once its own turn is over says so positively, and where that control is proven
  // to exist it is required: quiet time can never stand in for it.
  //
  // Three outcomes, because two cannot express what is actually known. `wait` is "not yet";
  // `complete` is "this turn ended"; `domDrift` is "the provider went idle on a stable answer and
  // never showed its own end-of-turn control", which is a statement about this adapter's reading
  // of the page, not about the answer. The caller fails that closed. A provider with no proven
  // control passes `undefined` and keeps the lifecycle rule exactly.
  //
  // The grace runs on its own clock, `actionMissingForMs`, which the caller starts only once a
  // settled and stable candidate is seen to have no control and restarts whenever that stops
  // holding. Neither terminal answer is given about a candidate still in motion, so a page
  // changing under the adapter can never age its way into one.
  const completionSettled = (input: SettledInput): boolean =>
  input.busyObserved &&
  !input.currentlyBusy &&
  input.responseText.length > 0 &&
  input.quietForMs >= input.requiredQuietMs &&
  input.idleForMs >= input.requiredIdleMs;

  const completionOutcome = (input: CompletionInput): CompletionOutcome => {
  if (!completionSettled(input)) return "wait";
  if (input.completionActionVisible === undefined) return "complete";
  // Neither terminal answer may be given about a candidate that is still moving: a control read
  // from a response about to be replaced says nothing about the replacement, and drift declared
  // against a page mid-rerender is a verdict on a page that has not finished speaking.
  if (input.candidateStable !== true) return "wait";
  if (input.completionActionVisible) return "complete";
  return (input.actionMissingForMs ?? 0) >= (input.actionGraceMs ?? 0) ? "domDrift" : "wait";
  };

  const shouldCompleteResponse = (input: CompletionInput): boolean =>
  completionOutcome(input) === "complete";

/**
   * Which request ids this realm has cancelled.
   *
   * Every ordinary cancellation is removed again by the `conversation.send` that follows it for
   * the same id. A pre-submit interrupt has no such follow-up: it is acknowledged and the
   * request never arrives, so its entry would stay for the life of the page. Those entries, and
   * only those, expire — unless the id became the active request in the meantime, in which case
   * the running turn still owns the decision.
   */
  const createCancellationRegistry = (
  options: BachataCancellationOptions,
  ): CancellationRegistry => {
  const cancelled = new Set<string>();
  const preSubmitTtlMs = options.preSubmitTtlMs ?? 30_000;
  const schedule = options.schedule ?? ((callback, delayMs) => {
    setTimeout(callback, delayMs);
  });
  return {
    add: (requestId) => {
      cancelled.add(requestId);
    },
    has: (requestId) => cancelled.has(requestId),
    delete: (requestId) => cancelled.delete(requestId),
    rememberPreSubmit: (requestId) => {
      cancelled.add(requestId);
      schedule(() => {
        if (!options.isActive(requestId)) {
          cancelled.delete(requestId);
        }
      }, preSubmitTtlMs);
    },
    size: () => cancelled.size,
  };
  };

/**
   * The message table both provider content scripts answer.
   *
   * The two entries carried byte-identical copies of it, so a change to how a failure is
   * reported — or to whether a reply is asynchronous — had to be made twice and could silently
   * be made once. What differs per provider is which functions do the work, so those arrive as
   * handlers and the shape of every reply is decided here.
   *
   * Returning true keeps the message channel open for an asynchronous reply; the synchronous
   * asset answers return false, which is what tells Chrome the channel may close.
   */
  const createProviderMessageListener = (
  handlers: ProviderMessageHandlers,
  ): ProviderMessageListener => (message, _sender, respond) => {
  const failWith = (shape: Record<string, unknown>) => (cause: unknown): void => {
    respond({
      ...shape,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  };
  if (message.type === "provider.status") {
    handlers.ensureRegisteredUrl();
    void handlers.providerStatus().then(respond, failWith({ status: "failed" }));
    return true;
  }
  if (message.type === "content.reregister") {
    void handlers.registerDocument().then(
      () => respond({ success: true }),
      failWith({ success: false }),
    );
    return true;
  }
  if (message.type === "conversation.send") {
    void handlers.submit(message).then(respond, failWith({ submitted: false }));
    return true;
  }
  if (message.type === "conversation.interrupt") {
    void handlers.interrupt(message).then(respond, failWith({ interrupted: false }));
    return true;
  }
  if (message.type === "asset.probe") {
    const asset = handlers.assetMetadata(message);
    respond({ success: true, ...(asset === undefined ? {} : { asset }) });
    return false;
  }
  if (message.type === "asset.reveal") {
    const reveal = handlers.assetRevealer(message);
    if (!reveal) {
      respond({
        success: false,
        error: "The provider asset is no longer visible in this document",
      });
      return false;
    }
    try {
      reveal();
      respond({ success: true });
    } catch (cause) {
      respond({
        success: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return false;
  }
  if (message.type === "asset.fetch") {
    respond({ success: true, accepted: true });
    handlers.fetchAsset(message);
    return false;
  }
  if (message.type === "asset.cancel") {
    respond({ success: handlers.cancelAsset(message) });
    return false;
  }
  return false;
  };

/**
   * One asset transfer, driven from the page to the background.
   *
   * Both provider content scripts ran a byte-identical copy of this, differing only in the
   * sentence shown when the asset is gone. What it decides is the same in both: an unknown
   * asset is reported rather than thrown, a transfer identifier is used once, a cancelled
   * transfer is reported as cancelled rather than as a failure, and the transfer is forgotten
   * either way so a retry is not refused as a duplicate.
   *
   * The registry is held here rather than passed in, because its only readers are the two
   * functions returned.
   */
  const createAssetTransferDriver = <Source>(
  options: AssetTransferOptions<Source>,
  ): AssetTransferDriver => {
  const transfers = new Map<string, { assetId: string; controller: AbortController }>();
  const report = (
    message: { transferId: string; assetId: string },
    code: string,
    detail: string,
  ): Promise<unknown> =>
    options.sendBackground({
      type: "content.asset.error",
      documentToken: options.documentToken,
      transferId: message.transferId,
      assetId: message.assetId,
      code,
      message: detail,
    });

  return {
    activeTransfers: () => transfers.size,
    cancelAsset: (message) => {
      const transfer = transfers.get(message.transferId);
      if (!transfer || transfer.assetId !== message.assetId) {
        return false;
      }
      transfer.controller.abort();
      return true;
    },
    fetchAsset: async (message) => {
      const source = options.assetSources.get(message.assetId);
      if (source === undefined) {
        await report(message, "ASSET_UNAVAILABLE", options.unavailableMessage);
        return;
      }
      if (transfers.has(message.transferId)) {
        throw new Error("The asset transfer identifier is already active");
      }
      const controller = new AbortController();
      transfers.set(message.transferId, { assetId: message.assetId, controller });
      try {
        const result = await options.transferAsset(
          source,
          message.maxBytes,
          controller.signal,
          {
            start: (metadata) =>
              options.sendBackground({
                type: "content.asset.start",
                documentToken: options.documentToken,
                transferId: message.transferId,
                assetId: message.assetId,
                name: metadata.name,
                mimeType: metadata.mimeType,
                size: metadata.size,
              }).then(() => undefined),
            chunk: (sequence, dataBase64) =>
              options.sendBackground({
                type: "content.asset.chunk",
                documentToken: options.documentToken,
                transferId: message.transferId,
                assetId: message.assetId,
                sequence,
                dataBase64,
              }).then(() => undefined),
          },
        );
        await options.sendBackground({
          type: "content.asset.complete",
          documentToken: options.documentToken,
          transferId: message.transferId,
          assetId: message.assetId,
          size: result.size,
          sha256: result.sha256,
        });
      } catch (cause) {
        // A cancellation is not a failure, and the caller has to be able to tell them apart.
        await report(
          message,
          cause instanceof DOMException && cause.name === "AbortError"
            ? "ASSET_CANCELLED"
            : "ASSET_FETCH_FAILED",
          cause instanceof Error ? cause.message : String(cause),
        ).catch(() => undefined);
      } finally {
        transfers.delete(message.transferId);
      }
    },
  };
  };

/**
   * What the controller is told about this page, right now.
   *
   * Both provider content scripts held a byte-identical copy of this and differed in one
   * string: the provider name the quarantine authority is asked about. The order the seven
   * answers are decided in is the whole of it, and it is not arbitrary.
   *
   * No composer is either a sign-in page or a page still loading, and the two are different
   * answers: one is the user's to fix and the other resolves itself. A quarantined conversation
   * is failed before anything else about the page is considered, because an uncertain provider
   * state is not made safe by a composer that happens to be writable. A blocked composer is
   * failed after that, generation in progress is streaming, and a composer the page has more
   * than one of is not ready rather than picked between.
   *
   * The quarantine verdict is read once. It is a background round-trip and status is polled, so
   * seven branches sharing one read is the difference between one message and seven.
   */
/**
   * REVIEW-11 / BB-4. One rendered response, read into the ordered parts the controller stores.
   *
   * Both provider content scripts carried this byte for byte, differing only in the name of the
   * part type — `CapturedPart` in one file, `ClaudeCapturedPart` in the other, the same three
   * fields in both. Nothing in it is provider-specific: it is a walk of a subtree the caller has
   * already bound, and what it decides is what counts as content.
   *
   * A button, an SVG, a script, a style, a `hidden` element and an `aria-hidden` one are all
   * skipped, because none of them is response text a user could read. A `<pre>` becomes one code
   * block carrying its language rather than a run of text lines, and a `<blockquote>` becomes one
   * quote, because both lose their meaning once flattened. Block elements are separated by a
   * newline that is only added when the previous part does not already end in one, so nesting
   * cannot multiply blank lines.
   */
  const codeLanguage = (element: HTMLElement): string | undefined => {
    const explicit =
      element.getAttribute("data-language") ??
      element.querySelector<HTMLElement>("[data-language]")?.getAttribute(
        "data-language",
      );
    if (explicit?.trim()) {
      return explicit.trim();
    }
    const code = element.matches("code")
      ? element
      : element.querySelector<HTMLElement>("code");
    const languageClass = Array.from(code?.classList ?? []).find((value) =>
      value.startsWith("language-"),
    );
    return languageClass?.slice("language-".length) || undefined;
  };

  const blockTags = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "DIV",
    "DL",
    "DT",
    "DD",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);

  const captureResponseParts = (root: HTMLElement): CapturedPart[] => {
    const parts: CapturedPart[] = [];
    const append = (
      type: CapturedPart["type"],
      text: string,
      language?: string,
    ): void => {
      if (!text) {
        return;
      }
      parts.push({ type, text, ...(language ? { language } : {}) });
    };
    const newline = (): void => {
      const last = parts.at(-1);
      if (!last || !last.text.endsWith("\n")) {
        append("text", "\n");
      }
    };
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        append("text", node.textContent ?? "");
        return;
      }
      if (!(node instanceof HTMLElement)) {
        return;
      }
      if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        ["BUTTON", "SVG", "SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName)
      ) {
        return;
      }
      if (node.tagName === "BR") {
        newline();
        return;
      }
      if (node.tagName === "PRE") {
        newline();
        append(
          "codeBlock",
          node.querySelector<HTMLElement>("code")?.innerText ?? node.innerText,
          codeLanguage(node),
        );
        newline();
        return;
      }
      if (node.tagName === "BLOCKQUOTE") {
        newline();
        append("quote", node.innerText);
        newline();
        return;
      }
      const block = blockTags.has(node.tagName);
      if (block) {
        newline();
      }
      Array.from(node.childNodes).forEach(walk);
      if (block) {
        newline();
      }
    };
    Array.from(root.childNodes).forEach(walk);
    return parts;
  };

/**
   * BB-4. Stopping a turn, and knowing that it stopped.
   *
   * Both provider entries carried this byte for byte. What differs between them is which element
   * is the Stop control, what "busy" means on that page, and how a lost control is re-located —
   * all passed in, because each is a page fact and none of them is a decision.
   *
   * The decisions are here. A provider is only believed to have stopped after it has looked idle
   * continuously for a second: providers flicker between busy and idle mid-turn, and a single
   * idle reading is the one moment that must not be trusted. A read that throws is not an idle
   * reading either — it is a page that could not be asked, and the honest answer is that stopping
   * was not confirmed.
   *
   * `interruptAndConfirm` records the cancellation before it clicks anything, so a turn that is
   * already being interrupted cannot also be treated as running. It takes that record back on
   * every path that did not confirm a stop, because a request the provider may still be answering
   * must not be left marked cancelled: the caller has to see an unconfirmed interrupt and
   * quarantine it, not a clean cancellation that never happened.
   */
  const createInterruptControl = (
  options: InterruptControlOptions,
  ): InterruptControl => {
  const now = options.now ?? (() => Date.now());

  const confirmStopped = async (stillBound?: () => boolean): Promise<boolean> => {
    const deadline = now() + 10_000;
    let absentSince: number | undefined;
    while (now() < deadline) {
      // BR-G6-05. A quiet page that is no longer this turn's page confirms nothing about this
      // turn, and reporting it as stopped is the one state a retry would duplicate a message
      // from.
      if (stillBound !== undefined && !stillBound()) {
        return false;
      }
      try {
        if (options.isBusy()) {
          absentSince = undefined;
        } else {
          absentSince ??= now();
          if (now() - absentSince >= 1_000) {
            return true;
          }
        }
      } catch {
        return false;
      }
      await options.delay(100);
    }
    return false;
  };

  const waitForStopButton = async (
    timeoutMs: number,
    stillBound?: () => boolean,
  ): Promise<HTMLElement | undefined> => {
    const deadline = now() + timeoutMs;
    return await options.waitForResolvedControl<HTMLElement>({
      resolve: options.stopButton,
      heal: async () => await options.heal(deadline),
      delay: options.delay,
      pollIntervalMs: 100,
      timeoutMs,
      // BR-G6-05. Abandoning the wait is what stops a control being resolved, and a page being
      // healed, on behalf of a turn that is no longer the one in front of us.
      ...(stillBound === undefined ? {} : { abandoned: () => !stillBound() }),
      // BB-4. The resolver reads a clock too. Production passes none and both keep using the
      // real one; a caller that injects a clock has to have both waits read it, or the outer
      // deadline is simulated while the inner one runs for three real seconds.
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  };

  return {
    confirmStopped,
    waitForStopButton,
    interruptAndConfirm: async (requestId, requireStopControl = true) => {
      const stillBound = (): boolean => options.stillBound(requestId);
      const abandon = (): boolean => {
        options.forgetCancellation(requestId);
        return false;
      };
      // BB-A4-N01. Taken before the cancellation is recorded, because recording it is what makes
      // the capture loop return, and the request has to outlive that return.
      options.lease?.hold(requestId);
      try {
        options.rememberCancellation(requestId);
        const stop = await waitForStopButton(3_000, stillBound);
        // BR-G6-05. The control was resolved across an await. Clicking it, and believing what the
        // page does afterwards, are each only allowed while this is still the turn's own page.
        if (!stillBound()) {
          return abandon();
        }
        if (!stop && requireStopControl) {
          return abandon();
        }
        stop?.click();
        if (!stillBound()) {
          return abandon();
        }
        if (await confirmStopped(stillBound)) {
          return true;
        }
        return abandon();
      } finally {
        if (options.lease?.release(requestId)) {
          options.retireRequest?.(requestId);
        }
      }
    },
  };
  };

  const createProviderStatusReader = (
  options: ProviderStatusOptions,
  ): (() => Promise<ProviderStatusValue>) => async () => {
  const conversationUrl = options.currentUrl();
  const conversationIdentity = options.conversationIdentityFor(conversationUrl);
  const quarantined = await options.conversationIsQuarantined(
    options.provider,
    conversationIdentity,
  );
  const conversationState = quarantined ? "uncertain" as const : "confirmed" as const;
  const answer = (
    status: string,
    state: "confirmed" | "uncertain" = conversationState,
  ): ProviderStatusValue => ({
    status,
    documentToken: options.documentToken,
    conversationUrl,
    conversationIdentity,
    conversationState: state,
  });
  try {
    const composer = await options.resolveComposer();
    if (!composer) {
      return answer(options.onAuthenticationPath() ? "notAuthenticated" : "notReady");
    }
    if (quarantined) {
      return answer("failed", "uncertain");
    }
    if (options.composerBlockedReason() !== undefined) {
      return answer("failed");
    }
    if (options.generationActive()) {
      return answer("streaming");
    }
    if (options.composerConflict(composer) !== undefined) {
      return answer("notReady");
    }
    return answer("ready");
  } catch {
    // A page that threw while being read is not a page that answered. "notReady" is the only
    // honest thing to say about it, and it is not a failure the user has to clear.
    return answer("notReady");
  }
  };

  const createRegistrationCoordinator = (
  options: BachataRegistrationOptions,
  ): RegistrationCoordinator => {
  const now = options.now ?? Date.now;
  const verificationIntervalMs = options.verificationIntervalMs ?? 10_000;
  let acknowledgedUrl = "";
  let acknowledgedAt = 0;
  let operation: Promise<void> | undefined;

  const register = (): Promise<void> => {
    if (operation) {
      return operation;
    }
    const url = options.currentUrl();
    const pending = options.registerUrl(url).then(() => {
      acknowledgedUrl = url;
      acknowledgedAt = now();
    });
    const tracked = pending.finally(() => {
      if (operation === tracked) {
        operation = undefined;
      }
    });
    operation = tracked;
    return tracked;
  };

  const ensure = (verify = false): Promise<void> => {
    if (
      acknowledgedUrl !== options.currentUrl() ||
      (verify && now() - acknowledgedAt >= verificationIntervalMs)
    ) {
      return register();
    }
    return Promise.resolve();
  };

  return {
    register,
    ensure,
    registeredUrl: () => acknowledgedUrl,
  };
  };

  const sendBackground = async <T extends BackgroundAck>(
    message: unknown,
  ): Promise<T> => {
    const result = (await chrome.runtime.sendMessage(message)) as T | undefined;
    if (!result?.success) {
      throw new Error(result?.error ?? "Browser background rejected the message");
    }
    return result;
  };

  const createComposerGuard = <TElement extends Element>(
    hooks: ComposerGuardHooks<TElement>,
  ): ComposerGuard<TElement> => {
    const now = hooks.now ?? (() => Date.now());
    const cleanupTimeoutMs = hooks.cleanupTimeoutMs ?? 3_000;

    const controlDescription = (button: HTMLButtonElement): string =>
      [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.getAttribute("data-testid"),
      ]
        .filter(Boolean)
        .join(" ");

    const attachmentRemovalControls = (element: TElement): HTMLButtonElement[] => {
      const root = element.closest("form") ?? element.parentElement ?? document.body;
      return Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          "button[aria-label], button[title], button[data-testid]",
        ),
      ).filter((button) => {
        const description = controlDescription(button);
        return /(?:remove|delete)/iu.test(description) &&
          /(?:attachment|file|image|upload)/iu.test(description);
      });
    };

    const stagedAttachmentCount = (): number => hooks.attachmentInput()?.files?.length ?? 0;

    const stagedFiles = (): File[] => {
      const files = hooks.attachmentInput()?.files;
      return files ? Array.from(files) : [];
    };

    /**
     * BR-G6-02. Rewrite the provider input with everything except `owned`. There is deliberately
     * no "clear the input" form of this: emptying it is what deleted a person's attachment, and a
     * primitive that can still do it is a primitive a later change can reach for.
     */
    const withdrawStagedFiles = (owned: readonly File[]): void => {
      const input = hooks.attachmentInput();
      if (!input) {
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "files",
      )?.set;
      if (!setter) {
        return;
      }
      const transfer = new DataTransfer();
      stagedFiles()
        .filter((file) => !owned.includes(file))
        .forEach((file) => transfer.items.add(file));
      setter.call(input, transfer.files);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const captureAttachmentBaseline = (
      element: TElement,
      ownership: ComposerOwnership,
      expected: number,
    ): void => {
      if (expected <= 0) {
        return;
      }
      ownership.baseline = { before: attachmentRemovalControls(element), expected };
    };

    const commitAttachmentOwnership = (ownership: ComposerOwnership): void => {
      const baseline = ownership.baseline;
      if (!baseline || ownership.attachments) {
        return;
      }
      ownership.attachments = { before: baseline.before, files: [], expected: baseline.expected };
    };

    /**
     * BR-G6-02 residue. The removal controls this request has to treat as the person's, whether
     * or not it has committed a claim yet. Before the write that is the baseline reading; after
     * it the committed claim carries the same list forward.
     */
    const removalBaseline = (
      ownership: ComposerOwnership,
    ): readonly HTMLButtonElement[] => ownership.attachments?.before ?? ownership.baseline?.before ?? [];

    const recordStagedFiles = (
      ownership: ComposerOwnership,
      files: readonly File[],
    ): void => {
      const owned = ownership.attachments;
      if (!owned) {
        return;
      }
      ownership.attachments = { ...owned, files };
    };

    const recordInsertedText = (
      ownership: ComposerOwnership,
      text: string,
    ): void => {
      ownership.text = text;
    };

    const foreignStagedFiles = (
      ownership: ComposerOwnership,
    ): readonly File[] => {
      const owned = ownership.attachments?.files ?? [];
      return stagedFiles().filter((file) => !owned.includes(file));
    };

    const foreignAttachmentReason =
      `${config.label} composer gained an attachment Bachata did not stage. Send or clear it before using Bachata`;

    const stagingWriteRefusal = (
      element: TElement,
      input: HTMLInputElement,
      ownership: ComposerOwnership,
    ): string | undefined => {
      if (!input.isConnected || hooks.attachmentInput() !== input) {
        return `${config.label} attachment input changed before Bachata staged its files`;
      }
      if (!element.isConnected) {
        return `${config.label} composer changed before Bachata staged its files`;
      }
      if (hooks.readComposer(element).trim().length > 0) {
        return `${config.label} composer already contains text. Send or clear it before using Bachata`;
      }
      // Nothing may be on the input at all: the setter replaces the whole list, so a single file
      // present here is a file the write would silently take away from the person.
      if (stagedFiles().length > 0) {
        return foreignAttachmentReason;
      }
      const before = new Set(removalBaseline(ownership));
      if (attachmentRemovalControls(element).some((button) => !before.has(button))) {
        return foreignAttachmentReason;
      }
      return undefined;
    };

    const foreignAttachmentRefusal = (
      ownership: ComposerOwnership,
    ): string | undefined =>
      ownership.attachments && foreignStagedFiles(ownership).length > 0
        ? foreignAttachmentReason
        : undefined;

    const stagedAttachmentRefusal = (
      ownership: ComposerOwnership,
    ): string | undefined => {
      const owned = ownership.attachments;
      if (!owned) {
        return undefined;
      }
      const foreign = foreignAttachmentRefusal(ownership);
      if (foreign) {
        return foreign;
      }
      const staged = stagedFiles();
      if (owned.files.some((file) => !staged.includes(file))) {
        return `${config.label} composer no longer holds the attachments Bachata staged`;
      }
      return undefined;
    };

    const composerConflict = (element: TElement): string | undefined => {
      if (hooks.readComposer(element).trim().length > 0) {
        return `${config.label} composer already contains text. Send or clear it before using Bachata`;
      }
      if (
        stagedAttachmentCount() > 0 ||
        attachmentRemovalControls(element).length > 0
      ) {
        return `${config.label} composer already contains attachments. Send or clear them before using Bachata`;
      }
      return undefined;
    };

    const cleanupComposer = async (
      element: TElement,
      ownership: ComposerOwnership,
    ): Promise<boolean> => {
      // BR-G6-02. Nothing of this request's is in the composer, so there is nothing to undo and
      // everything present belongs to the person. Reporting success is accurate: the composer
      // holds exactly what it held before the request touched the page.
      if (ownsNothing(ownership)) {
        return true;
      }
      try {
        const owned = ownership.attachments;
        // BR-G6-02. Ambiguity is decided before anything is removed, and it is never resolved by
        // removing more. Text the person changed is no longer this request's insertion; an
        // attachment no provider fact binds to this request stays exactly where it is, and the
        // provider input is rebuilt only around the exact `File` objects this request placed.
        let ambiguous = false;

        if (ownership.text !== undefined) {
          if (hooks.readComposer(element) === ownership.text) {
            hooks.writeComposer(element, "");
          } else {
            ambiguous = true;
          }
        }

        // BR-G6-02 residue. No removal control is clicked here at all. A control is bound to a
        // file only by a stable provider identifier created while this request staged, and
        // neither provider publishes one: a filename is metadata the page repeats and the person
        // can supply, appearance order is a render race, and a count is neither. So the only
        // thing this request may take back is the exact `File` objects it placed — the input is
        // rebuilt around them, the page is told, and the result is then observed. If the
        // provider's own chips do not follow, the cleanup is unproved and the composer is
        // blocked; it is never guessed at by clicking something.
        if (owned) {
          if (owned.files.length < owned.expected) {
            // Staging may have placed a file this request never got to name. Nothing here can
            // say which, so nothing may be withdrawn.
            ambiguous = true;
          } else if (owned.files.length > 0) {
            withdrawStagedFiles(owned.files);
          }
        }

        if (ambiguous) {
          return false;
        }

        const before = new Set(owned?.before ?? []);
        const deadline = now() + cleanupTimeoutMs;
        for (;;) {
          const textWithdrawn = ownership.text === undefined ||
            hooks.readComposer(element).trim().length === 0;
          const attachmentsWithdrawn = !owned ||
            (stagedFiles().every((file) => !owned.files.includes(file)) &&
              attachmentRemovalControls(element).every((button) => before.has(button)));
          if (textWithdrawn && attachmentsWithdrawn) {
            return true;
          }
          if (now() >= deadline) {
            return false;
          }
          await hooks.delay(50);
        }
      } catch {
        return false;
      }
    };

    const rejectBeforeSubmission = async (
      element: TElement,
      error: string,
      ownership: ComposerOwnership,
    ): Promise<{ submitted: boolean; error: string }> => {
      // BR-G6-02. A refusal that owns nothing leaves the document alone entirely: it neither
      // clears the composer nor blocks it, because there is nothing about it left unverified.
      if (ownsNothing(ownership)) {
        return { submitted: false, error };
      }
      const cleaned = await cleanupComposer(element, ownership);
      if (cleaned) {
        return { submitted: false, error };
      }
      const reason =
        `${config.label} composer cleanup could not be verified. Reload the provider tab before continuing`;
      hooks.blockComposer(reason);
      return {
        submitted: false,
        error: `${error}. ${reason}`,
      };
    };

    return {
      attachmentRemovalControls,
      captureAttachmentBaseline,
      commitAttachmentOwnership,
      recordStagedFiles,
      recordInsertedText,
      foreignStagedFiles,
      stagingWriteRefusal,
      foreignAttachmentRefusal,
      stagedAttachmentRefusal,
      composerConflict,
      cleanupComposer,
      rejectBeforeSubmission,
    };
  };

  /**
   * BB-4. The busy watcher. A provider is busy when its Stop control is present; the observer
   * records that it ever was, because a turn that finished before the first poll still happened.
   */
  const startLifecycleObserver = (
    hooks: BachataLifecycleObserverHooks,
  ): BachataLifecycleObserver => {
    const lifecycle: BachataLifecycleObserver = {
      observer: undefined as unknown as MutationObserver,
      busyObserved: false,
    };
    const updateBusy = (): void => {
      try {
        if (isBusyState(Boolean(hooks.stopButton()))) {
          lifecycle.busyObserved = true;
        }
      } catch {
        return;
      }
    };
    lifecycle.observer = new MutationObserver(updateBusy);
    lifecycle.observer.observe(hooks.root ?? document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "data-state"],
    });
    updateBusy();
    return lifecycle;
  };

  /**
   * BB-4. Forgetting a request. Every exit from a turn — refused before submission, finished,
   * failed after commitment — ends with the same four steps, and a turn that skipped one of them
   * would leave the document unable to accept the next.
   */
  const createRequestTeardown = (hooks: BachataRequestTeardownHooks) =>
    (requestId: string): void => {
      // BB-A4-N01. A capture that stopped because this request is being interrupted has done its
      // own cleanup already; retiring the request here would take the cancellation record and the
      // active request out from under the Stop that is still being confirmed. The teardown is
      // owed, not skipped: the interrupt runs it when it lets go.
      if (hooks.lease?.held(requestId)) {
        hooks.lease.defer(requestId);
        return;
      }
      hooks.cancelledRequests.delete(requestId);
      if (hooks.activeRequestId() === requestId) {
        hooks.clearActiveRequest();
      }
      hooks.ensureRegisteredUrl();
    };

  const createInterruptLease = (): InterruptLease => {
    const holding = new Set<string>();
    const owed = new Set<string>();
    return {
      hold: (requestId) => {
        holding.add(requestId);
        owed.delete(requestId);
      },
      held: (requestId) => holding.has(requestId),
      defer: (requestId) => {
        owed.add(requestId);
      },
      release: (requestId) => {
        holding.delete(requestId);
        return owed.delete(requestId);
      },
    };
  };

  /**
   * BB-4. Resolving the composer, and waiting for a send control that is really enabled.
   *
   * The resolver throws only on an ambiguous page with no healed binding, which is the same
   * answer as "no composer here": healing runs next, and a page that still cannot be resolved
   * after it returns undefined to the caller.
   */
  const createComposerResolver = (
    hooks: BachataComposerResolverHooks,
  ): BachataComposerResolver => {
    const now = hooks.now ?? (() => Date.now());
    const resolveComposer = async (
      deadlineAt?: number,
    ): Promise<BachataComposerElement | undefined> => {
      try {
        const element = hooks.composer();
        if (element) return element;
      } catch {
        // Ambiguity is answered by healing, below, not by failing the caller.
      }
      if (!(await hooks.healDom(false, deadlineAt))) return undefined;
      try {
        return hooks.composer();
      } catch {
        return hooks.healedControls()?.composer;
      }
    };
    const waitForEnabledSendButton = async (
      timeoutMs: number,
      requestDeadlineAt?: number,
      requestId?: string,
    ): Promise<HTMLElement | undefined> =>
      await hooks.waitForResolvedControl<HTMLElement>({
        resolve: hooks.sendButton,
        accept: (button) => button.isConnected && !hooks.controlDisabled(button),
        heal: async () =>
          await hooks.healDom(Boolean(hooks.healedControls()), requestDeadlineAt),
        delay: hooks.delay,
        pollIntervalMs: 50,
        timeoutMs,
        abandoned: () =>
          Boolean(requestId && hooks.cancelled(requestId))
          || (requestDeadlineAt !== undefined && now() >= requestDeadlineAt),
      });
    return { resolveComposer, waitForEnabledSendButton };
  };

  /**
   * BB-4. Resolving the file input a provider stages attachments on.
   *
   * Which button opens the picker, and whether a detached input may be trusted, are provider
   * data. What to do with what the page then introduces is not: exactly one eligible input, an
   * input that belongs to this composer, and nothing the page had before the picker opened.
   */
  const createAttachmentStaging = (
    hooks: BachataAttachmentStagingHooks,
  ): BachataAttachmentStaging => {
    const now = hooks.now ?? (() => Date.now());
    const openTimeoutMs = hooks.openTimeoutMs ?? 3_000;
    const pollIntervalMs = hooks.pollIntervalMs ?? 50;
    let selected: HTMLInputElement | undefined;
    const attachmentInput = (): HTMLInputElement | undefined => {
      const root = hooks.attachmentRoot();
      if (!root) {
        selected = undefined;
        return undefined;
      }
      selected = hooks.controls.resolveExistingAttachmentInput({
        root,
        inputs: hooks.controls.eligibleAttachmentInputs(hooks.page()),
        ...(selected ? { selected } : {}),
      });
      return selected;
    };
    const openAttachmentInput = async (
      requestId?: string,
      requestDeadlineAt?: number,
    ): Promise<HTMLInputElement | undefined> => {
      if (requestId && hooks.cancelled(requestId)) return undefined;
      if (requestDeadlineAt !== undefined && now() >= requestDeadlineAt) return undefined;
      const existing = attachmentInput();
      if (existing) {
        return existing;
      }
      const before = new Set(hooks.controls.eligibleAttachmentInputs(hooks.page()));
      const root = hooks.attachmentRoot();
      if (!root) {
        return undefined;
      }
      const control = hooks.controls.resolveAttachmentControl({
        provider: config.label,
        root,
        page: hooks.page(),
        associatedSelectors: hooks.associatedSelectors,
        ...(hooks.trustedDetachedSelectors
          ? { trustedDetachedSelectors: hooks.trustedDetachedSelectors }
          : {}),
      });
      if (!control) {
        return undefined;
      }
      control.button.click();
      const deadline = Math.min(
        now() + openTimeoutMs,
        requestDeadlineAt ?? Number.POSITIVE_INFINITY,
      );
      while (now() < deadline) {
        if (requestId && hooks.cancelled(requestId)) return undefined;
        const associated = attachmentInput();
        if (associated) {
          return associated;
        }
        const introduced = hooks.controls
          .eligibleAttachmentInputs(hooks.page())
          .filter((input) => !before.has(input));
        const resolved = hooks.controls.resolveIntroducedAttachmentInput({
          provider: config.label,
          root,
          introduced,
          acceptsDetachedInput: control.acceptsDetachedInput,
        });
        if (resolved) {
          selected = resolved;
          return selected;
        }
        await hooks.delay(pollIntervalMs);
      }
      return undefined;
    };
    return {
      attachmentInput,
      openAttachmentInput,
      forgetAttachmentInput: () => {
        selected = undefined;
      },
    };
  };

  /**
   * BR-G6-02 residue. The critical section around the native `files` setter, shared so that both
   * providers make the same decision at the same instant rather than each keeping a copy of it.
   *
   * Everything between the last look and the write is synchronous. That is the whole point: the
   * setter replaces the input's entire list, so a file the person attached after the composer
   * conflict check would be carried away by a write that merely appends this request's own. An
   * `await` anywhere in here reopens exactly the window `refuseBeforeWrite` closes, which is why
   * the refusal, the write and the two events are one uninterrupted run.
   *
   * The staged `File` objects are handed back the moment they land, before the events fire, so a
   * refusal raised by a listener still leaves a cleanup able to name exactly what it may take
   * back out.
   *
   * BR-G6-02 residue. `onBeforeWrite` is the ownership commit, and it is the last statement
   * before the setter for the same reason the refusal is: everything that can still refuse has
   * answered, and a setter that throws may already have replaced the list. Nothing above this
   * line owns anything, so every exit above it leaves the document untouched and unblocked.
   */
  const writeStagedAttachments = (options: {
    input: HTMLInputElement;
    files: readonly File[];
    refuseBeforeWrite?: ((input: HTMLInputElement) => string | undefined) | undefined;
    onBeforeWrite?: (() => void) | undefined;
    onStaged?: ((files: readonly File[]) => void) | undefined;
  }): readonly File[] => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "files",
    )?.set;
    if (!setter) {
      throw new Error("Browser file input setter is unavailable");
    }
    const transfer = new DataTransfer();
    options.files.forEach((file) => transfer.items.add(file));
    const staged = Array.from(transfer.files);
    const refusal = options.refuseBeforeWrite?.(options.input);
    if (refusal) {
      throw new Error(refusal);
    }
    options.onBeforeWrite?.();
    setter.call(options.input, transfer.files);
    options.onStaged?.(staged);
    options.input.dispatchEvent(new Event("input", { bubbles: true }));
    options.input.dispatchEvent(new Event("change", { bubbles: true }));
    return staged;
  };

  /**
   * BB-4. Turning a base64 attachment into a `File`, and refusing one whose payload does not
   * weigh what the controller said it weighs.
   */
  const attachmentFile = (attachment: {
    dataBase64: string;
    name: string;
    mimeType: string;
    size: number;
  }): File => {
    const binary = atob(attachment.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (bytes.byteLength !== attachment.size) {
      throw new Error(`Attachment ${attachment.name} size does not match its payload`);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  };

  /**
   * BB-4. Waiting for the response this turn produced, and re-binding it when the provider
   * replaces the node.
   *
   * Exactly one new response after the submitted prompt is the only accepted answer: two is
   * ambiguity the turn cannot resolve, and none means keep waiting until the request's own
   * deadline. Neither the wait nor the re-binding may guess, because both decide which text is
   * reported as this agent's answer.
   */
  const createResponseBinder = (
    hooks: BachataResponseBinderHooks,
  ): BachataResponseBinder => {
    const now = hooks.now ?? (() => Date.now());
    const healAfterMs = hooks.healAfterMs ?? 500;
    const pollIntervalMs = hooks.pollIntervalMs ?? 25;
    const waitForResponseBinding = async (
      request: BachataActiveRequest,
      previousAssistants: ReadonlySet<HTMLElement>,
      submittedUser: BachataSubmittedUserBinding,
    ): Promise<BachataResponseBinding> => {
      const startedAt = now();
      let healingAttempted = false;
      while (now() < request.deadlineAt) {
        if (hooks.cancelled(request.requestId)) {
          throw new Error(`${config.label} request was interrupted`);
        }
        await hooks.ensureConversationBinding(request);
        const added = hooks.newAssistantsAfterUser(previousAssistants, submittedUser);
        if (added.length > 1) {
          throw new Error(`More than one new ${config.label} response appeared`);
        }
        if (added.length === 1) {
          const response = added[0];
          if (!response) continue;
          const providerMessageId = hooks.messageId(response);
          return {
            element: response,
            ...(providerMessageId ? { providerMessageId } : {}),
            previousAssistants,
            submittedUser,
          };
        }
        if (!healingAttempted && now() - startedAt >= healAfterMs) {
          healingAttempted = true;
          await hooks.healDom();
        }
        await hooks.delay(pollIntervalMs);
      }
      throw new Error(`Timed out waiting for a new ${config.label} response`);
    };
    const rebindResponse = (
      binding: BachataResponseBinding,
      replacements: readonly HTMLElement[],
    ): HTMLElement => {
      if (replacements.length !== 1) {
        throw new Error(`${config.label} response association became ambiguous`);
      }
      const replacement = replacements[0];
      if (!replacement) throw new Error(`The ${config.label} response disappeared`);
      binding.element = replacement;
      const nextProviderMessageId = hooks.messageId(binding.element);
      if (nextProviderMessageId) binding.providerMessageId = nextProviderMessageId;
      return binding.element;
    };
    return { waitForResponseBinding, rebindResponse };
  };

  /**
   * BB-4. Moving a running request onto the conversation the page navigated to.
   *
   * A request is bound to one document and one conversation. The single exception is the first
   * navigation a fresh conversation makes when the provider assigns it a URL, and it is allowed
   * once, only for this document, only when the controller permitted it, and only for a
   * transition the provider's own rule recognises. Everything else is a lost binding.
   */
  const createConversationBinder = (hooks: BachataConversationBinderHooks) =>
    async (request: BachataActiveRequest): Promise<void> => {
      const nextUrl = hooks.currentUrl();
      const nextIdentity = conversationIdentityFor(nextUrl);
      if (
        request.documentToken === hooks.documentToken &&
        request.frameId === 0 &&
        request.conversationUrl === nextUrl &&
        request.conversationIdentity === nextIdentity
      ) {
        return;
      }
      // BR-G6-03. The only conversation change this request may absorb is the one the provider
      // assigns to the turn it has just been given. Before the Send there is no such turn, so a
      // conversation that changes here is somebody else's navigation — a restored conversation,
      // a sidebar click, a deep link — and submitting into it would put this prompt in a
      // conversation nobody authorized. The commitment check is what separates the two, and it
      // has to come before every other allowance.
      if (
        !request.submissionCommitted ||
        request.provider !== hooks.provider ||
        request.documentToken !== hooks.documentToken ||
        request.frameId !== 0 ||
        !request.allowInitialConversationTransition ||
        request.transitionUsed ||
        !isSupportedInitialTransition(request.conversationUrl, nextUrl)
      ) {
        throw new Error(`The ${config.label} conversation changed during the active request`);
      }
      await hooks.sendBackground({
        type: "content.transition",
        submissionCommitted: true,
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        documentToken: hooks.documentToken,
        previousConversationUrl: request.conversationUrl,
        conversationUrl: nextUrl,
        conversationIdentity: nextIdentity,
      });
      request.conversationUrl = nextUrl;
      request.conversationIdentity = nextIdentity;
      request.transitionUsed = true;
      await hooks.registerDocument();
    };

  /**
   * BB-4. What a document remembers about the assets it published.
   *
   * Bounded twice: by how many assets are remembered, and by how many bytes of inline data they
   * hold, because a long conversation full of images would otherwise grow the content script's
   * memory without limit. Oldest goes first, and re-remembering an asset moves it to the end.
   */
  const createAssetSourceStore = (
    options: BachataAssetSourceStoreOptions,
  ): BachataAssetSourceStore => {
    const sources = new Map<string, BachataAssetSource>();
    let inlineBytes = 0;
    const remember = (incoming: readonly BachataAssetSource[]): void => {
      incoming.forEach((source) => {
        const existing = sources.get(source.metadata.id);
        inlineBytes -= existing?.data?.byteLength ?? 0;
        sources.delete(source.metadata.id);
        sources.set(source.metadata.id, source);
        inlineBytes += source.data?.byteLength ?? 0;
      });
      while (
        sources.size > options.maximumSources ||
        inlineBytes > options.maximumInlineBytes
      ) {
        const first = sources.keys().next().value as string | undefined;
        if (!first) {
          break;
        }
        const removed = sources.get(first);
        sources.delete(first);
        inlineBytes -= removed?.data?.byteLength ?? 0;
      }
    };
    return { sources, remember };
  };

  /**
   * BB-4. Wiring a provider document to the service worker.
   *
   * Patching history here would only shadow this isolated world's copy; the page's own calls
   * never reach it. popstate is a real event and does cross worlds, and the periodic
   * re-registration covers pushState and replaceState for both providers.
   */
  const installProviderDocument = (hooks: BachataDocumentWiringHooks): void => {
    const notifyNavigation = (): void => {
      queueMicrotask(() => {
        if (!hooks.activeRequest()) {
          hooks.ensureRegisteredUrl();
        }
      });
    };
    window.addEventListener("popstate", notifyNavigation);
    chrome.runtime.onMessage.addListener(
      createProviderMessageListener({
        ensureRegisteredUrl: () => hooks.ensureRegisteredUrl(),
        providerStatus: hooks.providerStatus,
        registerDocument: hooks.registerDocument,
        submit: hooks.submit,
        interrupt: hooks.interrupt,
        assetMetadata: (message) => {
          const source = hooks.assetSources.get(
            String((message as { assetId?: unknown }).assetId),
          );
          return source ? hooks.publicAssetMetadata(source) : undefined;
        },
        assetRevealer: (message) =>
          hooks.assetSources.get(String((message as { assetId?: unknown }).assetId))?.reveal,
        fetchAsset: hooks.fetchAsset,
        cancelAsset: hooks.cancelAsset,
      }),
    );
    void hooks.registerDocument().catch(() => undefined);
    setInterval(() => hooks.ensureRegisteredUrl(true), hooks.reregisterIntervalMs ?? 1_000);
  };

  /**
   * BB-4. Whether the bound response is still changing.
   *
   * Quiet is measured from the last mutation inside the response node, so the node the answer is
   * being read from has to be the node being watched: a provider that replaces the node mid-turn
   * must re-bind, and re-binding resets the clock because a replacement is a fresh reading rather
   * than a continuation of the old one.
   */
  const createResponseActivityObserver = (options?: {
    now?: (() => number) | undefined;
  }): BachataResponseActivityObserver => {
    const now = options?.now ?? (() => Date.now());
    let observer: MutationObserver | undefined;
    let observed: HTMLElement | undefined;
    let lastMutationAt = now();
    return {
      bind: (element: HTMLElement): void => {
        if (observed === element) {
          return;
        }
        observer?.disconnect();
        observed = element;
        lastMutationAt = now();
        observer = new MutationObserver(() => {
          lastMutationAt = now();
        });
        observer.observe(element, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
      },
      touch: () => {
        lastMutationAt = now();
      },
      disconnect: () => {
        observer?.disconnect();
        observer = undefined;
        observed = undefined;
      },
      lastMutationAt: () => lastMutationAt,
    };
  };

  /**
   * BB-4. Waiting for the prompt this turn submitted to appear as a message.
   *
   * The prompt is matched by its rendered text, not by position, because the page may render
   * other messages while this one is in flight. Two matches is ambiguity the turn cannot resolve
   * — it would not know which message its answer follows — so it fails rather than guessing.
   */
  const createSubmittedPromptWaiter = (hooks: BachataSubmittedPromptHooks) => {
    const now = hooks.now ?? (() => Date.now());
    const timeoutMs = hooks.timeoutMs ?? 20_000;
    const healAfterMs = hooks.healAfterMs ?? 500;
    const pollIntervalMs = hooks.pollIntervalMs ?? 25;
    return async (
      request: BachataActiveRequest & { text: string },
      previousUsers: ReadonlySet<HTMLElement>,
    ): Promise<BachataSubmittedUserBinding> => {
      const text = canonicalizeRenderedPrompt(request.text);
      const startedAt = now();
      const deadlineAt = Math.min(request.deadlineAt, startedAt + timeoutMs);
      let healingAttempted = false;
      while (now() < deadlineAt) {
        if (hooks.cancelled(request.requestId)) {
          throw new Error(`${config.label} request was interrupted`);
        }
        await hooks.ensureConversationBinding(request);
        const matches = hooks.userMessages().filter(
          (element) =>
            !previousUsers.has(element) &&
            canonicalizeRenderedPrompt(element.innerText) === text,
        );
        if (matches.length > 1) {
          throw new Error(`More than one matching ${config.label} user message appeared`);
        }
        if (matches.length === 1) {
          const match = matches[0];
          if (!match) continue;
          const providerMessageId = hooks.messageId(match);
          return {
            element: match,
            ...(providerMessageId ? { providerMessageId } : {}),
            previousUsers,
            text,
          };
        }
        if (!healingAttempted && now() - startedAt >= healAfterMs) {
          healingAttempted = true;
          await hooks.healDom();
        }
        await hooks.delay(pollIntervalMs);
      }
      throw new Error(`Timed out waiting for the submitted ${config.label} message`);
    };
  };

  /**
   * BB-4. Streaming what has been captured so far.
   *
   * The limit is checked against the whole captured text rather than against the increment,
   * because the limit is on what the controller will be asked to hold. Nothing is sent when the
   * text has not moved: an unchanged read is not an update.
   */
  const createStreamSender = (hooks: BachataStreamSenderHooks) =>
    async (
      request: BachataActiveRequest,
      previous: string,
      current: string,
    ): Promise<void> => {
      assertTextWithinLimit(
        current,
        hooks.maximumResponseBytes,
        `${config.label} captured response`,
      );
      const update = streamUpdate(previous, current);
      if (!update || !update.text) {
        return;
      }
      await sendBackground({
        type: "content.stream",
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        documentToken: hooks.documentToken,
        mode: update.mode,
        text: update.text,
      });
    };

  /**
   * BB-4. Watching a turn whose submission could not be verified or interrupted.
   *
   * The conversation is quarantined first, because until this settles nobody can tell whether a
   * message was sent. Then the page is watched: if it was seen busy and has since gone quiet,
   * the turn ran and finished and the quarantine is lifted; if it was never seen busy, a much
   * longer quiet is required before the document is released, and the quarantine stays, because
   * a page that never looked busy may simply not have started yet.
   */
  const createIndeterminateMonitor = (hooks: BachataIndeterminateMonitorHooks) => {
    const now = hooks.now ?? (() => Date.now());
    const settledAfterBusyMs = hooks.settledAfterBusyMs ?? 1_000;
    const settledWithoutBusyMs = hooks.settledWithoutBusyMs ?? 10_000;
    const pollIntervalMs = hooks.pollIntervalMs ?? 100;
    return async (request: {
      requestId: string;
      conversationIdentity: string;
    }): Promise<void> => {
      hooks.quarantine(request.conversationIdentity);
      let observedBusy = false;
      let idleSince: number | undefined;
      while (hooks.stillActive(request.requestId)) {
        try {
          if (hooks.isBusy()) {
            observedBusy = true;
            idleSince = undefined;
          } else {
            idleSince ??= now();
            const requiredIdleMs = observedBusy ? settledAfterBusyMs : settledWithoutBusyMs;
            if (now() - idleSince >= requiredIdleMs) {
              if (observedBusy) {
                hooks.clearQuarantine(request.conversationIdentity);
              }
              hooks.settle(request.requestId);
              return;
            }
          }
        } catch {
          idleSince = undefined;
        }
        await hooks.delay(pollIntervalMs);
      }
      hooks.forget(request.requestId);
    };
  };

  /**
   * BB-4. Whether a controller message names this document at all.
   *
   * Every field must match. A message that matched loosely would act on a conversation the
   * controller is not looking at, in a tab it did not choose.
   */
  const requestMatchesDocument = (input: {
    provider: string;
    documentToken: string;
    frameId: number;
    conversationUrl: string;
    conversationIdentity: string;
    boundProvider: string;
    boundDocumentToken: string;
    boundUrl: string;
    boundIdentity: string;
  }): boolean =>
    input.provider === input.boundProvider &&
    input.documentToken === input.boundDocumentToken &&
    input.frameId === 0 &&
    input.conversationUrl === input.boundUrl &&
    input.conversationIdentity === input.boundIdentity;

  /**
   * BB-4. Stopping a turn, and saying honestly whether it stopped.
   *
   * The boundaries this preserves are the whole point of it. A request that was never committed
   * is cancelled without touching the page, and cancelling it is enough. A request that was
   * committed must be confirmed stopped by the page itself; if it cannot be, the conversation is
   * quarantined rather than reported as interrupted, because an uninterrupted turn that is
   * believed interrupted is the one state from which a retry would duplicate a message. Nothing
   * here retries, and nothing here reports a stop it did not observe.
   */
  const createInterruptHandler = (hooks: BachataInterruptHandlerHooks) =>
    async (
      request: BachataInterruptRequest,
    ): Promise<{ interrupted: boolean; error?: string }> => {
      const active = hooks.activeRequest();
      // BR-G6-04. A Stop is matched against the turn it names, not only against the conversation
      // the page happens to be showing. An accepted first-turn transition moves the page onto
      // the conversation the provider created for this turn, while the controller's
      // authorization still names the one it sent — so the page no longer shows the conversation
      // the only party allowed to stop the turn knows about. Every other identity the document
      // check makes is still required here; only the conversation half is answered by the
      // request's own authorization instead of by the live URL.
      const namesAuthorizedConversation =
        active !== undefined &&
        active.requestId === request.requestId &&
        active.transitionUsed &&
        active.authorizedConversationIdentity === request.conversationIdentity &&
        request.provider === hooks.provider &&
        request.documentToken === hooks.documentToken &&
        request.frameId === 0;
      if (
        !namesAuthorizedConversation &&
        !requestMatchesDocument({
          provider: request.provider,
          documentToken: request.documentToken,
          frameId: request.frameId,
          conversationUrl: canonicalConversationUrl(request.conversationUrl),
          conversationIdentity: request.conversationIdentity,
          boundProvider: hooks.provider,
          boundDocumentToken: hooks.documentToken,
          boundUrl: hooks.currentUrl(),
          boundIdentity: hooks.currentIdentity(),
        })
      ) {
        return {
          interrupted: false,
          error: "The request no longer matches this browser document",
        };
      }
      if (!active) {
        hooks.rememberPreSubmit(request.requestId);
        hooks.cancelHealing();
        return { interrupted: true };
      }
      const namesActiveConversation =
        active.conversationIdentity === request.conversationIdentity ||
        namesAuthorizedConversation;
      if (
        active.requestId !== request.requestId ||
        active.documentToken !== hooks.documentToken ||
        active.frameId !== 0 ||
        !namesActiveConversation
      ) {
        return { interrupted: false, error: "The request is no longer active" };
      }
      if (!active.submissionCommitted) {
        hooks.rememberPreSubmit(request.requestId);
        hooks.cancelHealing();
        return { interrupted: true };
      }
      try {
        await hooks.ensureConversationBinding(active);
      } catch (cause) {
        hooks.quarantine(request.conversationIdentity);
        return {
          interrupted: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
      if (!(await hooks.interruptAndConfirm(request.requestId))) {
        hooks.quarantine(request.conversationIdentity);
        return {
          interrupted: false,
          error: `${config.label} did not confirm interruption`,
        };
      }
      hooks.clearQuarantine(request.conversationIdentity);
      return { interrupted: true };
    };

  return {
    canonicalizeRenderedPrompt,
    streamUpdate,
    singleNewItem,
    uniqueItem,
    utf8ByteLength,
    assertTextWithinLimit,
    canonicalConversationUrl,
    conversationIdentityFor,
    sessionIdForConversation,
    isSupportedInitialTransition,
    composeCapturedResponse,
    isBusyState,
    shouldCompleteResponse,
    completionOutcome,
    completionSettled,
    createComposerGuard,
    sendBackground,
    createRegistrationCoordinator,
    createCancellationRegistry,
    createAssetTransferDriver,
    createProviderStatusReader,
    captureResponseParts,
    createInterruptControl,
    createProviderMessageListener,
    startLifecycleObserver,
    createInterruptLease,
    createRequestTeardown,
    createComposerResolver,
    createAttachmentStaging,
    attachmentFile,
    writeStagedAttachments,
    createResponseBinder,
    createConversationBinder,
    createAssetSourceStore,
    installProviderDocument,
    createResponseActivityObserver,
    createSubmittedPromptWaiter,
    createStreamSender,
    createIndeterminateMonitor,
    requestMatchesDocument,
    createInterruptHandler,
  };
};

(globalThis as BachataProviderLogicGlobal).__pairProviderLogic = createProviderLogic;
