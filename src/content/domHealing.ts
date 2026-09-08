type BachataDomHealingProvider = "chatgpt" | "claude";
type BachataDomHealingCandidate = {
  id: string;
  kindHint: "composer" | "conversationRoot" | "sendButton" | "stopButton" | "message" | "unknown";
  tag: string;
  role?: string | undefined;
  accessibleName?: string | undefined;
  placeholder?: string | undefined;
  textPreview?: string | undefined;
  contentEditable: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
  domOrder: number;
};
type BachataDomHealingDecision = {
  protocol: "bachata-dom-heal-v1";
  status: "selected" | "ambiguous" | "unsupported";
  composerIds: string[];
  conversationRootIds: string[];
  sendButtonIds: string[];
  stopButtonIds: string[];
};
type BachataDomHealingSelection = {
  composer: HTMLTextAreaElement | HTMLInputElement | HTMLElement;
  conversationRoot: HTMLElement;
  sendButton?: HTMLElement | undefined;
  stopButton?: HTMLElement | undefined;
};
type BachataDomHealingApi = {
  heal: (provider: BachataDomHealingProvider, force?: boolean, deadlineAt?: number) => Promise<boolean>;
  cancel: (provider: BachataDomHealingProvider) => void;
  cached: (provider: BachataDomHealingProvider) => BachataDomHealingSelection | undefined;
  messageElements: (provider: BachataDomHealingProvider) => HTMLElement[];
  invalidate: (provider: BachataDomHealingProvider) => void;
};
type BachataDomHealingGlobal = typeof globalThis & {
  __pairDomHealing?: BachataDomHealingApi;
};

(() => {
  const globalState = globalThis as BachataDomHealingGlobal;
  if (globalState.__pairDomHealing) return;

  const selections = new Map<BachataDomHealingProvider, BachataDomHealingSelection>();
  const persistedSelectionKey = (provider: BachataDomHealingProvider): string => `bachata.domHealing.${provider}.v1`;
  const attempts = new Map<BachataDomHealingProvider, { key: string; count: number; nextAllowedAt: number }>();
  const pending = new Map<BachataDomHealingProvider, Promise<boolean>>();
  const activeHealingRequestIds = new Map<BachataDomHealingProvider, string>();
  const cancelGenerations = new Map<BachataDomHealingProvider, number>();
  const maximumAttempts = 3;
  const retryDelayMs = 1_500;

  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const nameOf = (element: HTMLElement): string => (
    element.getAttribute("aria-label")
    ?? element.getAttribute("title")
    ?? element.getAttribute("name")
    ?? element.textContent
    ?? ""
  ).trim().replace(/\s+/g, " ").slice(0, 256);

  const kindHint = (element: HTMLElement): BachataDomHealingCandidate["kindHint"] => {
    if (element instanceof HTMLTextAreaElement
      || (element instanceof HTMLInputElement && (!element.type || element.type === "text"))
      || element.isContentEditable
      || element.getAttribute("role") === "textbox") return "composer";
    if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
      const name = nameOf(element).toLowerCase();
      if (/\b(stop|cancel)\b/.test(name)) return "stopButton";
      if (/\b(send|submit|ask|run)\b/.test(name)) return "sendButton";
    }
    if (element.matches("main,[role=main],[role=feed],[role=log],[data-testid*='conversation' i]")) return "conversationRoot";
    if (element.matches("article,[role=article],[data-message-author-role],[data-testid*='message' i]")) return "message";
    return "unknown";
  };

  const score = (element: HTMLElement): number => {
    const hint = kindHint(element);
    const rect = element.getBoundingClientRect();
    let value = hint === "unknown" ? 0 : 100;
    if (hint === "composer" && rect.bottom > innerHeight * 0.5) value += 60;
    if (hint === "conversationRoot" && rect.height > innerHeight * 0.3) value += 50;
    if (element.hasAttribute("aria-label") || element.hasAttribute("placeholder") || element.hasAttribute("data-testid")) value += 20;
    return value + Math.min(30, Math.floor(rect.width / 100));
  };

  const collect = (): Map<string, { element: HTMLElement; candidate: BachataDomHealingCandidate }> => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>([
      "textarea", "input[type=text]", "[contenteditable=true]", "[role=textbox]",
      "button", "[role=button]", "main", "[role=main]", "[role=feed]", "[role=log]",
      "[data-testid*='conversation' i]", "article", "[role=article]", "[data-message-author-role]", "[data-testid*='message' i]",
    ].join(",")))
      .filter(visible)
      .sort((left, right) => score(right) - score(left))
      .slice(0, 32);
    const result = new Map<string, { element: HTMLElement; candidate: BachataDomHealingCandidate }>();
    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const id = `c${String(index + 1)}`;
      result.set(id, {
        element,
        candidate: {
          id,
          kindHint: kindHint(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") ?? undefined,
          accessibleName: nameOf(element) || undefined,
          placeholder: element.getAttribute("placeholder")?.slice(0, 256),
          textPreview: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 512),
          contentEditable: element.isContentEditable,
          visible: true,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          domOrder: index,
        },
      });
    });
    return result;
  };

  const buildPrompt = (provider: BachataDomHealingProvider, candidates: BachataDomHealingCandidate[]): string => JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    provider,
    instruction: "The provider's built-in DOM locators failed. Select only supplied candidate IDs for the prompt composer, the conversation region, and optional Send/Stop buttons. Never return CSS, XPath, JavaScript, URLs, coordinates, or new IDs. Return ambiguous when uncertain.",
    candidates,
    output: {
      protocol: "bachata-dom-heal-v1",
      status: "selected | ambiguous | unsupported",
      composerIds: [],
      conversationRootIds: [],
      sendButtonIds: [],
      stopButtonIds: [],
    },
  });

  const parseDecision = (
    text: string,
    candidates: ReadonlyMap<string, { element: HTMLElement; candidate: BachataDomHealingCandidate }>,
  ): BachataDomHealingDecision | undefined => {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let value: unknown;
    try { value = JSON.parse(cleaned); } catch { return undefined; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.protocol !== "bachata-dom-heal-v1"
      || (record.status !== "selected" && record.status !== "ambiguous" && record.status !== "unsupported")) return undefined;
    const readIds = (key: string, max: number, expectedKind: BachataDomHealingCandidate["kindHint"]): string[] | undefined => {
      const ids = record[key];
      if (!Array.isArray(ids) || ids.length > max) return undefined;
      const unique = [...new Set(ids as unknown[])];
      if (unique.some((id) => typeof id !== "string" || candidates.get(id)?.candidate.kindHint !== expectedKind)) return undefined;
      return unique as string[];
    };
    const composerIds = readIds("composerIds", 2, "composer");
    const conversationRootIds = readIds("conversationRootIds", 2, "conversationRoot");
    const sendButtonIds = readIds("sendButtonIds", 2, "sendButton");
    const stopButtonIds = readIds("stopButtonIds", 2, "stopButton");
    if (!composerIds || !conversationRootIds || !sendButtonIds || !stopButtonIds) return undefined;
    if (record.status === "selected" && (composerIds.length !== 1 || conversationRootIds.length !== 1 || sendButtonIds.length > 1 || stopButtonIds.length > 1)) return undefined;
    return { protocol: "bachata-dom-heal-v1", status: record.status, composerIds, conversationRootIds, sendButtonIds, stopButtonIds };
  };

  const documentKey = (): string => `${String(performance.timeOrigin)}:${location.origin}${location.pathname}`;

  const selectorFor = (element: HTMLElement): string | undefined => {
    const unique = (selector: string): string | undefined => {
      try { return document.querySelectorAll(selector).length === 1 ? selector : undefined; } catch { return undefined; }
    };
    if (element.id) {
      const selected = unique(`#${CSS.escape(element.id)}`);
      if (selected) return selected;
    }
    for (const attribute of ["data-testid", "data-test", "data-qa", "aria-label", "name", "placeholder", "role"]) {
      const value = element.getAttribute(attribute);
      if (!value || value.length > 256) continue;
      const selected = unique(`${element.tagName.toLowerCase()}[${CSS.escape(attribute)}="${CSS.escape(value)}"]`);
      if (selected) return selected;
    }
    const parts: string[] = [];
    let current: HTMLElement | null = element;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      const node: HTMLElement = current;
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      const peers = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      const position = peers.indexOf(node) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${String(position)})`);
      const selected = unique(parts.join(" > "));
      if (selected) return selected;
      current = parent;
    }
    return undefined;
  };

  const persistSelection = (provider: BachataDomHealingProvider, selection: BachataDomHealingSelection): void => {
    const composer = selectorFor(selection.composer);
    const conversationRoot = selectorFor(selection.conversationRoot);
    if (!composer || !conversationRoot) return;
    const sendButton = selection.sendButton ? selectorFor(selection.sendButton) : undefined;
    const stopButton = selection.stopButton ? selectorFor(selection.stopButton) : undefined;
    const value = {
      composer,
      conversationRoot,
      ...(sendButton ? { sendButton } : {}),
      ...(stopButton ? { stopButton } : {}),
    };
    // BB-AUD-10. The persisted selection is a cache that saves one healing pass after a
    // reload. Storage that refuses to write — private mode, quota, storage disabled — costs
    // that pass and nothing else, because every restored selector is re-resolved and
    // re-classified against the live DOM before it is used.
    try {
      sessionStorage.setItem(persistedSelectionKey(provider), JSON.stringify(value));
    } catch {
      // Absorbed: the next document heals from scratch.
    }
  };

  const restoreSelection = (provider: BachataDomHealingProvider): BachataDomHealingSelection | undefined => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(persistedSelectionKey(provider)); } catch { return undefined; }
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const resolve = (key: string): HTMLElement | undefined => {
        const selector = value[key];
        if (typeof selector !== "string") return undefined;
        const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible);
        return elements.length === 1 ? elements[0] : undefined;
      };
      const composer = resolve("composer");
      const conversationRoot = resolve("conversationRoot");
      const sendButton = resolve("sendButton");
      const stopButton = resolve("stopButton");
      if (!composer || !conversationRoot) return undefined;
      const restored: BachataDomHealingSelection = {
        composer,
        conversationRoot,
        ...(sendButton ? { sendButton } : {}),
        ...(stopButton ? { stopButton } : {}),
      };
      return rolesIntact(restored) ? restored : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * BB-A4-F12. A cached control is offered only while it still reads as the control it was bound
   * as. Both providers show one composer button whose accessible name toggles between Stop and
   * Send on the same node, so a node bound while generating stays connected after the turn ends
   * and was handed back as Stop for the rest of the document's life. Connection is liveness, not
   * role, and only `kindHint` answers role.
   *
   * The filter deliberately does not clear the field: the same node legitimately reads as Stop
   * again when the next turn starts, and clearing it would strand the binding until a forced
   * re-heal.
   */
  const liveSelection = (
    selection: BachataDomHealingSelection,
  ): BachataDomHealingSelection | undefined => {
    if (kindHint(selection.composer) !== "composer") return undefined;
    if (kindHint(selection.conversationRoot) !== "conversationRoot") return undefined;
    const sendButton = selection.sendButton && kindHint(selection.sendButton) === "sendButton"
      ? selection.sendButton
      : undefined;
    const stopButton = selection.stopButton && kindHint(selection.stopButton) === "stopButton"
      ? selection.stopButton
      : undefined;
    return {
      composer: selection.composer,
      conversationRoot: selection.conversationRoot,
      ...(sendButton ? { sendButton } : {}),
      ...(stopButton ? { stopButton } : {}),
    };
  };

  /** BB-A4-F12. The strict bind-time reading of the same rule: any contradiction rejects. */
  const rolesIntact = (selection: BachataDomHealingSelection): boolean => {
    const live = liveSelection(selection);
    return live !== undefined
      && Boolean(live.sendButton) === Boolean(selection.sendButton)
      && Boolean(live.stopButton) === Boolean(selection.stopButton);
  };

  const liveFromMemory = (
    provider: BachataDomHealingProvider,
  ): BachataDomHealingSelection | undefined => {
    const selection = selections.get(provider);
    if (!selection || !selection.composer.isConnected || !selection.conversationRoot.isConnected) {
      return undefined;
    }
    if (selection.sendButton && !selection.sendButton.isConnected) selection.sendButton = undefined;
    if (selection.stopButton && !selection.stopButton.isConnected) selection.stopButton = undefined;
    return liveSelection(selection);
  };

  const cached = (provider: BachataDomHealingProvider): BachataDomHealingSelection | undefined => {
    const live = liveFromMemory(provider);
    if (live) return live;
    selections.delete(provider);
    const restored = restoreSelection(provider);
    if (!restored) return undefined;
    selections.set(provider, restored);
    return restored;
  };

  const heal = async (provider: BachataDomHealingProvider, force = false, deadlineAt?: number): Promise<boolean> => {
    if (!force && cached(provider)) return true;
    const existing = pending.get(provider);
    if (existing) return await existing;
    const generation = cancelGenerations.get(provider) ?? 0;
    const operation = (async (): Promise<boolean> => {
      const key = documentKey();
      const prior = attempts.get(provider);
      const state = prior?.key === key ? prior : { key, count: 0, nextAllowedAt: 0 };
      if (state.count >= maximumAttempts) return false;
      if (Date.now() < state.nextAllowedAt) return false;
      const candidates = collect();
      if (candidates.size < 2) return false;
      state.count += 1;
      state.nextAllowedAt = Date.now() + retryDelayMs;
      attempts.set(provider, state);
      if ((cancelGenerations.get(provider) ?? 0) !== generation) return false;
      const requestId = crypto.randomUUID();
      activeHealingRequestIds.set(provider, requestId);
      const cancel = (): void => { void chrome.runtime.sendMessage({ type: "BACHATA_LOCAL_MODEL_CANCEL", requestId }).catch(() => undefined); };
      addEventListener("pagehide", cancel, { once: true });
      let response: Record<string, unknown> | undefined;
      try {
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) return false;
        response = await chrome.runtime.sendMessage({
          type: "BACHATA_LOCAL_MODEL_PROMPT",
          requestId,
          prompt: buildPrompt(provider, [...candidates.values()].map((entry) => entry.candidate)),
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        }) as Record<string, unknown> | undefined;
      } finally {
        removeEventListener("pagehide", cancel);
        if (activeHealingRequestIds.get(provider) === requestId) activeHealingRequestIds.delete(provider);
      }
      if ((cancelGenerations.get(provider) ?? 0) !== generation) return false;
      if (!response || response.ok !== true || typeof response.text !== "string") return false;
      const decision = parseDecision(response.text, candidates);
      if (!decision || decision.status !== "selected") return false;
      const composerId = decision.composerIds[0];
      const conversationRootId = decision.conversationRootIds[0];
      const sendId = decision.sendButtonIds[0];
      const stopId = decision.stopButtonIds[0];
      const composer = composerId ? candidates.get(composerId)?.element : undefined;
      const conversationRoot = conversationRootId ? candidates.get(conversationRootId)?.element : undefined;
      const send = sendId ? candidates.get(sendId)?.element : undefined;
      const stop = stopId ? candidates.get(stopId)?.element : undefined;
      if (!composer || !conversationRoot) return false;
      const composerForm = composer.closest("form");
      const sendForm = send?.closest("form");
      const stopForm = stop?.closest("form");
      if ((composerForm && sendForm && composerForm !== sendForm)
        || (composerForm && stopForm && composerForm !== stopForm)) return false;
      const selection: BachataDomHealingSelection = {
        composer,
        conversationRoot,
        ...(send ? { sendButton: send } : {}),
        ...(stop ? { stopButton: stop } : {}),
      };
      if (!rolesIntact(selection)) return false;
      selections.set(provider, selection);
      persistSelection(provider, selection);
      attempts.delete(provider);
      return true;
    })().catch(() => false).finally(() => pending.delete(provider));
    pending.set(provider, operation);
    return await operation;
  };

  const cancelHealing = (provider: BachataDomHealingProvider): void => {
    cancelGenerations.set(provider, (cancelGenerations.get(provider) ?? 0) + 1);
    const requestId = activeHealingRequestIds.get(provider);
    if (requestId) {
      void chrome.runtime.sendMessage({ type: "BACHATA_LOCAL_MODEL_CANCEL", requestId }).catch(() => undefined);
    }
  };

  const messageElements = (provider: BachataDomHealingProvider): HTMLElement[] => {
    const root = cached(provider)?.conversationRoot;
    if (!root) return [];
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("article,[role=article],[data-message-author-role],[data-testid*='message' i]"))
      .filter((element) => visible(element) && Boolean(element.innerText.trim()));
    return candidates.filter((candidate) =>
      !candidates.some((other) => other !== candidate && other.contains(candidate)),
    );
  };

  globalState.__pairDomHealing = {
    heal,
    cancel: cancelHealing,
    cached,
    messageElements,
    invalidate: (provider) => {
      selections.delete(provider);
      // BB-AUD-10. The live selection is already gone. A removal that refuses can leave a
      // stale persisted copy, which `restoreSelection` cannot turn into a wrong control: it
      // re-queries every selector, requires exactly one visible match, and re-checks each
      // one's kind before returning anything.
      try {
        sessionStorage.removeItem(persistedSelectionKey(provider));
      } catch {
        // Absorbed: a stale entry cannot survive restoration's own checks.
      }
    },
  };
})();
