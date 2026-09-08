type BachataAttachmentControlResolution = {
  button: HTMLButtonElement;
  acceptsDetachedInput: boolean;
};

type BachataResolvedControlWait<T> = {
  /** Resolves the control, or throws when the page offers more than one candidate. */
  resolve: () => T | undefined;
  /** An extra condition the resolved control must satisfy, such as being enabled. */
  accept?: ((value: T) => boolean) | undefined;
  /** One repair attempt, run once before the loop settles into polling. */
  heal: () => Promise<unknown>;
  delay: (delayMs: number) => Promise<void>;
  pollIntervalMs: number;
  timeoutMs: number;
  /** Whether the caller has stopped caring: a cancelled request, or its own deadline. */
  abandoned?: (() => boolean) | undefined;
  now?: (() => number) | undefined;
};

type BachataProviderControls = {
  waitForResolvedControl: <T>(
    options: BachataResolvedControlWait<T>,
  ) => Promise<T | undefined>;
  eligibleAttachmentInputs: (page: ParentNode) => HTMLInputElement[];
  queryUniqueWithin: <T extends Element>(
    root: Element | undefined,
    selectors: readonly string[],
    ambiguityMessage: string,
  ) => T | undefined;
  resolveExistingAttachmentInput: (options: {
    root: Element;
    inputs: readonly HTMLInputElement[];
    selected?: HTMLInputElement | undefined;
  }) => HTMLInputElement | undefined;
  resolveAttachmentControl: (options: {
    provider: string;
    root: Element;
    page: ParentNode;
    associatedSelectors: readonly string[];
    trustedDetachedSelectors?: readonly string[] | undefined;
  }) => BachataAttachmentControlResolution | undefined;
  resolveIntroducedAttachmentInput: (options: {
    provider: string;
    root: Element;
    introduced: readonly HTMLInputElement[];
    acceptsDetachedInput: boolean;
  }) => HTMLInputElement | undefined;
  conversationQuarantineState: (
    provider: string,
    conversationIdentity: string,
  ) => Promise<BachataQuarantineState>;
  conversationIsQuarantined: (provider: string, conversationIdentity: string) => Promise<boolean>;
  quarantineConversation: (provider: string, conversationIdentity: string) => void;
  clearConversationQuarantine: (provider: string, conversationIdentity: string) => void;
};

type BachataProviderControlsGlobal = typeof globalThis & {
  __pairProviderControls?: BachataProviderControls;
};

const uniqueElements = <T extends Element>(elements: readonly T[]): T[] =>
  Array.from(new Set(elements));

const queryButtons = (
  root: ParentNode,
  selectors: readonly string[],
): HTMLButtonElement[] =>
  uniqueElements(
    selectors.flatMap((selector) =>
      Array.from(root.querySelectorAll<HTMLButtonElement>(selector)),
    ),
  ).filter((button) => !button.disabled);


const eligibleAttachmentInputs: BachataProviderControls["eligibleAttachmentInputs"] = (
  page,
) =>
  Array.from(page.querySelectorAll<HTMLInputElement>("input[type='file']")).filter(
    (input) =>
      !input.disabled &&
      (!input.accept ||
        input.accept.includes("image") ||
        input.accept.includes("*/*")),
  );

const queryUniqueWithin = <T extends Element>(
  root: Element | undefined,
  selectors: readonly string[],
  ambiguityMessage: string,
): T | undefined => {
  if (!root) {
    return undefined;
  }
  const elements = uniqueElements(
    selectors.flatMap((selector) =>
      Array.from(root.querySelectorAll<T>(selector)),
    ),
  );
  if (elements.length > 1) {
    throw new Error(ambiguityMessage);
  }
  return elements[0];
};


const resolveExistingAttachmentInput: BachataProviderControls["resolveExistingAttachmentInput"] = (
  options,
) => {
  if (options.selected && options.inputs.includes(options.selected)) {
    return options.selected;
  }
  const associated = options.inputs.filter((input) => options.root.contains(input));
  return associated.length === 1 ? associated[0] : undefined;
};

const resolveAttachmentControl: BachataProviderControls["resolveAttachmentControl"] = (
  options,
) => {
  const associated = queryButtons(options.root, options.associatedSelectors);
  if (associated.length > 1) {
    throw new Error(`${options.provider} composer contains ambiguous attachment controls`);
  }
  // Branch on the element, not on `length`. Testing the length and then re-testing the
  // element for `undefined` is two branches where only one can ever be taken, so the second
  // is unreachable and can never be covered. Destructuring narrows and decides at once.
  const [associatedButton] = associated;
  if (associatedButton) {
    return {
      button: associatedButton,
      acceptsDetachedInput: false,
    };
  }

  const trustedDetached = queryButtons(
    options.page,
    options.trustedDetachedSelectors ?? [],
  ).filter((button) => !options.root.contains(button));
  if (trustedDetached.length > 1) {
    throw new Error(
      `${options.provider} page contains ambiguous trusted attachment controls`,
    );
  }
  const [detachedButton] = trustedDetached;
  if (!detachedButton) {
    return undefined;
  }
  return {
    button: detachedButton,
    acceptsDetachedInput: true,
  };
};

const resolveIntroducedAttachmentInput: BachataProviderControls["resolveIntroducedAttachmentInput"] = (
  options,
) => {
  const eligible = options.acceptsDetachedInput
    ? [...options.introduced]
    : options.introduced.filter((input) => options.root.contains(input));
  if (eligible.length > 1) {
    throw new Error(`${options.provider} page introduced ambiguous attachment inputs`);
  }
  if (eligible.length === 1) {
    return eligible[0];
  }
  if (!options.acceptsDetachedInput && options.introduced.length > 0) {
    throw new Error(
      `${options.provider} attachment control introduced an input outside the composer`,
    );
  }
  return undefined;
};


/*
 * The quarantine verdict is owned by the background service worker, in chrome.storage.session.
 * It used to live in this page's own sessionStorage, which the provider page can rewrite: a
 * valid `{}` overwrite replaced the in-memory copy too, and a clear plus reload dropped it,
 * so a conversation the extension had ruled unsafe came back as "confirmed". The local map
 * below is a cache for synchronous writers, never the authority.
 */
type BachataQuarantineResponse = { ok?: boolean; value?: unknown; error?: string };
type BachataQuarantineState = "quarantined" | "clear" | "unavailable";

const quarantineCache = new Map<string, Set<string>>();
// Positives whose SET the authority never acknowledged. Nothing waits on that acknowledgement:
// SET is sent fire-and-forget, and the caller has already moved on. This set is the only thing that
// observes the answer, and it is realm-local: a reload discards it. What survives that reload is
// whatever the authority managed to keep — a durable record, an overflow marker, or a hold in
// worker memory — and if the message never reached the background at all, nothing did.
//
// So an authority answering "false" for one of these is not proof of a release: the SET may never
// have reached it. Only an acknowledged clear releases what is in here.
const unacknowledgedQuarantines = new Map<string, Set<string>>();

const setFor = (
  store: Map<string, Set<string>>,
  provider: string,
): Set<string> => {
  const existing = store.get(provider);
  if (existing) return existing;
  const created = new Set<string>();
  store.set(provider, created);
  return created;
};

const quarantineCacheFor = (provider: string): Set<string> => setFor(quarantineCache, provider);

const unacknowledgedFor = (provider: string): Set<string> =>
  setFor(unacknowledgedQuarantines, provider);

const validQuarantineTarget = (provider: string, conversationIdentity: string): boolean =>
  typeof provider === "string" && provider.length > 0
  && typeof conversationIdentity === "string" && conversationIdentity.length > 0;

const sendQuarantine = async (
  type: string,
  provider: string,
  conversationIdentity: string,
): Promise<BachataQuarantineResponse | undefined> => {
  try {
    return await chrome.runtime.sendMessage({
      type,
      provider,
      conversationIdentity,
    }) as BachataQuarantineResponse | undefined;
  } catch {
    return undefined;
  }
};

// Three answers, because "the authority could not answer" is not "the authority said clear".
// Only a read-confirmed clear may delete a cached positive, and an unavailable authority blocks
// a send whether or not this realm happens to hold a cached verdict: a fresh document, a new
// conversation identity, or a cleared cache must not be a way around it.
const conversationQuarantineState = async (
  provider: string,
  conversationIdentity: string,
): Promise<BachataQuarantineState> => {
  // A target this client cannot name is not a conversation it can call clear either.
  if (!validQuarantineTarget(provider, conversationIdentity)) return "unavailable";
  const response = await sendQuarantine("BACHATA_QUARANTINE_IS", provider, conversationIdentity);
  if (response?.ok === true && typeof response.value === "boolean") {
    if (response.value) {
      quarantineCacheFor(provider).add(conversationIdentity);
      return "quarantined";
    }
    if (unacknowledgedFor(provider).has(conversationIdentity)) return "quarantined";
    quarantineCacheFor(provider).delete(conversationIdentity);
    return "clear";
  }
  return "unavailable";
};

const conversationIsQuarantined = async (
  provider: string,
  conversationIdentity: string,
): Promise<boolean> =>
  (await conversationQuarantineState(provider, conversationIdentity)) !== "clear";

const quarantineConversation = (
  provider: string,
  conversationIdentity: string,
): void => {
  if (!validQuarantineTarget(provider, conversationIdentity)) return;
  quarantineCacheFor(provider).add(conversationIdentity);
  unacknowledgedFor(provider).add(conversationIdentity);
  void sendQuarantine("BACHATA_QUARANTINE_SET", provider, conversationIdentity).then((response) => {
    if (response?.ok === true) unacknowledgedFor(provider).delete(conversationIdentity);
  });
};

// Only a clear the authority acknowledged releases the local positive. Dropping it on the way out
// would release a verdict that is still held, or one that never reached the authority at all.
const clearConversationQuarantine = (
  provider: string,
  conversationIdentity: string,
): void => {
  if (!validQuarantineTarget(provider, conversationIdentity)) return;
  void sendQuarantine("BACHATA_QUARANTINE_CLEAR", provider, conversationIdentity).then((response) => {
    if (response?.ok !== true) return;
    quarantineCacheFor(provider).delete(conversationIdentity);
    unacknowledgedFor(provider).delete(conversationIdentity);
  });
};

/**
 * Waits for a provider control both providers need: the send button and the stop button.
 *
 * The resolver throws when the page shows more than one candidate and no healed binding
 * settles it. Ambiguity is not a resolved control, so it is absorbed and the wait continues:
 * one repair attempt runs, then polling, and an unresolved control reaches the caller as
 * `undefined` at the deadline. The wait never returns a guess.
 */
const waitForResolvedControl: BachataProviderControls["waitForResolvedControl"] = async (
  options,
) => {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let healingAttempted = false;
  while (now() < deadline) {
    if (options.abandoned?.()) {
      return undefined;
    }
    try {
      const value = options.resolve();
      if (value !== undefined && (options.accept ? options.accept(value) : true)) {
        return value;
      }
    } catch {
      // BB-AUD-10. An ambiguous control is not a control. Absorbed so the repair attempt and
      // the deadline below decide, rather than the first page state that happened to throw.
    }
    if (!healingAttempted) {
      healingAttempted = true;
      await options.heal();
      continue;
    }
    await options.delay(options.pollIntervalMs);
  }
  return undefined;
};

const bachataProviderControls: BachataProviderControls = {
  waitForResolvedControl,
  eligibleAttachmentInputs,
  queryUniqueWithin,
  resolveExistingAttachmentInput,
  resolveAttachmentControl,
  resolveIntroducedAttachmentInput,
  conversationQuarantineState,
  conversationIsQuarantined,
  quarantineConversation,
  clearConversationQuarantine,
};

(globalThis as BachataProviderControlsGlobal).__pairProviderControls = bachataProviderControls;
