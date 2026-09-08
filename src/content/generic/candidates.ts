import { computeAccessibleName } from "dom-accessibility-api";
import { isVisibleElement } from "./locator.js";
import type { DomCandidate, GenericBindingRole } from "./types.js";

const CANDIDATE_LIMIT = 32;

export const classifyDomElement = (element: Element): GenericBindingRole | "message" | "unknown" => {
  const testId = element.getAttribute("data-testid")?.toLowerCase() ?? "";
  const identity = `${testId} ${element.id} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("class") ?? ""} ${element.getAttribute("data-role") ?? ""}`.toLowerCase();
  if (element instanceof HTMLTextAreaElement
    || element instanceof HTMLInputElement
    || (element instanceof HTMLElement && element.isContentEditable)
    || element.getAttribute("role") === "textbox"
    || /composer|prompt|chat[-_ ]?input|message[-_ ]?input/.test(identity)) {
    return "composer";
  }
  if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
    const name = `${computeAccessibleName(element)} ${identity}`.toLowerCase();
    if (/stop|cancel/.test(name)) {
      return "stopButton";
    }
    if (/new[\s_-]*(chat|conversation|thread)|start[\s_-]*(new[\s_-]*)?(chat|conversation|thread)|compose[\s_-]*(new[\s_-]*)?(chat|conversation)/.test(name)) {
      return "newConversationButton";
    }
    if (/send|submit|ask|run/.test(name)) {
      return "sendButton";
    }
  }
  if (element.matches("article, [role=article], [data-message-author-role]") || /message|response|assistant/.test(identity)) {
    return "message";
  }
  if (element.matches("main, [role=main], [role=feed], [role=log], [role=region], [aria-live=polite], [aria-live=assertive]")
    || /conversation|messages|chat|thread/.test(testId)) {
    return "conversationRoot";
  }
  return "unknown";
};

const score = (element: Element): number => {
  const hint = classifyDomElement(element);
  const rect = element.getBoundingClientRect();
  let value = hint === "unknown" ? 0 : 100;
  if (hint === "composer" && rect.bottom > innerHeight * 0.55) {
    value += 50;
  }
  if (hint === "conversationRoot" && rect.height > innerHeight * 0.35) {
    value += 40;
  }
  if (element.hasAttribute("aria-label") || element.hasAttribute("placeholder")) {
    value += 20;
  }
  return value + Math.min(30, Math.floor(rect.width / 100));
};

export const collectDomCandidates = (): Map<string, { candidate: DomCandidate; element: Element }> => {
  const selector = [
    "textarea",
    "input[type=text]",
    "[contenteditable=true]",
    "[role=textbox]",
    "button",
    "[role=button]",
    "main",
    "[role=main]",
    "[role=feed]",
    "[role=log]",
    "article",
    "[role=article]",
    "[data-message-author-role]",
    "[data-testid*=composer]",
    "[data-testid*=prompt]",
    "[data-testid*=input]",
    "[data-testid*=send]",
    "[data-testid*=stop]",
    "[data-testid*=new]",
    "[data-testid*=compose]",
    "[data-testid*=message]",
    "[data-testid*=chat]",
    "[data-testid*=conversation]",
    "[data-role*=message]",
    "[data-role*=response]",
    "[class*=message]",
    "[class*=response]",
    "[class*=assistant]",
    "[aria-live=polite]",
    "[aria-live=assertive]",
    "[role=region]",
    "form",
  ].join(",");
  const scored = Array.from(document.querySelectorAll(selector))
    .filter(isVisibleElement)
    .sort((a, b) => score(b) - score(a));
  const messageElements = scored.filter((element) => classifyDomElement(element) === "message").slice(0, 8);
  const selected = new Set<Element>(messageElements);
  for (const element of scored) {
    if (selected.size >= CANDIDATE_LIMIT) break;
    selected.add(element);
  }
  const elements = [...selected].slice(0, CANDIDATE_LIMIT);
  const result = new Map<string, { candidate: DomCandidate; element: Element }>();
  elements.forEach((element, index) => {
    const rect = element.getBoundingClientRect();
    const id = `c${index + 1}`;
    result.set(id, {
      element,
      candidate: {
        id,
        kindHint: classifyDomElement(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? undefined,
        accessibleName: computeAccessibleName(element).trim().slice(0, 256) || undefined,
        placeholder: element.getAttribute("placeholder")?.slice(0, 256),
        textPreview: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 512),
        contentEditable: element instanceof HTMLElement && element.isContentEditable,
        visible: true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        domOrder: index,
        mutationCount: 0,
        textGrowth: 0,
      },
    });
  });
  return result;
};
