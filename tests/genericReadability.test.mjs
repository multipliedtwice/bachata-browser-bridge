import assert from "node:assert/strict";
import test from "node:test";

const { readablePageFrom } = await import("../dist/content/generic/readability.js");

// REVIEW-11 / BB-5. Page extraction is what a bound Generic target hands the controller when
// the page is an article rather than a conversation. Nothing exercised it: the module is
// bundled into the generic content script and was never imported on its own.
//
// `Readability` needs a browser-grade DOM, so the parse itself stays in the adapter and what
// is tested here is every decision the adapter makes about the parse's answer.

const markdown = (html) => `converted(${html})`;

test("a parsed article becomes a page with its own title and url", () => {
  assert.deepEqual(
    readablePageFrom(
      { title: "An article", content: "<p>body</p>" },
      "The document title",
      "https://example.invalid/read",
      markdown,
    ),
    {
      title: "An article",
      markdown: "converted(<p>body</p>)",
      url: "https://example.invalid/read",
    },
  );
});

test("a nameless article borrows the document's own title", () => {
  ["", null, undefined].forEach((title) => {
    assert.equal(
      readablePageFrom({ title, content: "<p>body</p>" }, "The document title", "u", markdown).title,
      "The document title",
      String(title),
    );
  });
});

test("the Markdown is handed over trimmed", () => {
  assert.equal(
    readablePageFrom(
      { title: "t", content: "<p>body</p>" },
      "d",
      "u",
      () => "\n\n  body  \n\n",
    ).markdown,
    "body",
  );
});

test("a page with no article content is refused rather than reported as empty", () => {
  [null, undefined, {}, { title: "t" }, { title: "t", content: "" }, { title: "t", content: null }]
    .forEach((article) => {
      assert.throws(
        () => readablePageFrom(article, "d", "u", markdown),
        /not readable as an article/u,
        JSON.stringify(article),
      );
    });
});

test("a refused page never runs the conversion", () => {
  let converted = 0;
  assert.throws(() => readablePageFrom(null, "d", "u", () => {
    converted += 1;
    return "";
  }));
  assert.equal(converted, 0);
});
