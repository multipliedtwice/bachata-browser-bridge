import assert from "node:assert/strict";
import test from "node:test";

import {
  genericEmptyConversationStable,
  genericFreshnessObserved,
  genericInitialEmptyStabilityMs,
} from "../dist/content/generic/freshConversation.js";

const observation = (overrides = {}) => ({
  beforeUrl: "https://example.test/chat/old",
  currentUrl: "https://example.test/chat/old",
  beforeRevision: 1,
  currentRevision: 1,
  beforeMessageCount: 8,
  currentMessageCount: 8,
  beforeTextLength: 2_000,
  currentTextLength: 2_000,
  ...overrides,
});

test("route or document movement alone does not attest a fresh conversation", () => {
  assert.equal(genericFreshnessObserved(observation({ currentUrl: "https://example.test/chat/new" })), false);
  assert.equal(genericFreshnessObserved(observation({ currentRevision: 2 })), false);
});

test("freshness requires an observable reset of messages or conversation text", () => {
  assert.equal(genericFreshnessObserved(observation({
    currentUrl: "https://example.test/chat/new",
    currentRevision: 2,
    currentMessageCount: 0,
    currentTextLength: 0,
  })), true);
  assert.equal(genericFreshnessObserved(observation({
    currentMessageCount: 2,
    currentTextLength: 500,
  })), true);
});

test("an explicit new-conversation action accepts stable provider welcome text after document movement", () => {
  const resetWithWelcome = observation({
    beforeMessageCount: 0,
    currentMessageCount: 0,
    beforeTextLength: 420,
    currentTextLength: 420,
    currentUrl: "https://example.test/chat/new",
    currentRevision: 2,
  });
  assert.equal(genericFreshnessObserved(resetWithWelcome), false);
  assert.equal(genericFreshnessObserved({ ...resetWithWelcome, explicitResetRequested: true }), true);
});

test("an initially empty page must remain ready, idle, and empty for the stability window", () => {
  const base = {
    documentReady: true,
    generationActive: false,
    messageCount: 0,
    textLength: 0,
    stableForMs: genericInitialEmptyStabilityMs,
  };
  assert.equal(genericEmptyConversationStable(base), true);
  assert.equal(genericEmptyConversationStable({ ...base, stableForMs: genericInitialEmptyStabilityMs - 1 }), false);
  assert.equal(genericEmptyConversationStable({ ...base, generationActive: true }), false);
  assert.equal(genericEmptyConversationStable({ ...base, messageCount: 1 }), false);
  assert.equal(genericEmptyConversationStable({ ...base, textLength: 1 }), false);
});

test("a large body of text shrinking to a fraction counts only with fewer messages", () => {
  assert.equal(
    genericFreshnessObserved(observation({ currentTextLength: 500, currentMessageCount: 8 })),
    false,
    "text shrinking while every message stayed was treated as a fresh conversation",
  );
  assert.equal(
    genericFreshnessObserved(observation({ currentTextLength: 500, currentMessageCount: 3 })),
    true,
    "a shrunken conversation with fewer messages was not recognised as fresh",
  );
});

test("a short conversation is not declared fresh by text length alone", () => {
  assert.equal(
    genericFreshnessObserved(observation({
      beforeTextLength: 100,
      currentTextLength: 10,
      currentMessageCount: 8,
    })),
    false,
    "a small text change was read as a reset",
  );
});

test("an explicit reset is attested only when the document actually moved", () => {
  // A provider that greets a new conversation with welcome text: nothing was cleared, so
  // only the explicit action plus a new document can attest freshness.
  const welcomed = {
    beforeMessageCount: 0,
    beforeTextLength: 0,
    currentMessageCount: 0,
    currentTextLength: 40,
  };
  assert.equal(
    genericFreshnessObserved(observation({ ...welcomed, explicitResetRequested: true })),
    false,
    "an explicit reset was attested without the document changing",
  );
  assert.equal(
    genericFreshnessObserved(observation({
      ...welcomed,
      currentUrl: "https://example.test/chat/new",
    })),
    false,
    "a document change alone attested a fresh conversation",
  );
  assert.equal(
    genericFreshnessObserved(observation({
      ...welcomed,
      explicitResetRequested: true,
      currentUrl: "https://example.test/chat/new",
    })),
    true,
    "an explicit reset onto a new document with no messages was refused",
  );
});

test("an empty page is only stable once it is ready, idle and quiet for long enough", () => {
  const base = {
    documentReady: true,
    generationActive: false,
    messageCount: 0,
    textLength: 0,
    stableForMs: genericInitialEmptyStabilityMs,
  };
  assert.equal(genericEmptyConversationStable(base), true);
  assert.equal(genericEmptyConversationStable({ ...base, documentReady: false }), false);
  assert.equal(genericEmptyConversationStable({ ...base, generationActive: true }), false);
  assert.equal(genericEmptyConversationStable({ ...base, messageCount: 1 }), false);
  assert.equal(genericEmptyConversationStable({ ...base, textLength: 12 }), false);
  assert.equal(
    genericEmptyConversationStable({ ...base, stableForMs: genericInitialEmptyStabilityMs - 1 }),
    false,
    "an empty page was accepted before it had been quiet long enough",
  );
});

// BR-G6-07. The failure this refuses: the New Conversation control did not start a new
// conversation, it replaced the document in place — a reload, a re-render, a re-injection — and
// the message selector stopped matching the turns that are still on the page. A new document
// token, a bumped revision and even a changed URL are churn; the conversation is still there,
// and sending into it would put the prompt at the end of somebody's existing thread.
test("an explicit reset over a conversation whose turns are still on the page is refused", () => {
  const stillPresent = {
    beforeMessageCount: 6,
    beforeTextLength: 1_000,
    currentMessageCount: 0,
    currentTextLength: 1_000,
    explicitResetRequested: true,
  };
  assert.equal(
    genericFreshnessObserved(observation({ ...stillPresent, currentRevision: 2 })),
    false,
    "a document replaced in place attested a fresh conversation while the turns were still there",
  );
  assert.equal(
    genericFreshnessObserved(observation({
      ...stillPresent,
      currentUrl: "https://example.test/chat/new",
      currentRevision: 2,
    })),
    false,
    "a changed URL attested a fresh conversation while the turns were still there",
  );
  // The same reset, once the conversation it claimed to replace has actually gone.
  assert.equal(
    genericFreshnessObserved(observation({
      ...stillPresent,
      currentTextLength: 40,
      currentRevision: 2,
    })),
    true,
    "a reset that did collapse the conversation was refused",
  );
});
