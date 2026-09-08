// ChatGPT's configuration of the shared provider logic. The implementation lives in
// providerLogic.ts, which is injected immediately before this file; only the transition rule
// and the provider's own name ever differed between the two providers.

type BachataChatGptAlertScope = "response" | "attachment" | "composer" | "dialog";
type BachataChatGptAlertCode =
  | "rate_limited"
  | "session_expired"
  | "subscription_unavailable"
  | "response_failed"
  | "attachment_rejected";
type BachataChatGptAlertCandidate = { scope: BachataChatGptAlertScope; text: string };
type BachataChatGptAlert = {
  code: BachataChatGptAlertCode;
  message: string;
  scope: BachataChatGptAlertScope;
};

type BachataChatGptLogic = BachataProviderLogic & {
  chatGptAlertCandidates: (sources: BachataChatGptAlertSources) => BachataChatGptAlertCandidate[];
  chatGptAlertElements: (sources: BachataChatGptAlertSources) => BachataChatGptAlertElement[];
  chatGptAlertSnapshot: (
    sources: BachataChatGptAlertSources,
  ) => Map<BachataChatGptAlertElement, string>;
  classifyChatGptAlert: (
    candidates: readonly BachataChatGptAlertCandidate[],
  ) => BachataChatGptAlert | undefined;
  chatGptAlertErrorCode: (code: BachataChatGptAlertCode) => string;
  chatGptCompletionActionVisible: (input: {
    response: BachataChatGptTurnElement;
    isVisible: (element: BachataChatGptAlertElement) => boolean;
  }) => boolean;
  chatGptTurnRoot: (response: BachataChatGptTurnElement) => BachataChatGptTurnElement;
  chatGptTurnIdentity: (response: BachataChatGptTurnElement) => string;
  chatGptTurnRootSelectors: readonly string[];
  chatGptObservationFaultVerdict: (input: {
    isTypeError: boolean;
    consecutiveFaults: number;
    maximumFaults: number;
  }) => "reobserve" | "rethrow";
};

type BachataChatGptGlobal = typeof globalThis & {
  __pairChatGptLogic?: BachataChatGptLogic;
  __pairProviderLogic?: (config: BachataProviderConfig) => BachataProviderLogic;
};

const bachataChatGptGlobal = globalThis as BachataChatGptGlobal;
const createChatGptLogic = bachataChatGptGlobal.__pairProviderLogic;
if (!createChatGptLogic) {
  throw new Error("Bachata provider logic was not initialized before the ChatGPT adapter");
}

const chatGptProviderLogic = createChatGptLogic({
  provider: "chatgpt",
  label: "ChatGPT",
  origin: "https://chatgpt.com",
  freshPathnames: ["/"],
  conversationPathPrefixes: ["/c/"],
});

// ChatGPT-specific alert taxonomy. It stays here rather than in the shared provider logic
// because the semantics and the anchors are ChatGPT's: Claude's alerts say different things in
// different places, and a shared matcher would be a guess about a provider nobody measured.
//
// Two rules hold the whole design up. A bare `[role="alert"]` never terminates a turn: every
// candidate carries the scope the adapter proved structurally, and each scope admits only the
// classes that can honestly appear there. And a candidate that matches two classes is dropped,
// not guessed, so one message can never mean two different failures.

type BachataChatGptAlertElement = {
  getAttribute: (name: string) => string | null;
  hidden?: boolean;
  innerText?: string;
  textContent?: string | null;
};

type BachataChatGptAlertRoot = {
  querySelectorAll: (selector: string) => ArrayLike<BachataChatGptAlertElement>;
};

type BachataChatGptTurnElement = BachataChatGptAlertRoot & BachataChatGptAlertElement & {
  closest: (selector: string) => BachataChatGptTurnElement | null;
};

type BachataChatGptAlertDialog = BachataChatGptAlertElement & BachataChatGptAlertRoot;

type BachataChatGptAlertSources = {
  responseRoot?: BachataChatGptAlertRoot;
  composerForm?: BachataChatGptAlertRoot;
  dialogs?: ArrayLike<BachataChatGptAlertDialog>;
  attachmentsStaged?: boolean;
  // Node, wording and revision together. Identity alone hides a reused ARIA live region that
  // rewrites itself in place; identity plus wording still hides a region that clears and then says
  // the same thing again. The adapter stamps a revision per alert node from its own mutation
  // observer, so "same node, same words, untouched since" is the only thing that stays ignored.
  ignoreElements?: { get: (element: BachataChatGptAlertElement) => string | undefined };
  // Defaults to the alert's own text, which is what a DOM-free test can supply.
  alertToken?: (element: BachataChatGptAlertElement, text: string) => string;
  isVisible?: (element: BachataChatGptAlertElement) => boolean;
};

const chatGptAlertRoleSelector = '[role="alert"], [role="status"]';
const chatGptAlertTextLimit = 240;

const chatGptAlertPatterns: ReadonlyArray<{
  code: BachataChatGptAlertCode;
  matches: (text: string) => boolean;
}> = [
  {
    code: "rate_limited",
    matches: (text) =>
      /\btoo many requests\b/.test(text)
      || /\brate[- ]limit(?:ed|ing)?\b/.test(text)
      || (/\blimit\b/.test(text)
        && /\b(?:messages?|requests?|usage|plan)\b/.test(text)
        && /\b(?:reached|exceeded|hit)\b/.test(text)),
  },
  {
    code: "session_expired",
    matches: (text) =>
      /\bsession (?:has )?expired\b/.test(text)
      || /\b(?:log|sign) ?(?:in|back in) again\b/.test(text)
      || /\byou(?:'re| are) (?:signed|logged) out\b/.test(text),
  },
  {
    code: "subscription_unavailable",
    matches: (text) =>
      /\bsubscription\b/.test(text)
      && /\b(?:unavailable|could ?n[o']?t|couldn't|failed|error)\b/.test(text),
  },
  {
    code: "response_failed",
    matches: (text) =>
      /\bsomething went wrong\b/.test(text)
      || /\ban error (?:occurred|has occurred)\b/.test(text)
      || /\berror (?:generating|while generating)\b/.test(text)
      || /\bfailed to (?:generate|get) (?:a )?response\b/.test(text),
  },
  {
    code: "attachment_rejected",
    matches: (text) =>
      /\bunsupported file type\b/.test(text)
      || (/\b(?:file|image|attachment|upload(?:ing)?)\b/.test(text)
        && /\b(?:failed|not supported|unsupported|too large|exceeds|could ?n[o']?t|couldn't)\b/.test(text)),
  },
];

// Each scope admits only what can honestly appear in it. An account-level modal cannot fail one
// response, and an in-thread error cannot prove the account is signed out.
const chatGptAlertScopeCodes: Readonly<Record<BachataChatGptAlertScope, readonly BachataChatGptAlertCode[]>> = {
  response: ["response_failed", "rate_limited"],
  attachment: ["attachment_rejected"],
  composer: ["rate_limited", "attachment_rejected"],
  dialog: ["rate_limited", "session_expired", "subscription_unavailable"],
};

const chatGptAlertScopeOrder: readonly BachataChatGptAlertScope[] = [
  "response",
  "attachment",
  "composer",
  "dialog",
];

const chatGptAlertWireCodes: Readonly<Record<BachataChatGptAlertCode, string>> = {
  rate_limited: "PROVIDER_RATE_LIMITED",
  session_expired: "PROVIDER_SESSION_EXPIRED",
  subscription_unavailable: "PROVIDER_SUBSCRIPTION_UNAVAILABLE",
  response_failed: "PROVIDER_RESPONSE_FAILED",
  attachment_rejected: "PROVIDER_ATTACHMENT_REJECTED",
};

const chatGptAlertText = (element: BachataChatGptAlertElement): string => {
  const raw = element.innerText ?? element.textContent ?? "";
  const collapsed = String(raw).replace(/\s+/g, " ").trim();
  return collapsed.length > chatGptAlertTextLimit
    ? `${collapsed.slice(0, chatGptAlertTextLimit)}…`
    : collapsed;
};

// The attribute checks are what a DOM-free test can assert. Computed style and hidden ancestors
// need the real document, so the adapter supplies that half through `isVisible`; without it this
// stays attribute-only rather than pretending to know more than it can see.
const chatGptAlertVisible = (
  element: BachataChatGptAlertElement,
  isVisible?: (element: BachataChatGptAlertElement) => boolean,
): boolean =>
  element.hidden !== true
  && element.getAttribute("aria-hidden") !== "true"
  && (isVisible?.(element) ?? true);

const chatGptAlertElementsIn = (
  root: BachataChatGptAlertRoot | undefined,
  isVisible?: (element: BachataChatGptAlertElement) => boolean,
): BachataChatGptAlertElement[] =>
  root
    ? Array.from(root.querySelectorAll(chatGptAlertRoleSelector))
      .filter((element) => chatGptAlertVisible(element, isVisible))
    : [];

// The one traversal both the snapshot and the classification use, so what is remembered and what
// is later compared can never drift apart.
const chatGptAlertRegions = (
  sources: BachataChatGptAlertSources,
): Array<{ element: BachataChatGptAlertElement; scope: BachataChatGptAlertScope }> => {
  const composerScope: BachataChatGptAlertScope = sources.attachmentsStaged === true
    ? "attachment"
    : "composer";
  const isVisible = sources.isVisible;
  return [
    ...chatGptAlertElementsIn(sources.responseRoot, isVisible).map((element) => ({
      element,
      scope: "response" as const,
    })),
    ...chatGptAlertElementsIn(sources.composerForm, isVisible).map((element) => ({
      element,
      scope: composerScope,
    })),
    // A dialog is a container, not an alert. Its own text is a whole modal — heading, body,
    // buttons, legal copy — and classifying that blob would let any wording anywhere in a modal
    // decide a turn. Only an alert or status region inside it speaks for the provider.
    ...Array.from(sources.dialogs ?? [])
      .filter((dialog) => chatGptAlertVisible(dialog, isVisible))
      .flatMap((dialog) => chatGptAlertElementsIn(dialog, isVisible).map((element) => ({
        element,
        scope: "dialog" as const,
      }))),
  ];
};

const chatGptAlertElements = (
  sources: BachataChatGptAlertSources,
): BachataChatGptAlertElement[] => chatGptAlertRegions(sources).map((region) => region.element);

// Structural scope is decided here, from roots the adapter already owns: the response it bound,
// the composer's own form, and modal dialogs. Nothing is collected from the page at large.
const chatGptAlertTokenFor = (
  sources: BachataChatGptAlertSources,
  element: BachataChatGptAlertElement,
  text: string,
): string => sources.alertToken?.(element, text) ?? text;

const chatGptAlertCandidates = (
  sources: BachataChatGptAlertSources,
): BachataChatGptAlertCandidate[] => {
  const ignored = sources.ignoreElements;
  return chatGptAlertRegions(sources)
    .map((region) => ({ region, text: chatGptAlertText(region.element) }))
    .filter(({ region, text }) => (
      ignored?.get(region.element) !== chatGptAlertTokenFor(sources, region.element, text)
    ))
    .map(({ region, text }) => ({ scope: region.scope, text }))
    .filter((candidate) => candidate.text.length > 0);
};

// What an adapter remembers before an action: each alert node with a token standing for the words
// it was showing and the state it was in.
const chatGptAlertSnapshot = (
  sources: BachataChatGptAlertSources,
): Map<BachataChatGptAlertElement, string> => new Map(
  chatGptAlertRegions(sources).map((region) => [
    region.element,
    chatGptAlertTokenFor(sources, region.element, chatGptAlertText(region.element)),
  ]),
);

const chatGptAlertCodeFor = (
  candidate: BachataChatGptAlertCandidate,
): BachataChatGptAlertCode | undefined => {
  const text = candidate.text.toLowerCase();
  const allowed = chatGptAlertScopeCodes[candidate.scope];
  const matched = chatGptAlertPatterns
    .filter((pattern) => pattern.matches(text))
    .map((pattern) => pattern.code);
  // Ambiguity is not a tie to break: an upload that "went wrong" is both a failed response and a
  // rejected attachment by wording alone, and naming one of them would be a guess.
  if (matched.length !== 1) return undefined;
  const [code] = matched;
  return code !== undefined && allowed.includes(code) ? code : undefined;
};

// Two visible alerts that classify differently are not a priority question. Scope order says
// which one is closest to the turn, not which one is true, and picking by position would let a
// stale account banner and a fresh response error take turns deciding. One code, or none.
const classifyChatGptAlert = (
  candidates: readonly BachataChatGptAlertCandidate[],
): BachataChatGptAlert | undefined => {
  const classified: BachataChatGptAlert[] = [];
  for (const scope of chatGptAlertScopeOrder) {
    for (const candidate of candidates) {
      if (candidate.scope !== scope) continue;
      const code = chatGptAlertCodeFor(candidate);
      if (code) classified.push({ code, message: candidate.text, scope });
    }
  }
  const codes = new Set(classified.map((alert) => alert.code));
  return codes.size === 1 ? classified[0] : undefined;
};

const chatGptAlertErrorCode = (code: BachataChatGptAlertCode): string =>
  chatGptAlertWireCodes[code];

// ChatGPT renders a turn's own actions only once that turn has ended, so a visible one is the
// provider stating the answer is final instead of this adapter inferring it from silence.
//
// The search never leaves the turn holding the bound response. An action belonging to an earlier
// answer is evidence about that answer, and the page always has several. Where the turn container
// cannot be found the bound response is the root, which is narrower still; the document is never
// searched, so a missing container costs evidence rather than borrowing someone else's.
const chatGptCompletionActionSelectors = [
  "button[data-testid='copy-turn-action-button']",
];
const chatGptTurnContainerSelectors = [
  "article[data-testid^='conversation-turn-']",
];

// One definition of "the turn holding this response", used both to scope the end-of-turn control
// and to notice the response being reparented into a different turn.
const chatGptTurnRoot = (response: BachataChatGptTurnElement): BachataChatGptTurnElement =>
  chatGptTurnContainerSelectors
    .map((selector) => response.closest(selector))
    .find((element): element is BachataChatGptTurnElement => Boolean(element))
  ?? response;

const chatGptTurnIdentity = (response: BachataChatGptTurnElement): string => {
  const root = chatGptTurnRoot(response);
  return root === response ? "" : root.getAttribute("data-testid") ?? "";
};

const chatGptCompletionActionVisible = (input: {
  response: BachataChatGptTurnElement;
  isVisible: (element: BachataChatGptAlertElement) => boolean;
}): boolean =>
  chatGptCompletionActionSelectors
    .flatMap((selector) => Array.from(chatGptTurnRoot(input.response).querySelectorAll(selector)))
    .some((element) => input.isVisible(element));

// A `TypeError` raised while reading the page is a defect in this adapter, not evidence about
// ChatGPT. Ending the turn on one discards an answer the provider already produced and that no
// retry may ask for again, so a bounded number of consecutive reader faults are re-observed
// instead. The budget is consecutive: any successful observation clears it, and exhausting it
// still fails with the original fault, through the ordinary terminal path.
//
// Only a `TypeError` qualifies. Every other failure - a changed conversation, a provider alert,
// a cancelled or expired request, a stream or serialization failure - is the page or the protocol
// speaking, and is answered immediately.
const chatGptObservationFaultVerdict = (input: {
  isTypeError: boolean;
  consecutiveFaults: number;
  maximumFaults: number;
}): "reobserve" | "rethrow" =>
  input.isTypeError && input.consecutiveFaults <= input.maximumFaults ? "reobserve" : "rethrow";

bachataChatGptGlobal.__pairChatGptLogic = {
  ...chatGptProviderLogic,
  chatGptAlertCandidates,
  chatGptAlertElements,
  chatGptAlertSnapshot,
  classifyChatGptAlert,
  chatGptAlertErrorCode,
  chatGptCompletionActionVisible,
  chatGptTurnRoot,
  chatGptTurnIdentity,
  chatGptTurnRootSelectors: chatGptTurnContainerSelectors,
  chatGptObservationFaultVerdict,
};
