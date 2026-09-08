import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";

// The DOM must exist before the module under test resolves its own imports.
const dom = createGenericDom("<main><div id=\"seed\"></div></main>");
const {
  createLocatorRecipe,
  isVisibleElement,
  isWritableElement,
  locatorRecipeMatchesElement,
  resolveLocatorRecipe,
  resolveLocatorRecipeCandidates,
} = await import("../dist/content/generic/locator.js");

const load = (html) => {
  dom.document.body.innerHTML = html;
  return dom;
};

test("a recipe records what identifies a control, not where it happened to sit", () => {
  load(`
    <main>
      <div><span>noise</span></div>
      <button data-testid="send" aria-label="Send message">Go</button>
    </main>
  `);
  const recipe = createLocatorRecipe(dom.query("button"));
  assert.equal(recipe.tag, "button");
  assert.equal(recipe.accessibleName, "Send message");
  assert.equal(recipe.stableAttributes["data-testid"], "send");
  assert.equal(recipe.stableAttributes["aria-label"], "Send message");
  assert.ok(recipe.structuralPath.length > 0, "a recipe recorded no position to fall back on");
  assert.ok(recipe.cssFallback, "a recipe recorded no selector fallback");
});

test("a recipe resolves the control it was recorded from after the page is rebuilt", () => {
  load(`<main><button data-testid="send" aria-label="Send message">Go</button></main>`);
  const recipe = createLocatorRecipe(dom.query("button"));

  // The page re-renders: same control, new element, different position.
  load(`
    <header><span>banner</span></header>
    <main>
      <div class="composer"><button data-testid="send" aria-label="Send message">Go</button></div>
    </main>
  `);
  const resolved = resolveLocatorRecipe(recipe);
  assert.ok(resolved, "a recipe stopped resolving after the page was rebuilt");
  assert.equal(resolved.getAttribute("data-testid"), "send");
});

test("a recipe refuses a control whose identifying attributes changed", () => {
  load(`<main><button data-testid="send" aria-label="Send message">Go</button></main>`);
  const recipe = createLocatorRecipe(dom.query("button"));

  load(`<main><button data-testid="send" aria-label="Retry">Go</button></main>`);
  const resolved = resolveLocatorRecipe(recipe);
  assert.equal(resolved, undefined, "a control with a different accessible name was accepted");
  assert.equal(locatorRecipeMatchesElement(recipe, dom.query("button")), false);
});

test("an ambiguous page yields no single element rather than the first plausible one", () => {
  load(`
    <main>
      <button data-testid="send" aria-label="Send message">One</button>
      <button data-testid="send" aria-label="Send message">Two</button>
    </main>
  `);
  const recipe = {
    tag: "button",
    accessibleName: "Send message",
    stableAttributes: { "data-testid": "send" },
    structuralPath: [],
  };
  assert.equal(
    resolveLocatorRecipe(recipe),
    undefined,
    "two identical controls resolved to one of them",
  );
  assert.equal(
    resolveLocatorRecipeCandidates(recipe).length,
    2,
    "the ambiguity was hidden from the caller that must resolve it",
  );
});

test("resolution falls back to position only when the element there still matches", () => {
  load(`<main><section><button aria-label="Send message">Go</button></section></main>`);
  const recipe = createLocatorRecipe(dom.query("button"));
  // Strip everything but the recorded position: nothing else can find it now.
  const positional = { ...recipe, stableAttributes: {}, cssFallback: undefined };
  const resolved = resolveLocatorRecipe(positional);
  assert.equal(resolved?.tagName, "BUTTON", "a recorded position did not resolve its own element");

  load(`<main><section><a aria-label="Send message">Go</a></section></main>`);
  assert.equal(
    resolveLocatorRecipe(positional),
    undefined,
    "a different element at the recorded position was accepted as the control",
  );
});

test("a hidden or collapsed element is never offered as a live control", () => {
  load(`
    <main>
      <button data-testid="send" aria-label="Send message">Visible</button>
      <button data-testid="send" aria-label="Send message">Hidden</button>
      <button data-testid="send" aria-label="Send message">Collapsed</button>
    </main>
  `);
  const [visible, hidden, collapsed] = dom.queryAll("button");
  dom.hide(hidden);
  dom.resize(collapsed, { x: 0, y: 0, width: 0, height: 0 });

  assert.equal(isVisibleElement(visible), true);
  assert.equal(isVisibleElement(hidden), false);
  assert.equal(isVisibleElement(collapsed), false);
  assert.deepEqual(
    resolveLocatorRecipeCandidates({
      tag: "button",
      accessibleName: "Send message",
      stableAttributes: { "data-testid": "send" },
      structuralPath: [],
    }),
    [visible],
    "a hidden or collapsed control was offered as usable",
  );

  const detached = dom.document.createElement("button");
  assert.equal(isVisibleElement(detached), false, "an element outside the document was called visible");
});

test("a relaxed search finds the renamed control that a strict one refuses", () => {
  load(`<main><div role="article" data-testid="message">The answer changed</div></main>`);
  const recipe = {
    tag: "div",
    role: "article",
    accessibleName: "An earlier answer",
    stableAttributes: { "data-testid": "message" },
    structuralPath: [],
  };
  assert.deepEqual(
    resolveLocatorRecipeCandidates(recipe),
    [],
    "a renamed element was returned by a strict search",
  );
  assert.equal(
    resolveLocatorRecipeCandidates(recipe, dom.document, true).length,
    1,
    "a relaxed search could not recover the renamed element",
  );
});

test("a recipe with nothing but a tag still searches by tag", () => {
  load(`<main><textarea placeholder="Ask"></textarea></main>`);
  const candidates = resolveLocatorRecipeCandidates({
    tag: "textarea",
    stableAttributes: {},
    structuralPath: [],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].tagName, "TEXTAREA");
});

test("an unusable selector is ignored rather than taking the search down", () => {
  load(`<main><button data-testid="send" aria-label="Send message">Go</button></main>`);
  const recipe = {
    tag: "button",
    stableAttributes: { "data-testid": "send" },
    cssFallback: "main >>> button",
    structuralPath: [],
  };
  assert.equal(resolveLocatorRecipeCandidates(recipe).length, 1);
  assert.equal(resolveLocatorRecipe(recipe)?.tagName, "BUTTON");
});

test("only a control text can actually be typed into counts as writable", () => {
  load(`
    <main>
      <textarea></textarea>
      <input type="text">
      <div contenteditable="true">rich</div>
      <div>plain</div>
      <button>Go</button>
    </main>
  `);
  assert.equal(isWritableElement(dom.query("textarea")), true);
  assert.equal(isWritableElement(dom.query("input")), true);
  assert.equal(isWritableElement(dom.query("div[contenteditable]")), true);
  assert.equal(isWritableElement(dom.query("button")), false);
});

test("a recipe survives an element the selector engine cannot describe", () => {
  load(`<main><section><span>plain</span></section></main>`);
  const recipe = createLocatorRecipe(dom.query("span"));
  assert.equal(recipe.tag, "span");
  assert.deepEqual(recipe.stableAttributes, {});
  assert.equal(resolveLocatorRecipe(recipe)?.tagName, "SPAN");
});

test("a recipe searches by role and placeholder when it has them", () => {
  load(`
    <main>
      <textarea role="textbox" placeholder="Ask anything"></textarea>
      <div role="textbox">not the composer</div>
    </main>
  `);
  const recipe = {
    tag: "textarea",
    role: "textbox",
    placeholder: "Ask anything",
    stableAttributes: {},
    structuralPath: [],
  };
  // Each selector widens the candidate set, so the role alone brings the decoy in; only
  // the recipe as a whole decides which candidate is the control.
  assert.deepEqual(
    resolveLocatorRecipeCandidates(recipe).map((element) => element.tagName),
    ["TEXTAREA", "DIV"],
  );
  assert.equal(resolveLocatorRecipe(recipe)?.tagName, "TEXTAREA");
});

test("a structural path that runs past the tree resolves nothing", () => {
  load(`<main><button>Go</button></main>`);
  assert.equal(
    resolveLocatorRecipe({
      tag: "button",
      stableAttributes: { "data-testid": "gone" },
      structuralPath: [0, 4, 7],
    }),
    undefined,
  );
});

test("a usable CSS fallback contributes candidates the other selectors missed", () => {
  load(`<main><div class="composer"><span>x</span></div></main>`);
  const recipe = {
    tag: "div",
    stableAttributes: { "data-testid": "composer" },
    cssFallback: "main > div",
    structuralPath: [],
  };
  // Nothing carries the recorded attribute, so the fallback is the only source of a
  // candidate, and the recipe still refuses it because the attribute does not match.
  assert.deepEqual(
    resolveLocatorRecipeCandidates(recipe).map((element) => element.className),
    ["composer"],
  );
  assert.equal(resolveLocatorRecipe(recipe), undefined);

  const relaxed = { tag: "div", stableAttributes: {}, cssFallback: "main > div", structuralPath: [] };
  assert.equal(resolveLocatorRecipe(relaxed)?.className, "composer");
});

test.after(() => dom.restore());
