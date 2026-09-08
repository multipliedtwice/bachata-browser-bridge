import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createSchemaValidator } from "../dist/content/generic/schemaGuard.js";
import { parseHealingDecision, parseResponseHealingDecision } from "../dist/content/generic/healing.js";

const healingModule = new URL("../dist/content/generic/healing.js", import.meta.url).href;
const bundle = fileURLToPath(new URL("../dist/generic-content.js", import.meta.url));

// BR-G6-01. A content script is evaluated under the host page's CSP. Denying the Function
// constructor is what a page without `unsafe-eval` does, so a module that survives this
// survives that page, and a module that compiles a schema at load does not.
const loadWithoutCodeGeneration = (specifier) => {
  const probe = `
    const refuse = () => { throw new EvalError("Refused to evaluate a string as JavaScript"); };
    Object.defineProperty(globalThis, "Function", {
      value: new Proxy(Function, { construct: refuse, apply: refuse }),
      writable: true,
      configurable: true,
    });
    await import(${JSON.stringify(specifier)});
    console.log("loaded");
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" }).trim();
};

test("the healing module loads where the page forbids generating code from strings", () => {
  assert.equal(loadWithoutCodeGeneration(healingModule), "loaded");
});

test("the packaged generic bundle contains no runtime code generation", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(bundle, "utf8");
  assert.equal(/new Function\s*\(/.test(source), false);
  assert.equal(/[^.\w]eval\s*\(/.test(source), false);
});

test("both healing contracts still reject a payload their schema does not describe", () => {
  const candidates = [{
    id: "composer",
    kindHint: "composer",
    tag: "textarea",
    contentEditable: false,
    visible: true,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    domOrder: 0,
    mutationCount: 0,
    textGrowth: 0,
  }];
  assert.equal(parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["composer"],
    conversationRootIds: [],
    sendButtonIds: [],
    stopButtonIds: [],
    responseMessageIds: [],
    selector: "div.composer",
  }), candidates).status, "ambiguous");
  assert.equal(parseResponseHealingDecision(JSON.stringify({
    protocol: "bachata-response-heal-v1",
    status: "selected",
    responseMessageIds: ["composer"],
    selector: "div.message",
  }), candidates).status, "ambiguous");
});

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["protocol", "ids"],
  properties: {
    protocol: { const: "bachata-dom-heal-v1" },
    status: { enum: ["selected", "ambiguous"] },
    ids: { type: "array", maxItems: 2, items: { type: "string" } },
  },
};
const validate = createSchemaValidator(schema);
const valid = { protocol: "bachata-dom-heal-v1", ids: ["a"] };

test("a payload matching every declared rule is accepted", () => {
  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, status: "selected", ids: ["a", "b"] }), true);
});

test("only own object shapes are considered", () => {
  assert.equal(validate(null), false);
  assert.equal(validate("bachata-dom-heal-v1"), false);
  assert.equal(validate([valid]), false);
});

test("an undeclared key is refused even when it names an inherited property", () => {
  assert.equal(validate({ ...valid, selector: "div" }), false);
  assert.equal(validate(JSON.parse('{"protocol":"bachata-dom-heal-v1","ids":["a"],"constructor":1}')), false);
  assert.equal(validate(JSON.parse('{"protocol":"bachata-dom-heal-v1","ids":["a"],"__proto__":{"x":1}}')), false);
});

test("a required key must be present as an own key", () => {
  assert.equal(validate({ protocol: "bachata-dom-heal-v1" }), false);
  assert.equal(validate({ ids: ["a"] }), false);
});

test("a declared but optional key is validated only when it is present", () => {
  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, status: "unsupported" }), false);
  assert.equal(validate({ ...valid, status: 1 }), false);
});

test("const, enum, item type and item count are each enforced", () => {
  assert.equal(validate({ ...valid, protocol: "other" }), false);
  assert.equal(validate({ ...valid, status: "selected" }), true);
  assert.equal(validate({ ...valid, ids: "a" }), false);
  assert.equal(validate({ ...valid, ids: [1] }), false);
  assert.equal(validate({ ...valid, ids: ["a", "b", "c"] }), false);
  assert.equal(validate({ ...valid, ids: [] }), true);
});
