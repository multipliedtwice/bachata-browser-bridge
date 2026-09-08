import { isVisibleElement, resolveLocatorRecipeCandidates } from "./locator.js";
import { elementToCapturedResponse, elementToMarkdown } from "./markdown.js";
import { genericLifecycleAcquisitionExpired, genericResponseCompletionConfirmed } from "./responseLifecycle.js";
import type { GenericCapturedSegment, LocatorRecipe } from "./types.js";

const messageSelector = "article, [role=article], [data-message-author-role], [data-testid*=message]";
const normalized = (value: string): string => value.replace(/\s+/g, " ").trim();
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const reanchorGraceMs = 10_000;

export type GenericResponseLifecycleState = {
  deadlineAt: number;
  sawGeneration: boolean;
  generationEndedAt?: number | undefined;
  responseObservedAt?: number | undefined;
  lastStreamText: string;
};

/**
 * BB-A4-N03. What the page was when this capture accepted an answer.
 *
 * The conversation an answer belongs to cannot be read after the capture returns. Between the
 * acceptance and the first line of the finalizer the page can navigate — a same-document route
 * change leaves the document, the content script and every resolved control exactly where they
 * were — and a finalizer that reads the page then names the conversation the page moved to. So
 * the answer carries the page it was taken from, recorded in the same synchronous run that
 * accepted it, and finalization revalidates against that record rather than re-reading.
 */
export type GenericCaptureAttestation = {
  requestId: string;
  nonce: string;
  documentRevision: number;
  conversationUrl: string;
  conversationIdentity: string;
  /** The node the answer was read from, and the anchor proving whose turn it answers. */
  responseElement?: Element | undefined;
  promptElement?: Element | undefined;
  conversationRoot?: Element | undefined;
};

export type GenericCaptureOwnership = {
  requestId: string;
  documentRevision: number;
  conversationUrl: string;
  conversationIdentity: string;
};

export type GenericCapturedResponse = {
  markdown: string;
  text: string;
  segments: GenericCapturedSegment[];
  attestation: GenericCaptureAttestation;
};

export const createGenericResponseLifecycleState = (deadlineAt: number): GenericResponseLifecycleState => ({
  deadlineAt,
  sawGeneration: false,
  lastStreamText: "",
});

/**
 * BB-A4-N02. Whether this turn's submitted prompt is still in the conversation in front of us.
 *
 * A same-document route change leaves the document, the content script and every resolved
 * control exactly where they were and replaces the transcript underneath them. The nonce is the
 * only thing on the page that says whose turn this is, so anything that outlives an await and
 * then acts on the page has to ask for it again.
 */
export const conversationHoldsNonce = (root: Element, nonce: string): boolean =>
  normalized(root.textContent ?? "").includes(normalized(nonce));

const smallestPromptElement = (root: Element, nonce: string): Element | undefined => {
  const target = normalized(nonce);
  const candidates = Array.from(root.querySelectorAll("*"))
    // Cheap text test first: isVisibleElement forces layout and style recalc for every element
    // it is handed, and this runs on a 100ms poll over the whole conversation subtree.
    .filter((element) => normalized(element.textContent ?? "").includes(target) && isVisibleElement(element))
    .sort((left, right) => {
      const leftUser = left.closest('[data-message-author-role="user"]') ? 1 : 0;
      const rightUser = right.closest('[data-message-author-role="user"]') ? 1 : 0;
      if (leftUser !== rightUser) return rightUser - leftUser;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return left.querySelectorAll("*").length - right.querySelectorAll("*").length;
    });
  return candidates[0];
};

const waitForPromptElement = async (
  resolveRoot: () => Element | undefined,
  nonce: string,
  signal: AbortSignal,
  deadlineAt: number,
  timeoutMs: number,
): Promise<{ root: Element; promptElement: Element }> => {
  const deadline = Math.min(deadlineAt, Date.now() + timeoutMs);
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new DOMException("Response capture interrupted", "AbortError");
    }
    const root = resolveRoot();
    if (root?.isConnected) {
      const promptElement = smallestPromptElement(root, nonce);
      if (promptElement) {
        return { root, promptElement };
      }
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Submitted request nonce was not found in the conversation");
};

/**
 * BR-G6-06. Whether the element this capture is anchored to is still carrying this request's
 * own prompt.
 *
 * Node identity is not ownership. An SPA that recycles its message nodes when the conversation
 * changes leaves the anchor connected, inside the same conversation root, and pointing at
 * somebody else's turn — every structural check still passes while the text underneath has
 * become another conversation's. The nonce is the only thing that says whose turn this is, so
 * it is rechecked rather than remembered.
 */
const anchorHoldsNonce = (promptElement: Element, nonce: string): boolean =>
  promptElement.isConnected &&
  normalized(promptElement.textContent ?? "").includes(normalized(nonce));

const sharedClass = (left: Element, right: Element): boolean => {
  const leftClasses = new Set(Array.from(left.classList).filter((value) => value.length >= 3));
  return Array.from(right.classList).some((value) => leftClasses.has(value));
};

const structurallySimilar = (left: Element, right: Element): boolean => {
  const leftRole = left.getAttribute("role");
  const rightRole = right.getAttribute("role");
  if (leftRole && leftRole === rightRole) return true;
  if (left.tagName !== right.tagName) return false;
  if (sharedClass(left, right)) return true;
  return left.classList.length === 0 && right.classList.length === 0;
};

const structuralResponseCandidate = (root: Element, promptElement: Element): Element | undefined => {
  let current: Element | null = promptElement;
  for (let depth = 0; current && current !== root && depth < 8; depth += 1) {
    const node: Element = current;
    const parent: Element | null = node.parentElement;
    if (!parent || !root.contains(parent)) break;
    const siblings = Array.from(parent.children);
    const position = siblings.indexOf(node);
    if (position >= 0) {
      const candidate = siblings.slice(position + 1).find((element) => (
        structurallySimilar(node, element)
        && isVisibleElement(element)
        && normalized(element.textContent ?? "").length > 0
      ));
      if (candidate) return candidate;
    }
    current = parent;
  }
  return undefined;
};

const explicitMessageRole = (element: Element): "user" | "assistant" | undefined => {
  const carrier = element.closest("[data-message-author-role], [data-author-role]")
    ?? element.querySelector("[data-message-author-role], [data-author-role]")
    ?? element;
  const raw = [
    carrier.getAttribute("data-message-author-role"),
    carrier.getAttribute("data-author-role"),
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(?:user|human)\b/.test(raw)) return "user";
  if (/\b(?:assistant|bot|model|ai)\b/.test(raw)) return "assistant";
  return undefined;
};

const domOrder = (left: Element, right: Element): number => {
  if (left === right) return 0;
  const position = left.compareDocumentPosition(right);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
};

/**
 * BB-A4-F13. Turns, not the things a site marks up inside one.
 *
 * `messageSelector` matches a turn and, on sites that mark an action strip up inside it, that
 * strip too, and `DOCUMENT_POSITION_FOLLOWING` is set for a descendant — so the innermost node
 * sorted last and "the latest candidate" became the Copy button. In document order every
 * descendant of a kept candidate follows it consecutively, so the last kept candidate is the only
 * one a nested node has to be compared against.
 */
const outermostInDocumentOrder = (ordered: Element[]): Element[] => {
  const kept: Element[] = [];
  for (const candidate of ordered) {
    if (!kept[kept.length - 1]?.contains(candidate)) kept.push(candidate);
  }
  return kept;
};

/** BB-A4-F13. Inside a kept turn, the region the profile bound is the answer; the strip is not. */
const boundRegionWithin = (turn: Element, bound: readonly Element[]): Element | undefined =>
  bound.find((candidate) => candidate === turn || turn.contains(candidate));

/**
 * BR-G6-13. The turn the prompt is in, not the innermost thing inside it that also answers to
 * the message selector.
 *
 * `messageSelector` matches a turn and, on sites that mark up their bubbles too, the nodes
 * inside one. `closest` returns the innermost of those, so the anchor became a fragment of the
 * user's own turn and every sibling fragment beside it — an attachment strip, a second bubble —
 * read as a message that came after the prompt. The outermost container inside the conversation
 * root is the turn.
 */
const messageContainer = (root: Element, element: Element): Element => {
  let container: Element | undefined;
  let current: Element | null = element;
  while (current && current !== root && root.contains(current)) {
    if (current.matches(messageSelector)) container = current;
    current = current.parentElement;
  }
  return container ?? element;
};

/**
 * BR-G6-13. `DOCUMENT_POSITION_FOLLOWING` is set for a descendant as well as for a node that
 * comes after, so the prompt turn's own contents used to qualify as messages following it.
 */
const followingVisibleMessage = (promptContainer: Element, element: Element): boolean => (
  element !== promptContainer
  && !promptContainer.contains(element)
  && isVisibleElement(element)
  && normalized(element.textContent ?? "").length > 0
  && Boolean(promptContainer.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
);

const laterExplicitUserTurn = (root: Element, promptElement: Element): Element | undefined => {
  const promptContainer = messageContainer(root, promptElement);
  return Array.from(root.querySelectorAll(messageSelector))
    .filter((element) => followingVisibleMessage(promptContainer, element))
    .sort(domOrder)
    .find((element) => explicitMessageRole(element) === "user");
};

const laterCandidates = (root: Element, promptElement: Element, responseRecipe?: LocatorRecipe): Element[] => {
  const promptContainer = messageContainer(root, promptElement);
  const following = (element: Element): boolean => followingVisibleMessage(promptContainer, element);
  const bound = responseRecipe
    ? resolveLocatorRecipeCandidates(responseRecipe, root, true).filter(following)
    : [];
  const candidates: Element[] = [...bound];
  candidates.push(...Array.from(root.querySelectorAll(messageSelector)).filter(following));
  const structural = structuralResponseCandidate(root, promptContainer);
  if (structural && following(structural)) candidates.push(structural);
  // BB-A4-F13. Turns are compared against turns. Anything nested inside a kept turn is part of
  // that turn, not a later one, and inside the winner the profile-bound region is the answer
  // rather than whatever the site marked up beside it.
  return outermostInDocumentOrder([...new Set(candidates)].sort(domOrder))
    .map((turn) => boundRegionWithin(turn, bound) ?? turn);
};

const latestResponseCandidate = (candidates: Element[]): Element | undefined => {
  const assistant = candidates.filter((candidate) => explicitMessageRole(candidate) === "assistant");
  if (assistant.length > 0) return assistant[assistant.length - 1];
  const unknown = candidates.filter((candidate) => explicitMessageRole(candidate) === undefined);
  return unknown[unknown.length - 1];
};

export const captureGenericResponse = async (
  resolveRoot: () => Element | undefined,
  requestNonce: string,
  signal: AbortSignal,
  timeoutMs = 30 * 60_000,
  generationActive?: () => boolean,
  responseRecipe?: LocatorRecipe,
  assertCurrentConversation?: () => void,
  onStream?: (text: string) => void | Promise<void>,
  lifecycle?: GenericResponseLifecycleState,
  // BB-A4-N03. Read in the same synchronous run that accepts the candidate, never afterwards.
  attestOwnership?: () => GenericCaptureOwnership,
): Promise<GenericCapturedResponse> => {
  const started = Date.now();
  const state = lifecycle ?? createGenericResponseLifecycleState(started + timeoutMs);
  if (!Number.isSafeInteger(state.deadlineAt) || state.deadlineAt <= started) {
    throw new Error("Generic browser response deadline has expired");
  }
  assertCurrentConversation?.();
  const initialRemaining = Math.max(1, state.deadlineAt - Date.now());
  let { root, promptElement } = await waitForPromptElement(
    resolveRoot,
    requestNonce,
    signal,
    state.deadlineAt,
    Math.min(20_000, Math.max(1_000, Math.floor(initialRemaining / 4))),
  );
  let chosen: Element | undefined;
  let lastText = "";
  let stableSince = Date.now();
  let reanchorMissingSince: number | undefined;
  while (Date.now() < state.deadlineAt) {
    assertCurrentConversation?.();
    if (signal.aborted) {
      throw new DOMException("Response capture interrupted", "AbortError");
    }
    const currentRoot = resolveRoot();
    if (!currentRoot?.isConnected) {
      reanchorMissingSince ??= Date.now();
      if (Date.now() - reanchorMissingSince >= reanchorGraceMs) {
        throw new Error("The submitted request nonce is no longer present in the active generic conversation");
      }
      await delay(100);
      continue;
    }
    if (
      currentRoot !== root ||
      !currentRoot.contains(promptElement) ||
      !anchorHoldsNonce(promptElement, requestNonce)
    ) {
      const rebound = smallestPromptElement(currentRoot, requestNonce);
      if (!rebound) {
        reanchorMissingSince ??= Date.now();
        if (Date.now() - reanchorMissingSince >= reanchorGraceMs) {
          throw new Error("The submitted request nonce is no longer present in the active generic conversation");
        }
        await delay(100);
        continue;
      }
      reanchorMissingSince = undefined;
      root = currentRoot;
      promptElement = rebound;
      chosen = undefined;
      lastText = "";
      stableSince = Date.now();
    } else {
      reanchorMissingSince = undefined;
      root = currentRoot;
    }
    const generating = generationActive?.() ?? false;
    if (generating) {
      state.sawGeneration = true;
      state.generationEndedAt = undefined;
    } else if (state.sawGeneration && state.generationEndedAt === undefined) {
      state.generationEndedAt = Date.now();
    }
    if (laterExplicitUserTurn(root, promptElement)) {
      throw new Error("Another user turn appeared before the generic browser response was captured");
    }
    const next = latestResponseCandidate(laterCandidates(root, promptElement, responseRecipe));
    const text = normalized(next?.textContent ?? "");
    if (next && text) {
      state.responseObservedAt ??= Date.now();
      if (genericLifecycleAcquisitionExpired({
        responseObservedAt: state.responseObservedAt,
        now: Date.now(),
        sawGeneration: state.sawGeneration,
      })) {
        throw new Error("Generic browser response appeared without an observable generation lifecycle; bind or repair the Stop control");
      }
      const streamText = (next.textContent ?? "").replace(/\r\n/g, "\n").trim();
      if (streamText && streamText !== state.lastStreamText) {
        state.lastStreamText = streamText;
        await onStream?.(streamText);
      }
      if (chosen !== next || text !== lastText) {
        chosen = next;
        lastText = text;
        stableSince = Date.now();
      } else {
        const completionConfirmed = genericResponseCompletionConfirmed({
          generationObserverAvailable: Boolean(generationActive),
          sawGeneration: state.sawGeneration,
          generating,
          generationEndedAt: state.generationEndedAt,
          stableSince,
          now: Date.now(),
        });
        if (completionConfirmed) {
          const captured = elementToCapturedResponse(chosen);
          if (captured.text && captured.text !== state.lastStreamText) {
            state.lastStreamText = captured.text;
            await onStream?.(captured.text);
          }
          // BR-G6-06. Everything above this point crossed an await. A response is this
          // request's only if the conversation is still this request's, the anchor still
          // carries this request's nonce, and the response node is still inside the
          // conversation that anchor is in.
          assertCurrentConversation?.();
          const finalRoot = resolveRoot();
          if (
            finalRoot !== root ||
            !anchorHoldsNonce(promptElement, requestNonce) ||
            !chosen.isConnected ||
            !finalRoot.contains(chosen)
          ) {
            throw new Error("The submitted request nonce is no longer present in the active generic conversation");
          }
          // BB-A4-N03. Still the same synchronous run: the page the answer was taken from is
          // recorded here, beside the checks that just proved the answer is this request's.
          // Nothing after this may read the page for that identity again.
          const ownership = attestOwnership?.();
          return {
            markdown: elementToMarkdown(chosen),
            text: captured.text,
            segments: captured.segments,
            attestation: {
              requestId: ownership?.requestId ?? "",
              nonce: requestNonce,
              documentRevision: ownership?.documentRevision ?? 0,
              conversationUrl: ownership?.conversationUrl ?? "",
              conversationIdentity: ownership?.conversationIdentity ?? "",
              responseElement: chosen,
              promptElement,
              conversationRoot: finalRoot,
            },
          };
        }
      }
    }
    await delay(Math.min(250, Math.max(1, state.deadlineAt - Date.now())));
  }
  throw new Error(
    generationActive
      ? "Timed out while waiting for a confirmed generic browser generation lifecycle to complete"
      : "Timed out because generic browser completion could not be confirmed; bind a Stop control or use explicit manual completion",
  );
};
