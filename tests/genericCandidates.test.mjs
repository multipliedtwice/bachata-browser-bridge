import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";

const dom = createGenericDom("<main id=\"root\"></main>");
const { classifyDomElement, collectDomCandidates } = await import(
  "../dist/content/generic/candidates.js"
);

// REVIEW-11 / BB-5. Candidate collection decides what a user, and the local healer, are
// offered as a composer, a send control or a conversation root on an unknown provider page.
// Nothing exercised it: the module is bundled into the generic content script and was never
// imported on its own.

const page = (html) => {
  dom.document.body.innerHTML = html;
  return dom.document;
};

const element = (html) => {
  page(`<main id="root">${html}</main>`);
  return dom.query("#root").firstElementChild;
};

test("a text entry surface is a composer however it is built", () => {
  assert.equal(classifyDomElement(element("<textarea></textarea>")), "composer");
  assert.equal(classifyDomElement(element("<input type=\"text\">")), "composer");
  assert.equal(classifyDomElement(element("<div contenteditable=\"true\"></div>")), "composer");
  assert.equal(classifyDomElement(element("<div role=\"textbox\"></div>")), "composer");
  assert.equal(classifyDomElement(element("<div class=\"chat-input\"></div>")), "composer");
  assert.equal(classifyDomElement(element("<div data-testid=\"prompt-area\"></div>")), "composer");
});

test("a control is classified by what it is called, not by where it sits", () => {
  assert.equal(classifyDomElement(element("<button aria-label=\"Stop\"></button>")), "stopButton");
  assert.equal(classifyDomElement(element("<button aria-label=\"Cancel\"></button>")), "stopButton");
  assert.equal(
    classifyDomElement(element("<button aria-label=\"New chat\"></button>")),
    "newConversationButton",
  );
  assert.equal(
    classifyDomElement(element("<div role=\"button\" aria-label=\"Start new conversation\"></div>")),
    "newConversationButton",
  );
  assert.equal(classifyDomElement(element("<button aria-label=\"Send\"></button>")), "sendButton");
  assert.equal(classifyDomElement(element("<button aria-label=\"Submit\"></button>")), "sendButton");
  assert.equal(classifyDomElement(element("<button aria-label=\"Settings\"></button>")), "unknown");
});

test("stopping is decided before starting a new conversation, and both before sending", () => {
  // A control called "Stop generating and send" must never be taken for the send button.
  assert.equal(
    classifyDomElement(element("<button aria-label=\"Stop and send\"></button>")),
    "stopButton",
  );
  assert.equal(
    classifyDomElement(element("<button aria-label=\"New chat, then send\"></button>")),
    "newConversationButton",
  );
});

test("messages and conversation roots are told apart", () => {
  assert.equal(classifyDomElement(element("<article></article>")), "message");
  assert.equal(classifyDomElement(element("<div data-message-author-role=\"assistant\"></div>")), "message");
  assert.equal(classifyDomElement(element("<div class=\"assistant-reply\"></div>")), "message");
  assert.equal(classifyDomElement(element("<main></main>")), "conversationRoot");
  assert.equal(classifyDomElement(element("<div role=\"feed\"></div>")), "conversationRoot");
  assert.equal(classifyDomElement(element("<div aria-live=\"polite\"></div>")), "conversationRoot");
  assert.equal(classifyDomElement(element("<div data-testid=\"thread\"></div>")), "conversationRoot");
  assert.equal(classifyDomElement(element("<span></span>")), "unknown");
});

test("collected candidates carry the shape the healer and the picker are shown", () => {
  page(`
    <main>
      <div role="feed">
        <article data-message-author-role="assistant">An answer with  collapsed   space</article>
      </div>
      <form>
        <textarea placeholder="Ask anything" aria-label="Message"></textarea>
        <button aria-label="Send"></button>
      </form>
    </main>
  `);
  const collected = collectDomCandidates();
  const candidates = [...collected.values()].map((entry) => entry.candidate);

  assert.ok(candidates.length > 0);
  candidates.forEach((candidate, index) => {
    assert.equal(candidate.id, `c${String(index + 1)}`);
    assert.equal(candidate.domOrder, index);
    assert.equal(candidate.visible, true);
    assert.equal(candidate.mutationCount, 0);
    assert.equal(candidate.textGrowth, 0);
  });

  const composer = candidates.find((candidate) => candidate.kindHint === "composer");
  assert.equal(composer.tag, "textarea");
  assert.equal(composer.placeholder, "Ask anything");
  const message = candidates.find((candidate) => candidate.kindHint === "message");
  assert.equal(message.textPreview, "An answer with collapsed space");
  assert.ok(candidates.some((candidate) => candidate.kindHint === "sendButton"));
  assert.ok(candidates.some((candidate) => candidate.kindHint === "conversationRoot"));
});

test("an invisible element is never offered as a candidate", () => {
  page(`<main><textarea id="hidden" style="display:none"></textarea></main>`);
  const hidden = dom.query("#hidden");
  hidden.bachataStyle = { display: "none" };
  const collected = collectDomCandidates();
  assert.equal(
    [...collected.values()].some((entry) => entry.element === hidden),
    false,
  );
});

test("the candidate list is bounded, and messages keep their places in it", () => {
  const messages = Array.from(
    { length: 40 },
    (_unused, index) => `<article data-message-author-role="assistant">message ${String(index)}</article>`,
  ).join("");
  const buttons = Array.from(
    { length: 40 },
    (_unused, index) => `<button aria-label="Action ${String(index)}"></button>`,
  ).join("");
  page(`<main>${messages}${buttons}</main>`);

  const collected = collectDomCandidates();
  assert.equal(collected.size, 32);
  const kinds = [...collected.values()].map((entry) => entry.candidate.kindHint);
  // Messages are reserved a slice of the bound so a long conversation cannot crowd them out.
  assert.equal(kinds.filter((kind) => kind === "message").length >= 8, true);
});
