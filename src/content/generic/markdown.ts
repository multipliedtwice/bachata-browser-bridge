import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import type { GenericCapturedSegment } from "./types.js";

const service = new TurndownService({
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
});
service.use(gfm);
service.addRule("fencedCodeLanguage", {
  filter(node) {
    return node.nodeName === "PRE" && node.firstElementChild?.nodeName === "CODE";
  },
  replacement(_content, node) {
    const code = node.firstElementChild as HTMLElement;
    const language = languageForCode(code);
    const value = (code.textContent ?? "").replace(/\n$/, "");
    return `\n\n\`\`\`${language}\n${value}\n\`\`\`\n\n`;
  },
});

const blockTags = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
  "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "UL",
]);

const normalizeText = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");

export const languageForCode = (code: Element): string =>
  [...code.classList]
    .map((name) => /(?:language|lang)-(.+)/i.exec(name)?.[1])
    .find(Boolean)
  ?? code.getAttribute("data-language")
  ?? code.getAttribute("data-lang")
  ?? code.closest("pre")?.getAttribute("data-language")
  ?? "";

const selectionElement = (node: Node | null): Element | undefined => {
  if (node instanceof Element) return node;
  return node?.parentElement ?? undefined;
};

export const selectionToCapturedResponse = (
  selection: Selection,
): { text: string; segments: GenericCapturedSegment[] } => {
  const text = normalizeText(selection.toString()).trim();
  if (!text) return { text: "", segments: [] };
  const anchorCode = selectionElement(selection.anchorNode)?.closest("code");
  const focusCode = selectionElement(selection.focusNode)?.closest("code");
  if (anchorCode && anchorCode === focusCode) {
    const language = languageForCode(anchorCode);
    return {
      text,
      segments: [{
        type: "codeBlock",
        text,
        start: 0,
        end: text.length,
        ...(language ? { language } : {}),
      }],
    };
  }
  return {
    text,
    segments: [{ type: "text", text, start: 0, end: text.length }],
  };
};

export function elementToMarkdown(element: Element): string {
  return service.turndown(element.cloneNode(true) as HTMLElement).trim();
}

export const elementToCapturedResponse = (
  element: Element,
): { text: string; segments: GenericCapturedSegment[] } => {
  const parts: Array<{ type: GenericCapturedSegment["type"]; text: string; language?: string }> = [];
  const append = (type: GenericCapturedSegment["type"], value: string, language?: string): void => {
    const text = normalizeText(value);
    if (!text) return;
    const previous = parts.at(-1);
    if (previous && previous.type === type && previous.language === language) {
      previous.text += text;
      return;
    }
    parts.push({ type, text, ...(language ? { language } : {}) });
  };
  const appendBoundary = (): void => {
    const previous = parts.at(-1);
    if (!previous || previous.type !== "text" || !previous.text.endsWith("\n")) {
      append("text", "\n");
    }
  };
  const walk = (node: Node, inheritedQuote = false): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(inheritedQuote ? "quote" : "text", node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      append(inheritedQuote ? "quote" : "text", "\n");
      return;
    }
    if (node.tagName === "PRE") {
      appendBoundary();
      const code = node.querySelector(":scope > code") ?? node.querySelector("code") ?? node;
      append("codeBlock", (code.textContent ?? "").replace(/\n$/, ""), languageForCode(code));
      appendBoundary();
      return;
    }
    const isQuote = inheritedQuote || node.tagName === "BLOCKQUOTE";
    const isBlock = blockTags.has(node.tagName);
    if (isBlock && parts.length > 0) appendBoundary();
    for (const child of Array.from(node.childNodes)) walk(child, isQuote);
    if (isBlock) appendBoundary();
  };
  walk(element);

  while (parts[0]?.type === "text") {
    parts[0].text = parts[0].text.replace(/^\s*\n+/, "");
    if (parts[0].text) break;
    parts.shift();
  }
  while (parts.at(-1)?.type === "text") {
    const last = parts.at(-1);
    if (!last) break;
    last.text = last.text.replace(/\n+\s*$/, "");
    if (last.text) break;
    parts.pop();
  }

  let text = "";
  const segments: GenericCapturedSegment[] = [];
  for (const part of parts) {
    if (!part.text) continue;
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
