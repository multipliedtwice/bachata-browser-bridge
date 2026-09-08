import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({ codeBlockStyle: "fenced" });
turndown.use(gfm);

export type ReadablePage = {
  title: string;
  markdown: string;
  url: string;
};

export type ParsedArticle = {
  title?: string | null | undefined;
  content?: string | null | undefined;
} | null | undefined;

/**
 * What an extraction attempt means, apart from the extraction itself.
 *
 * `Readability` needs a browser-grade DOM, so the parse stays in the adapter below and only
 * the decisions live here: a page with no article content is refused rather than reported as
 * an empty article, a nameless article borrows the document's own title, and the Markdown is
 * handed over trimmed.
 */
export const readablePageFrom = (
  article: ParsedArticle,
  fallbackTitle: string,
  url: string,
  toMarkdown: (html: string) => string,
): ReadablePage => {
  if (!article?.content) {
    throw new Error("This page is not readable as an article");
  }
  return {
    title: article.title || fallbackTitle,
    markdown: toMarkdown(article.content).trim(),
    url,
  };
};

export const extractReadablePage = (): ReadablePage => {
  const clone = document.cloneNode(true) as Document;
  return readablePageFrom(
    new Readability(clone).parse(),
    document.title,
    location.href,
    (html) => turndown.turndown(html),
  );
};
