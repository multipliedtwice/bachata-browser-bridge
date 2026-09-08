import assert from "node:assert/strict";
import test from "node:test";

import { parseHealingDecision } from "../dist/content/generic/healing.js";

const candidate = (id, kindHint, overrides = {}) => ({
  id,
  kindHint,
  tag: kindHint === "composer" ? "textarea" : kindHint.endsWith("Button") ? "button" : "div",
  contentEditable: false,
  visible: true,
  rect: { x: 0, y: 0, width: 100, height: 40 },
  domOrder: 0,
  mutationCount: 0,
  textGrowth: 0,
  ...overrides,
});

test("generic healer remains compatible with decisions that predate the new-conversation field", () => {
  const candidates = [
    candidate("composer", "composer"),
    candidate("root", "conversationRoot", { tag: "main" }),
    candidate("send", "sendButton"),
  ];
  const decision = parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["composer"],
    conversationRootIds: ["root"],
    sendButtonIds: ["send"],
    stopButtonIds: [],
    responseMessageIds: [],
  }), candidates);
  assert.equal(decision.status, "selected");
  assert.deepEqual(decision.newConversationButtonIds, []);
});

test("generic healer can select localized or icon-only unknown button candidates without accepting known conflicting controls", () => {
  const candidates = [
    candidate("composer", "composer"),
    candidate("root", "conversationRoot", { tag: "main" }),
    candidate("send", "unknown", { tag: "button", accessibleName: "ส่ง" }),
    candidate("stop", "unknown", { tag: "button", accessibleName: "หยุด" }),
    candidate("fresh", "unknown", { tag: "button", accessibleName: "แชทใหม่" }),
    candidate("known-stop", "stopButton", { tag: "button", accessibleName: "Stop" }),
  ];
  const decision = parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["composer"],
    conversationRootIds: ["root"],
    sendButtonIds: ["send"],
    stopButtonIds: ["stop"],
    newConversationButtonIds: ["fresh"],
    responseMessageIds: [],
  }), candidates);
  assert.equal(decision.status, "selected");
  assert.deepEqual(decision.sendButtonIds, ["send"]);
  assert.deepEqual(decision.stopButtonIds, ["stop"]);
  assert.deepEqual(decision.newConversationButtonIds, ["fresh"]);

  const conflicting = parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["composer"],
    conversationRootIds: ["root"],
    sendButtonIds: ["known-stop"],
    stopButtonIds: [],
    newConversationButtonIds: [],
    responseMessageIds: [],
  }), candidates);
  assert.equal(conflicting.status, "ambiguous");

  const duplicated = parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["composer"],
    conversationRootIds: ["root"],
    sendButtonIds: ["send"],
    stopButtonIds: ["send"],
    newConversationButtonIds: [],
    responseMessageIds: [],
  }), candidates);
  assert.equal(duplicated.status, "ambiguous");
});

// BB-AUD-10. Both parsers absorb a repair that will not run and an attempt that will not
// parse. The contract is that neither produces a decision, so the ambiguous verdict stands.

const responseCandidate = (id) => candidate(id, "responseMessage", { tag: "article" });

test("a healing answer that is not JSON leaves the verdict ambiguous", async () => {
  const { parseResponseHealingDecision } = await import(
    "../dist/content/generic/healing.js"
  );
  const candidates = [
    candidate("composer", "composer"),
    candidate("root", "conversationRoot", { tag: "main" }),
  ];
  for (const text of ["", "not json at all", "{", "[1, 2", "null"]) {
    assert.equal(
      parseHealingDecision(text, candidates).status,
      "ambiguous",
      `${JSON.stringify(text)} produced a decision`,
    );
    assert.equal(
      parseResponseHealingDecision(text, [responseCandidate("response")]).status,
      "ambiguous",
      `${JSON.stringify(text)} produced a response decision`,
    );
  }
});

test("a nearly-valid answer is repaired rather than refused", async () => {
  const { parseResponseHealingDecision } = await import(
    "../dist/content/generic/healing.js"
  );
  const candidates = [
    candidate("composer", "composer"),
    candidate("root", "conversationRoot", { tag: "main" }),
  ];
  // Trailing commas and unquoted keys are what a model actually emits; jsonrepair is the
  // second attempt, and only the repaired form parses.
  const repairable = `{
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["composer",],
    conversationRootIds: ["root",],
    sendButtonIds: [],
    stopButtonIds: [],
    newConversationButtonIds: [],
    responseMessageIds: [],
  }`;
  assert.equal(parseHealingDecision(repairable, candidates).status, "selected");

  const repairableResponse = `{
    protocol: "bachata-response-heal-v1",
    status: "selected",
    responseMessageIds: ["response",],
  }`;
  assert.equal(
    parseResponseHealingDecision(repairableResponse, [responseCandidate("response")]).status,
    "selected",
  );
});
