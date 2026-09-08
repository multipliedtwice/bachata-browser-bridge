import assert from "node:assert/strict";
import test from "node:test";

import * as backgroundConversation from "../dist/background/conversation.js";
import { createGenericDom } from "./support/genericDom.mjs";

await import("../dist/content/providerControls.js");
await import("../dist/content/providerLogic.js");
await import("../dist/content/chatgptLogic.js");

const PROVIDER_LABEL = "ChatGPT";

const {
  assertTextWithinLimit,
  attachmentFile,
  createInterruptControl,
  createInterruptLease,
  createAssetSourceStore,
  createAttachmentStaging,
  createComposerResolver,
  createConversationBinder,
  createIndeterminateMonitor,
  createInterruptHandler,
  createRequestTeardown,
  createResponseActivityObserver,
  createResponseBinder,
  createStreamSender,
  createSubmittedPromptWaiter,
  installProviderDocument,
  writeStagedAttachments,
  requestMatchesDocument,
  startLifecycleObserver,
  createComposerGuard,
  sendBackground,
  chatGptCompletionActionVisible,
  chatGptTurnIdentity,
  chatGptObservationFaultVerdict,
  completionOutcome,
  completionSettled,
  canonicalConversationUrl,
  canonicalizeRenderedPrompt,
  composeCapturedResponse,
  conversationIdentityFor,
  isBusyState,
  isSupportedInitialTransition,
  shouldCompleteResponse,
  singleNewItem,
  streamUpdate,
  uniqueItem,
  utf8ByteLength,
} = globalThis.__pairChatGptLogic;

test("rendered prompt canonicalization is narrow and deterministic", () => {
  assert.equal(
    canonicalizeRenderedPrompt("line 1\r\nline\u00a02\n"),
    "line 1\nline 2",
  );
  assert.equal(canonicalizeRenderedPrompt("a\n\n"), "a\n");
});

test("stream updates append when possible and replace after correction", () => {
  assert.deepEqual(streamUpdate("hello", "hello world"), {
    mode: "append",
    text: " world",
  });
  assert.deepEqual(streamUpdate("hello wurld", "hello world"), {
    mode: "replace",
    text: "hello world",
  });
  assert.equal(streamUpdate("same", "same"), undefined);
});

test("response association selects exactly one new element by identity", () => {
  const old = {};
  const added = {};
  assert.equal(singleNewItem(new Set([old]), [old, added]), added);
  assert.equal(singleNewItem(new Set([old]), [old]), undefined);
});

test("response association rejects more than one new element", () => {
  const old = {};
  assert.throws(
    () => singleNewItem(new Set([old]), [old, {}, {}]),
    /More than one new ChatGPT message appeared/,
  );
});

test("provider control lookup rejects multiple distinct matches but deduplicates one element", () => {
  const element = {};
  assert.equal(uniqueItem([element, element]), element);
  assert.throws(
    () => uniqueItem([{}, {}]),
    /ambiguous provider controls/,
  );
});


test("captured response size is measured as UTF-8 bytes", () => {
  assert.equal(utf8ByteLength("a"), 1);
  assert.equal(utf8ByteLength("🙂"), 4);
  assert.doesNotThrow(() => assertTextWithinLimit("🙂", 4, "response"));
  assert.throws(
    () => assertTextWithinLimit("🙂", 3, "response"),
    /response exceeds 3 bytes/,
  );
});

test("provider URL classification requires HTTPS", () => {
  assert.equal(
    backgroundConversation.providerForUrl("https://chatgpt.com/c/example"),
    "chatgpt",
  );
  assert.equal(
    backgroundConversation.providerForUrl("https://claude.ai/chat/example"),
    "claude",
  );
  assert.equal(backgroundConversation.providerForUrl("http://chatgpt.com/c/example"), undefined);
  assert.equal(backgroundConversation.providerForUrl("ftp://claude.ai/chat/example"), undefined);
  assert.throws(
    () => backgroundConversation.canonicalConversationUrl(
      "chatgpt",
      "http://chatgpt.com/c/example",
    ),
    /does not belong to chatgpt/u,
  );
});

test("conversation identity changes with canonical conversation URL", () => {
  assert.equal(
    canonicalConversationUrl("https://chatgpt.com/c/example/?x=1#hash"),
    "https://chatgpt.com/c/example",
  );
  assert.notEqual(
    conversationIdentityFor("https://chatgpt.com/c/one"),
    conversationIdentityFor("https://chatgpt.com/c/two"),
  );
  assert.equal(
    isSupportedInitialTransition(
      "https://chatgpt.com/",
      "https://chatgpt.com/c/example",
    ),
    true,
  );
  assert.equal(
    isSupportedInitialTransition(
      "https://chatgpt.com/c/one",
      "https://chatgpt.com/c/two",
    ),
    false,
  );
});

test("structured capture segments preserve one-pass source ranges with duplicate text", () => {
  const captured = composeCapturedResponse([
    { type: "text", text: "echo hello\nnormal text\n" },
    { type: "codeBlock", text: "echo hello", language: "bash" },
  ]);
  assert.equal(captured.text, "echo hello\nnormal text\necho hello");
  assert.deepEqual(captured.segments, [
    {
      type: "text",
      text: "echo hello\nnormal text\n",
      start: 0,
      end: 23,
    },
    {
      type: "codeBlock",
      text: "echo hello",
      start: 23,
      end: 33,
      language: "bash",
    },
  ]);
  assert.equal(
    captured.text.slice(
      captured.segments[1].start,
      captured.segments[1].end,
    ),
    captured.segments[1].text,
  );
});

test("response completion requires an observed busy-to-idle lifecycle", () => {
  assert.equal(isBusyState(true), true);
  assert.equal(isBusyState(false), false);
  assert.equal(
    shouldCompleteResponse({
      busyObserved: false,
      currentlyBusy: false,
      responseText: "partial",
      quietForMs: 10_000,
      requiredQuietMs: 1_000,
      idleForMs: 1_000,
      requiredIdleMs: 1_000,
    }),
    false,
  );
  assert.equal(
    shouldCompleteResponse({
      busyObserved: true,
      currentlyBusy: true,
      responseText: "partial",
      quietForMs: 10_000,
      requiredQuietMs: 1_000,
      idleForMs: 1_000,
      requiredIdleMs: 1_000,
    }),
    false,
  );
  assert.equal(
    shouldCompleteResponse({
      busyObserved: true,
      currentlyBusy: false,
      responseText: "complete",
      quietForMs: 1_000,
      requiredQuietMs: 1_000,
      idleForMs: 999,
      requiredIdleMs: 1_000,
    }),
    false,
  );
  assert.equal(
    shouldCompleteResponse({
      busyObserved: true,
      currentlyBusy: false,
      responseText: "complete",
      quietForMs: 1_000,
      requiredQuietMs: 1_000,
      idleForMs: 1_000,
      requiredIdleMs: 1_000,
    }),
    true,
  );
});


test("content and background conversation binding helpers stay equivalent", () => {
  const url = "https://chatgpt.com/c/example/?ignored=1#ignored";
  const identity = conversationIdentityFor(url);
  assert.equal(
    canonicalConversationUrl(url),
    backgroundConversation.canonicalConversationUrl("chatgpt", url),
  );
  assert.equal(
    identity,
    backgroundConversation.conversationIdentityFor("chatgpt", url),
  );
  assert.equal(
    globalThis.__pairChatGptLogic.sessionIdForConversation(7, "doc", identity),
    backgroundConversation.sessionIdForConversation("chatgpt", 7, "doc", identity),
  );
  assert.equal(
    isSupportedInitialTransition(
      "https://chatgpt.com/",
      "https://chatgpt.com/c/example",
    ),
    backgroundConversation.isSupportedInitialTransition(
      "chatgpt",
      "https://chatgpt.com/",
      "https://chatgpt.com/c/example",
    ),
  );
});

test("content registration retries after a failed acknowledgement", async () => {
  let attempts = 0;
  const coordinator = globalThis.__pairChatGptLogic.createRegistrationCoordinator({
    currentUrl: () => "https://chatgpt.com/c/example",
    registerUrl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("background unavailable");
      }
    },
  });

  await assert.rejects(coordinator.register(), /background unavailable/);
  assert.equal(coordinator.registeredUrl(), "");

  await coordinator.ensure();
  assert.equal(attempts, 2);
  assert.equal(coordinator.registeredUrl(), "https://chatgpt.com/c/example");
});

test("content registration verifies the same URL and deduplicates concurrent attempts", async () => {
  let now = 1_000;
  let attempts = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const coordinator = globalThis.__pairChatGptLogic.createRegistrationCoordinator({
    currentUrl: () => "https://chatgpt.com/c/example",
    now: () => now,
    verificationIntervalMs: 10_000,
    registerUrl: async () => {
      attempts += 1;
      if (attempts === 2) {
        await blocked;
      }
    },
  });

  await coordinator.register();
  await coordinator.ensure(true);
  assert.equal(attempts, 1);

  now += 10_000;
  const first = coordinator.ensure(true);
  const second = coordinator.register();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(attempts, 2);
});

// BB-6. The second parameter was declared, computed at every call site, and ignored. Only the
// Stop control marks generation: providers disable Send while composing, while uploading and
// on an empty composer, so a disabled Send is not evidence of a running response.
test("busy state is decided by the Stop control alone", () => {
  assert.equal(isBusyState(true), true);
  assert.equal(isBusyState(false), false);
  assert.equal(isBusyState.length, 1, "isBusyState still declares an ignored parameter");
});

// A1: the ChatGPT alert taxonomy. Structural scope comes from the adapter, semantics from here,
// and both halves must agree before an alert is allowed to end anything.
const {
  chatGptAlertCandidates,
  chatGptAlertElements,
  chatGptAlertErrorCode,
  chatGptAlertSnapshot,
  classifyChatGptAlert,
} = globalThis.__pairChatGptLogic;

const alertElement = (text, attributes = {}) => ({
  innerText: text,
  textContent: text,
  getAttribute: (name) => attributes[name] ?? null,
  ...(attributes.hidden === true ? { hidden: true } : {}),
});

const alertRoot = (...elements) => ({ querySelectorAll: () => elements });

const positives = [
  ["rate_limited", "response", "You've reached your message limit for GPT-5."],
  ["rate_limited", "dialog", "Too many requests. Please try again later."],
  ["session_expired", "dialog", "Your session has expired. Please log in again."],
  ["subscription_unavailable", "dialog", "Failed to load subscription."],
  ["response_failed", "response", "Something went wrong. Please try again."],
  ["attachment_rejected", "attachment", "Upload failed: the file is too large."],
];

for (const [code, scope, text] of positives) {
  test(`a ${scope}-scoped alert saying ${JSON.stringify(text)} classifies as ${code}`, () => {
    assert.deepEqual(classifyChatGptAlert([{ scope, text }]), { code, message: text, scope });
  });
}

const nearMisses = [
  ["rate_limited", "response", "Limit your answer to 200 words."],
  ["session_expired", "dialog", "Your session is active on two devices."],
  ["subscription_unavailable", "dialog", "Manage your subscription in settings."],
  ["response_failed", "response", "Here is what went wrong in your snippet."],
  ["attachment_rejected", "attachment", "Upload complete: 2 images attached."],
];

for (const [code, scope, text] of nearMisses) {
  test(`a ${scope}-scoped near miss for ${code} is not classified`, () => {
    assert.equal(classifyChatGptAlert([{ scope, text }]), undefined);
  });
}

test("each scope admits only the classes that can honestly appear in it", () => {
  // An account modal cannot fail one response, and an in-thread error cannot prove a signed-out
  // account, however plainly either one is worded.
  assert.equal(
    classifyChatGptAlert([{ scope: "response", text: "Your session has expired. Please log in again." }]),
    undefined,
  );
  assert.equal(
    classifyChatGptAlert([{ scope: "dialog", text: "Something went wrong. Please try again." }]),
    undefined,
  );
  assert.equal(
    classifyChatGptAlert([{ scope: "attachment", text: "Too many requests. Please try again later." }]),
    undefined,
  );
});

test("an alert that matches two classes is dropped rather than guessed", () => {
  assert.equal(
    classifyChatGptAlert([{ scope: "attachment", text: "Something went wrong while uploading your file." }]),
    undefined,
  );
});

test("unknown and localized wording produces no taxonomy at all", () => {
  for (const text of [
    "Une erreur est survenue.",
    "出现错误，请重试。",
    "The model is thinking.",
    "",
  ]) {
    assert.equal(classifyChatGptAlert([{ scope: "response", text }]), undefined);
  }
});

test("two alerts that mean different things classify as nothing", () => {
  // Scope order says which alert is closest to the turn, not which one is true. Picking by
  // position would let a stale account banner and a fresh response error take turns deciding.
  assert.equal(
    classifyChatGptAlert([
      { scope: "dialog", text: "Too many requests. Please try again later." },
      { scope: "response", text: "Something went wrong. Please try again." },
    ]),
    undefined,
  );
});

test("the same class seen twice still classifies, closest binding first", () => {
  assert.deepEqual(
    classifyChatGptAlert([
      { scope: "dialog", text: "Too many requests. Please try again later." },
      { scope: "response", text: "You've reached your message limit for GPT-5." },
    ]),
    {
      code: "rate_limited",
      message: "You've reached your message limit for GPT-5.",
      scope: "response",
    },
  );
});

test("duplicate alerts classify once and identically", () => {
  const text = "Something went wrong. Please try again.";
  assert.deepEqual(
    classifyChatGptAlert([{ scope: "response", text }, { scope: "response", text }]),
    { code: "response_failed", message: text, scope: "response" },
  );
});

test("candidates are collected only from roots the adapter owns", () => {
  // The bound response, the composer's own form and modal dialogs. An alert that lives anywhere
  // else on the page — a cookie banner, an unrelated toast, the previous response — is never
  // even offered to the classifier.
  assert.deepEqual(chatGptAlertCandidates({}), []);
  const staleResponse = alertRoot(alertElement("Something went wrong. Please try again."));
  const boundResponse = alertRoot(alertElement("Still generating."));
  const collected = chatGptAlertCandidates({
    responseRoot: boundResponse,
    dialogs: [],
  });
  assert.deepEqual(collected, [{ scope: "response", text: "Still generating." }]);
  assert.equal(classifyChatGptAlert(collected), undefined);
  // Proof the stale root would have classified had it been the bound one.
  assert.equal(
    classifyChatGptAlert(chatGptAlertCandidates({ responseRoot: staleResponse }))?.code,
    "response_failed",
  );
});

test("composer alerts are attachment-scoped only while files are staged", () => {
  const form = alertRoot(alertElement("Upload failed: the file is too large."));
  assert.deepEqual(
    chatGptAlertCandidates({ composerForm: form, attachmentsStaged: true }),
    [{ scope: "attachment", text: "Upload failed: the file is too large." }],
  );
  assert.deepEqual(
    chatGptAlertCandidates({ composerForm: form }),
    [{ scope: "composer", text: "Upload failed: the file is too large." }],
  );
});

test("hidden and empty alerts are not candidates", () => {
  const root = alertRoot(
    alertElement("Something went wrong.", { "aria-hidden": "true" }),
    alertElement("Something went wrong.", { hidden: true }),
    alertElement("   "),
  );
  assert.deepEqual(chatGptAlertCandidates({ responseRoot: root }), []);
});

test("alert text is normalized and bounded before it leaves the page", () => {
  const noisy = alertElement("  Something\n\twent   wrong.  ");
  assert.deepEqual(
    chatGptAlertCandidates({ responseRoot: alertRoot(noisy) }),
    [{ scope: "response", text: "Something went wrong." }],
  );
  const long = alertElement(`Something went wrong. ${"x".repeat(500)}`);
  const [candidate] = chatGptAlertCandidates({ responseRoot: alertRoot(long) });
  assert.equal(candidate.text.length, 241);
  assert.equal(candidate.text.endsWith("…"), true);
});

test("a dialog speaks only through its own alert regions", () => {
  // A modal's text is a whole screen: heading, body, buttons, legal copy. Classifying that blob
  // would let any wording anywhere in any modal decide a turn.
  const modal = {
    innerText: "Your session has expired. Please log in again. Cancel Continue Terms apply.",
    textContent: "Your session has expired. Please log in again.",
    getAttribute: () => null,
    querySelectorAll: () => [alertElement("Your session has expired. Please log in again.")],
  };
  assert.deepEqual(
    chatGptAlertCandidates({ dialogs: [modal] }),
    [{ scope: "dialog", text: "Your session has expired. Please log in again." }],
  );

  const silentModal = {
    innerText: "Your session has expired. Please log in again.",
    textContent: "Your session has expired. Please log in again.",
    getAttribute: () => null,
    querySelectorAll: () => [],
  };
  assert.deepEqual(
    chatGptAlertCandidates({ dialogs: [silentModal] }),
    [],
    "a modal with no alert region classified on its own body text",
  );
});

test("an alert seen before an action is not that action's refusal", () => {
  const stale = alertElement("Upload failed: the file is too large.");
  const sources = { composerForm: alertRoot(stale), attachmentsStaged: true };
  const snapshot = chatGptAlertSnapshot(sources);
  assert.deepEqual([...snapshot.values()], ["Upload failed: the file is too large."]);
  assert.deepEqual(chatGptAlertCandidates({ ...sources, ignoreElements: snapshot }), []);
});

test("a remembered alert that rewrites itself in place is new again", () => {
  // ARIA live regions are reused: the node stays, the words change. Remembering the node alone
  // would hide the second refusal behind the first.
  const region = { innerText: "Uploading…", textContent: "Uploading…", getAttribute: () => null };
  const sources = { composerForm: alertRoot(region), attachmentsStaged: true };
  const snapshot = chatGptAlertSnapshot(sources);
  assert.deepEqual(chatGptAlertCandidates({ ...sources, ignoreElements: snapshot }), []);

  region.innerText = "Upload failed: the file is too large.";
  region.textContent = region.innerText;
  assert.deepEqual(
    chatGptAlertCandidates({ ...sources, ignoreElements: snapshot }),
    [{ scope: "attachment", text: "Upload failed: the file is too large." }],
  );
});

test("an alert the reader cannot see is not a candidate", () => {
  const hiddenByStyle = alertElement("Something went wrong. Please try again.");
  const shown = alertElement("Something went wrong. Please try again.");
  const sources = {
    responseRoot: alertRoot(hiddenByStyle, shown),
    isVisible: (element) => element !== hiddenByStyle,
  };
  assert.deepEqual(chatGptAlertElements(sources), [shown]);
  assert.equal(chatGptAlertCandidates(sources).length, 1);
  assert.deepEqual(
    chatGptAlertCandidates({ responseRoot: alertRoot(hiddenByStyle), isVisible: () => false }),
    [],
  );
});

test("a dialog nobody can see speaks for nothing inside it", () => {
  const alert = alertElement("Your session has expired. Please log in again.");
  const dialog = {
    innerText: "modal",
    textContent: "modal",
    getAttribute: () => null,
    querySelectorAll: () => [alert],
  };
  assert.deepEqual(
    chatGptAlertCandidates({ dialogs: [dialog], isVisible: (element) => element !== dialog }),
    [],
  );
});

test("a second refusal worded exactly like the first is still a new alert", () => {
  // Correlating by wording hid this: the provider replaces the alert node and repeats itself, and
  // a text-keyed filter reads the fresh refusal as the one already accounted for.
  const text = "Upload failed: the file is too large.";
  const stale = alertElement(text);
  const replacement = alertElement(text);
  const ignored = new Map([[stale, text]]);
  assert.deepEqual(
    chatGptAlertCandidates({
      composerForm: alertRoot(replacement),
      attachmentsStaged: true,
      ignoreElements: ignored,
    }),
    [{ scope: "attachment", text }],
  );
  // Both on screen at once: the remembered one stays ignored, the new one is reported.
  assert.deepEqual(
    chatGptAlertCandidates({
      composerForm: alertRoot(stale, replacement),
      attachmentsStaged: true,
      ignoreElements: ignored,
    }),
    [{ scope: "attachment", text }],
  );
});

test("wire codes are stable and separate from the provider's own words", () => {
  assert.deepEqual(
    Object.fromEntries(
      ["rate_limited", "session_expired", "subscription_unavailable", "response_failed", "attachment_rejected"]
        .map((code) => [code, chatGptAlertErrorCode(code)]),
    ),
    {
      rate_limited: "PROVIDER_RATE_LIMITED",
      session_expired: "PROVIDER_SESSION_EXPIRED",
      subscription_unavailable: "PROVIDER_SUBSCRIPTION_UNAVAILABLE",
      response_failed: "PROVIDER_RESPONSE_FAILED",
      attachment_rejected: "PROVIDER_ATTACHMENT_REJECTED",
    },
  );
});

test("a live region that clears and says the same thing again is new", () => {
  // Node and wording both match the remembered alert, so only the adapter's revision stamp can
  // tell that the region emptied and refilled in between.
  const region = {
    innerText: "Upload failed: the file is too large.",
    textContent: "Upload failed: the file is too large.",
    getAttribute: () => null,
  };
  let revision = 0;
  const sources = {
    composerForm: alertRoot(region),
    attachmentsStaged: true,
    alertToken: (element, text) => `${revision} ${text}`,
  };
  const snapshot = chatGptAlertSnapshot(sources);
  assert.deepEqual(chatGptAlertCandidates({ ...sources, ignoreElements: snapshot }), []);

  // Cleared, then refilled with exactly the same words. Two mutations, same node, same text.
  region.innerText = "";
  region.textContent = "";
  revision += 1;
  region.innerText = "Upload failed: the file is too large.";
  region.textContent = region.innerText;
  revision += 1;

  assert.deepEqual(
    chatGptAlertCandidates({ ...sources, ignoreElements: snapshot }),
    [{ scope: "attachment", text: "Upload failed: the file is too large." }],
    "a cleared and refilled live region was mistaken for the alert already accounted for",
  );
});

test("without a revision stamp the token is the wording alone", () => {
  const region = alertElement("Something went wrong. Please try again.");
  const sources = { responseRoot: alertRoot(region) };
  assert.deepEqual([...chatGptAlertSnapshot(sources).values()], [
    "Something went wrong. Please try again.",
  ]);
});

const settledTurn = {
  busyObserved: true,
  currentlyBusy: false,
  responseText: "complete",
  quietForMs: 1_000,
  requiredQuietMs: 1_000,
  idleForMs: 1_000,
  requiredIdleMs: 1_000,
};

const withEvidence = (overrides) => ({
  ...settledTurn,
  candidateStable: true,
  actionMissingForMs: 0,
  actionGraceMs: 2_000,
  ...overrides,
});

test("a proven end-of-turn control is required, and its presence completes the turn", () => {
  assert.equal(completionOutcome(withEvidence({ completionActionVisible: true })), "complete");
  assert.equal(completionOutcome(withEvidence({ completionActionVisible: false })), "wait");
});

test("an end-of-turn control that arrives late still completes the turn", () => {
  assert.equal(
    completionOutcome(
      withEvidence({ completionActionVisible: false, actionMissingForMs: 1_999 }),
    ),
    "wait",
  );
  assert.equal(
    completionOutcome(
      withEvidence({ completionActionVisible: true, actionMissingForMs: 1_999 }),
    ),
    "complete",
  );
});

test("stopped without an end-of-turn control is DOM drift, never a completion", () => {
  assert.equal(
    completionOutcome(
      withEvidence({ completionActionVisible: false, actionMissingForMs: 2_000 }),
    ),
    "domDrift",
  );
  assert.equal(
    shouldCompleteResponse(
      withEvidence({ completionActionVisible: false, actionMissingForMs: 60_000 }),
    ),
    false,
  );
});

test("neither terminal answer is given about a candidate that is still moving", () => {
  // A control read from a response about to be replaced says nothing about the replacement, and
  // drift declared mid-rerender is a verdict on a page that has not finished speaking.
  assert.equal(
    completionOutcome(
      withEvidence({ candidateStable: false, completionActionVisible: true }),
    ),
    "wait",
  );
  assert.equal(
    completionOutcome(
      withEvidence({
        candidateStable: false,
        completionActionVisible: false,
        actionMissingForMs: 600_000,
      }),
    ),
    "wait",
  );
});

test("the missing-action clock is separate from idle and generation time", () => {
  // Long generation and long idle settling do not spend the grace: only time already observed as
  // settled, stable and actionless counts, and the caller restarts it whenever that stops holding.
  assert.equal(
    completionOutcome(
      withEvidence({
        completionActionVisible: false,
        idleForMs: 600_000,
        quietForMs: 600_000,
        actionMissingForMs: 0,
      }),
    ),
    "wait",
  );
});

test("evidence never completes or drifts an unsettled turn", () => {
  for (const unsettled of [
    { currentlyBusy: true },
    { responseText: "" },
    { idleForMs: 999 },
    { quietForMs: 999 },
    { busyObserved: false },
  ]) {
    assert.equal(completionSettled({ ...settledTurn, ...unsettled }), false);
    assert.equal(
      completionOutcome(withEvidence({ ...unsettled, completionActionVisible: true })),
      "wait",
      `settled with ${JSON.stringify(unsettled)}`,
    );
    assert.equal(
      completionOutcome(
        withEvidence({
          ...unsettled,
          completionActionVisible: false,
          actionMissingForMs: 60_000,
        }),
      ),
      "wait",
      `drifted with ${JSON.stringify(unsettled)}`,
    );
  }
});

test("a provider with no proven control keeps the lifecycle rule exactly", () => {
  assert.equal(completionSettled(settledTurn), true);
  assert.equal(completionOutcome(settledTurn), "complete");
  assert.equal(shouldCompleteResponse(settledTurn), true);
  // Stability and grace fields are meaningless without a proven control and never withhold a
  // completion from a provider that has none.
  assert.equal(
    completionOutcome({ ...settledTurn, candidateStable: false, actionMissingForMs: 0 }),
    "complete",
  );
});

const conversationDom = () => createGenericDom(`
  <article data-testid="conversation-turn-2">
    <div data-message-author-role="assistant" id="answered"></div>
    <button data-testid="copy-turn-action-button"></button>
  </article>
  <article data-testid="conversation-turn-4">
    <div data-message-author-role="assistant" id="answering"></div>
  </article>
  <button data-testid="copy-turn-action-button" id="loose"></button>
`);

const visibleAlways = () => true;

test("the turn identity distinguishes a reparented response from a stable one", () => {
  const dom = conversationDom();
  assert.equal(chatGptTurnIdentity(dom.query("#answered")), "conversation-turn-2");
  assert.equal(chatGptTurnIdentity(dom.query("#answering")), "conversation-turn-4");
  assert.equal(chatGptTurnIdentity(dom.query("#loose")), "");
});

test("an end-of-turn control counts only inside the turn holding the bound response", () => {
  const dom = conversationDom();
  assert.equal(
    chatGptCompletionActionVisible({
      response: dom.query("#answered"),
      isVisible: visibleAlways,
    }),
    true,
  );
  // The control belongs to the earlier answer, and one sits outside every turn. Neither says
  // anything about the response still being written.
  assert.equal(
    chatGptCompletionActionVisible({
      response: dom.query("#answering"),
      isVisible: visibleAlways,
    }),
    false,
  );
});

test("an end-of-turn control nobody can see is not evidence", () => {
  const dom = conversationDom();
  assert.equal(
    chatGptCompletionActionVisible({
      response: dom.query("#answered"),
      isVisible: () => false,
    }),
    false,
  );
});

test("without a turn container the bound response is the root, never the document", () => {
  const dom = createGenericDom(`
    <div data-message-author-role="assistant" id="own-actions">
      <button data-testid="copy-turn-action-button"></button>
    </div>
    <div data-message-author-role="assistant" id="bare"></div>
    <button data-testid="copy-turn-action-button" id="loose"></button>
  `);
  assert.equal(
    chatGptCompletionActionVisible({
      response: dom.query("#own-actions"),
      isVisible: visibleAlways,
    }),
    true,
  );
  assert.equal(
    chatGptCompletionActionVisible({
      response: dom.query("#bare"),
      isVisible: visibleAlways,
    }),
    false,
  );
});

const observationFault = (overrides) => chatGptObservationFaultVerdict({
  isTypeError: true,
  consecutiveFaults: 1,
  maximumFaults: 8,
  ...overrides,
});

test("a reader fault inside the budget is re-observed rather than ending the turn", () => {
  assert.equal(observationFault({ consecutiveFaults: 1 }), "reobserve");
  assert.equal(observationFault({ consecutiveFaults: 8 }), "reobserve");
});

test("an exhausted budget fails with the original fault", () => {
  assert.equal(observationFault({ consecutiveFaults: 9 }), "rethrow");
  assert.equal(observationFault({ consecutiveFaults: 100 }), "rethrow");
});

test("only a reader fault is re-observed, and only against its own budget", () => {
  // Everything else is the page or the protocol speaking: a changed conversation, a provider
  // alert, a cancelled or expired request, a stream or serialization failure. None is re-read.
  assert.equal(observationFault({ isTypeError: false, consecutiveFaults: 1 }), "rethrow");
  assert.equal(observationFault({ isTypeError: false, consecutiveFaults: 0 }), "rethrow");
  assert.equal(observationFault({ maximumFaults: 0, consecutiveFaults: 1 }), "rethrow");
});

// BB-7. `cancelledRequests` grew without bound: the two pre-submit cancellations registered by
// `interrupt()` had no `conversation.send` following them for the same id, so nothing ever
// removed those entries. The bound now lives in one tested place instead of two copies.
test("an ordinary cancellation is held until its own request clears it", () => {
  const scheduled = [];
  const registry = globalThis.__pairChatGptLogic.createCancellationRegistry({
    isActive: () => false,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
  });

  registry.add("request-1");
  assert.equal(registry.has("request-1"), true);
  assert.equal(registry.size(), 1);
  // Nothing expires an ordinary cancellation: the send that follows it removes it.
  assert.deepEqual(scheduled, []);
  assert.equal(registry.delete("request-1"), true);
  assert.equal(registry.has("request-1"), false);
  assert.equal(registry.size(), 0);
});

test("a pre-submit cancellation is dropped once its bound expires", () => {
  const scheduled = [];
  const registry = globalThis.__pairChatGptLogic.createCancellationRegistry({
    isActive: () => false,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
  });

  registry.rememberPreSubmit("request-1");
  assert.equal(registry.has("request-1"), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 30_000);

  scheduled[0].callback();
  assert.equal(registry.has("request-1"), false);
  assert.equal(registry.size(), 0);
});

test("a pre-submit cancellation that became the active request is kept", () => {
  const scheduled = [];
  let active = "";
  const registry = globalThis.__pairChatGptLogic.createCancellationRegistry({
    isActive: (requestId) => requestId === active,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
  });

  registry.rememberPreSubmit("request-1");
  active = "request-1";
  scheduled[0].callback();
  // The running turn still owns the decision, so the bound does not take the entry away.
  assert.equal(registry.has("request-1"), true);
});

test("the bound is configurable and every pre-submit entry gets its own", () => {
  const scheduled = [];
  const registry = globalThis.__pairChatGptLogic.createCancellationRegistry({
    isActive: () => false,
    preSubmitTtlMs: 5_000,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
  });

  registry.rememberPreSubmit("request-1");
  registry.rememberPreSubmit("request-2");
  assert.equal(registry.size(), 2);
  assert.deepEqual(scheduled.map((entry) => entry.delayMs), [5_000, 5_000]);
  scheduled.forEach((entry) => entry.callback());
  assert.equal(registry.size(), 0);
});

test("the registry schedules on the real timer when none is supplied", async () => {
  const registry = globalThis.__pairChatGptLogic.createCancellationRegistry({
    isActive: () => false,
    preSubmitTtlMs: 1,
  });
  registry.rememberPreSubmit("request-1");
  assert.equal(registry.has("request-1"), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(registry.has("request-1"), false);
});

// BB-4. The message table both provider entries answer was byte-identical in each of them, so
// a change to how a failure is reported had to be made twice and could silently be made once.
// It is one implementation now, and this is where its replies are pinned.
const listenerFor = (overrides = {}) => {
  const calls = [];
  const record = (name, value) => {
    calls.push(name);
    return value;
  };
  const handlers = {
    ensureRegisteredUrl: () => record("ensureRegisteredUrl"),
    providerStatus: async () => record("providerStatus", { status: "ready" }),
    registerDocument: async () => record("registerDocument"),
    submit: async () => record("submit", { submitted: true }),
    interrupt: async () => record("interrupt", { interrupted: true }),
    assetMetadata: () => record("assetMetadata", { id: "asset-1" }),
    assetRevealer: () => record("assetRevealer", () => record("reveal")),
    fetchAsset: () => record("fetchAsset"),
    cancelAsset: () => record("cancelAsset", true),
    ...overrides,
  };
  return {
    calls,
    listen: globalThis.__pairChatGptLogic.createProviderMessageListener(handlers),
  };
};

const answer = (listen, message) => {
  let settle;
  const replied = new Promise((resolve) => {
    settle = resolve;
  });
  const kept = listen(message, {}, settle);
  return { kept, replied };
};

test("a status request re-registers the url and answers asynchronously", async () => {
  const { calls, listen } = listenerFor();
  const { kept, replied } = answer(listen, { type: "provider.status" });
  assert.equal(kept, true);
  assert.deepEqual(await replied, { status: "ready" });
  assert.deepEqual(calls, ["ensureRegisteredUrl", "providerStatus"]);
});

test("a failing status request is reported as a failed status, not a rejection", async () => {
  const { listen } = listenerFor({
    providerStatus: async () => {
      throw new Error("the page went away");
    },
  });
  const { replied } = answer(listen, { type: "provider.status" });
  assert.deepEqual(await replied, { status: "failed", error: "the page went away" });
});

test("re-registration answers success, and its failure carries the cause", async () => {
  const { listen } = listenerFor();
  const { kept, replied } = answer(listen, { type: "content.reregister" });
  assert.equal(kept, true);
  assert.deepEqual(await replied, { success: true });

  const failing = listenerFor({
    registerDocument: async () => {
      throw new Error("no document token");
    },
  });
  assert.deepEqual(
    await answer(failing.listen, { type: "content.reregister" }).replied,
    { success: false, error: "no document token" },
  );
});

test("a send and an interrupt each report their own failure shape", async () => {
  const send = listenerFor({
    submit: async () => {
      throw new Error("composer is blocked");
    },
  });
  const sendReply = answer(send.listen, { type: "conversation.send" });
  assert.equal(sendReply.kept, true);
  assert.deepEqual(await sendReply.replied, {
    submitted: false,
    error: "composer is blocked",
  });

  const stop = listenerFor({
    interrupt: async () => {
      throw new Error("no stop control");
    },
  });
  const stopReply = answer(stop.listen, { type: "conversation.interrupt" });
  assert.equal(stopReply.kept, true);
  assert.deepEqual(await stopReply.replied, {
    interrupted: false,
    error: "no stop control",
  });
});

test("a rejection that is not an Error is still reported as text", async () => {
  const { listen } = listenerFor({
    submit: async () => {
      throw "composer refused";
    },
  });
  assert.deepEqual(await answer(listen, { type: "conversation.send" }).replied, {
    submitted: false,
    error: "composer refused",
  });
});

test("a send and an interrupt pass their own message through", async () => {
  const seen = [];
  const { listen } = listenerFor({
    submit: async (message) => {
      seen.push(message);
      return { submitted: true };
    },
    interrupt: async (message) => {
      seen.push(message);
      return { interrupted: true };
    },
  });
  await answer(listen, { type: "conversation.send", requestId: "a" }).replied;
  await answer(listen, { type: "conversation.interrupt", requestId: "b" }).replied;
  assert.deepEqual(seen.map((message) => message.requestId), ["a", "b"]);
});

test("an asset probe answers synchronously, with the asset only when there is one", async () => {
  const { listen, calls } = listenerFor();
  const found = answer(listen, { type: "asset.probe", assetId: "asset-1" });
  assert.equal(found.kept, false);
  assert.deepEqual(await found.replied, { success: true, asset: { id: "asset-1" } });
  assert.deepEqual(calls, ["assetMetadata"]);

  const missing = listenerFor({ assetMetadata: () => undefined });
  const absent = answer(missing.listen, { type: "asset.probe", assetId: "gone" });
  const reply = await absent.replied;
  assert.deepEqual(reply, { success: true });
  assert.equal(Object.hasOwn(reply, "asset"), false);
});

test("revealing an asset reports absence, failure and success apart", async () => {
  const gone = listenerFor({ assetRevealer: () => undefined });
  const absent = answer(gone.listen, { type: "asset.reveal", assetId: "gone" });
  assert.equal(absent.kept, false);
  assert.deepEqual(await absent.replied, {
    success: false,
    error: "The provider asset is no longer visible in this document",
  });

  const broken = listenerFor({
    assetRevealer: () => () => {
      throw new Error("the node was detached");
    },
  });
  assert.deepEqual(await answer(broken.listen, { type: "asset.reveal" }).replied, {
    success: false,
    error: "the node was detached",
  });

  const working = listenerFor();
  assert.deepEqual(await answer(working.listen, { type: "asset.reveal" }).replied, {
    success: true,
  });
  assert.deepEqual(working.calls, ["assetRevealer", "reveal"]);
});

test("a fetch is accepted before the transfer starts, and a cancel reports its outcome", async () => {
  const { listen, calls } = listenerFor();
  const fetched = answer(listen, { type: "asset.fetch", assetId: "asset-1" });
  assert.equal(fetched.kept, false);
  assert.deepEqual(await fetched.replied, { success: true, accepted: true });
  // The reply is sent before the transfer is started, which is what keeps the channel free.
  assert.deepEqual(calls, ["fetchAsset"]);

  const cancelled = answer(listen, { type: "asset.cancel", assetId: "asset-1" });
  assert.equal(cancelled.kept, false);
  assert.deepEqual(await cancelled.replied, { success: true });

  const unknownTransfer = listenerFor({ cancelAsset: () => false });
  assert.deepEqual(
    await answer(unknownTransfer.listen, { type: "asset.cancel" }).replied,
    { success: false },
  );
});

test("a message the provider does not own is declined without a reply", () => {
  const { listen, calls } = listenerFor();
  let replied = false;
  assert.equal(listen({ type: "BACHATA_GENERIC_STATUS" }, {}, () => {
    replied = true;
  }), false);
  assert.equal(replied, false);
  assert.deepEqual(calls, []);
});

// BB-4. Both provider entries drove an asset transfer with a byte-identical copy of this,
// differing only in the sentence shown when the asset is gone. Nothing reached its cancelled
// or already-active paths, because doing so meant driving a real transfer in a real page.
const transferDriver = (overrides = {}) => {
  const sent = [];
  const sources = new Map([["asset-1", { id: "asset-1" }]]);
  const driver = globalThis.__pairChatGptLogic.createAssetTransferDriver({
    documentToken: "document-1",
    unavailableMessage: "The ChatGPT asset is no longer available in this document",
    assetSources: { get: (assetId) => sources.get(assetId) },
    sendBackground: async (message) => {
      sent.push(message);
      return { success: true };
    },
    transferAsset: async () => ({ size: 3, sha256: "a".repeat(64) }),
    ...overrides,
  });
  return { driver, sent, sources };
};

const fetchMessage = (overrides = {}) => ({
  transferId: "transfer-1",
  assetId: "asset-1",
  maxBytes: 1_000,
  ...overrides,
});

test("a completed transfer reports its start, its chunks and its digest", async () => {
  const { driver, sent } = transferDriver({
    transferAsset: async (_source, _maxBytes, _signal, hooks) => {
      await hooks.start({ name: "diagram.png", mimeType: "image/png", size: 3 });
      await hooks.chunk(0, "AAA=");
      await hooks.chunk(1, "BBB=");
      return { size: 3, sha256: "b".repeat(64) };
    },
  });
  await driver.fetchAsset(fetchMessage());
  assert.deepEqual(sent.map((message) => message.type), [
    "content.asset.start",
    "content.asset.chunk",
    "content.asset.chunk",
    "content.asset.complete",
  ]);
  assert.equal(sent[0].name, "diagram.png");
  assert.deepEqual(sent.slice(1, 3).map((message) => message.sequence), [0, 1]);
  assert.equal(sent[3].sha256, "b".repeat(64));
  sent.forEach((message) => {
    assert.equal(message.documentToken, "document-1");
    assert.equal(message.transferId, "transfer-1");
    assert.equal(message.assetId, "asset-1");
  });
  assert.equal(driver.activeTransfers(), 0, "a finished transfer was not forgotten");
});

test("an asset this document no longer holds is reported, not thrown", async () => {
  const { driver, sent } = transferDriver();
  await driver.fetchAsset(fetchMessage({ assetId: "gone" }));
  assert.deepEqual(sent, [{
    type: "content.asset.error",
    documentToken: "document-1",
    transferId: "transfer-1",
    assetId: "gone",
    code: "ASSET_UNAVAILABLE",
    message: "The ChatGPT asset is no longer available in this document",
  }]);
  assert.equal(driver.activeTransfers(), 0);
});

test("a transfer identifier is used once", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { driver } = transferDriver({
    transferAsset: async () => {
      await held;
      return { size: 1, sha256: "c".repeat(64) };
    },
  });
  const first = driver.fetchAsset(fetchMessage());
  await assert.rejects(
    driver.fetchAsset(fetchMessage()),
    /transfer identifier is already active/u,
  );
  release();
  await first;
  // Once it finishes the identifier is free again, so a retry is not refused as a duplicate.
  assert.equal(driver.activeTransfers(), 0);
  await driver.fetchAsset(fetchMessage());
});

test("a cancelled transfer is reported as cancelled, not as a failure", async () => {
  const { driver, sent } = transferDriver({
    transferAsset: async (_source, _maxBytes, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The transfer was cancelled", "AbortError"));
        }, { once: true });
      }),
  });
  const running = driver.fetchAsset(fetchMessage());
  assert.equal(driver.cancelAsset({ transferId: "transfer-1", assetId: "asset-1" }), true);
  await running;
  const error = sent.find((message) => message.type === "content.asset.error");
  assert.equal(error.code, "ASSET_CANCELLED");
  assert.equal(driver.activeTransfers(), 0);
});

test("a transfer that fails for any other reason is reported as a failure", async () => {
  const { driver, sent } = transferDriver({
    transferAsset: async () => {
      throw new Error("the reader stopped");
    },
  });
  await driver.fetchAsset(fetchMessage());
  assert.deepEqual(sent.at(-1), {
    type: "content.asset.error",
    documentToken: "document-1",
    transferId: "transfer-1",
    assetId: "asset-1",
    code: "ASSET_FETCH_FAILED",
    message: "the reader stopped",
  });
  assert.equal(driver.activeTransfers(), 0);
});

test("a failure that cannot even be reported still forgets the transfer", async () => {
  const { driver } = transferDriver({
    sendBackground: async () => {
      throw new Error("the background is gone");
    },
    transferAsset: async () => {
      throw new Error("the reader stopped");
    },
  });
  await driver.fetchAsset(fetchMessage());
  assert.equal(driver.activeTransfers(), 0);
});

test("only the transfer that owns an asset may be cancelled", async () => {
  const { driver } = transferDriver({
    transferAsset: async (_source, _maxBytes, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ size: 0, sha256: "d".repeat(64) }), {
          once: true,
        });
      }),
  });
  const running = driver.fetchAsset(fetchMessage());
  assert.equal(driver.cancelAsset({ transferId: "other", assetId: "asset-1" }), false);
  assert.equal(driver.cancelAsset({ transferId: "transfer-1", assetId: "other" }), false);
  assert.equal(driver.cancelAsset({ transferId: "transfer-1", assetId: "asset-1" }), true);
  await running;
});

// BB-4. The seven-answer status projection. Both provider entries held a byte-identical copy of
// it; what the shared one has to keep is the order the answers are decided in, because each of
// them is a different instruction to the controller.

const statusReader = (overrides = {}) =>
  globalThis.__pairChatGptLogic.createProviderStatusReader({
    provider: "chatgpt",
    documentToken: "document-1",
    currentUrl: () => "https://chatgpt.com/c/one",
    conversationIdentityFor: (url) => `chatgpt:${url}`,
    conversationIsQuarantined: async () => false,
    resolveComposer: async () => ({ tagName: "TEXTAREA" }),
    onAuthenticationPath: () => false,
    composerBlockedReason: () => undefined,
    generationActive: () => false,
    composerConflict: () => undefined,
    ...overrides,
  });

test("a page with a usable composer and nothing in the way is ready", async () => {
  assert.deepEqual(await statusReader()(), {
    status: "ready",
    documentToken: "document-1",
    conversationUrl: "https://chatgpt.com/c/one",
    conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
    conversationState: "confirmed",
  });
});

test("no composer is a sign-in page or a page still loading, and they are different answers", async () => {
  assert.equal(
    (await statusReader({ resolveComposer: async () => undefined })()).status,
    "notReady",
  );
  assert.equal(
    (await statusReader({
      resolveComposer: async () => undefined,
      onAuthenticationPath: () => true,
    })()).status,
    "notAuthenticated",
  );
});

test("a quarantined conversation is failed however usable the page looks", async () => {
  const answer = await statusReader({ conversationIsQuarantined: async () => true })();
  assert.equal(answer.status, "failed");
  assert.equal(answer.conversationState, "uncertain");
});

test("a quarantined conversation with no composer still reports the page, not the verdict", async () => {
  // Which is the user's to act on: a sign-in page has to say so even when the conversation it
  // would lead back to is quarantined.
  const answer = await statusReader({
    conversationIsQuarantined: async () => true,
    resolveComposer: async () => undefined,
    onAuthenticationPath: () => true,
  })();
  assert.equal(answer.status, "notAuthenticated");
  assert.equal(answer.conversationState, "uncertain");
});

test("a blocked composer is failed, and generation in progress is streaming", async () => {
  assert.equal(
    (await statusReader({ composerBlockedReason: () => "blocked" })()).status,
    "failed",
  );
  assert.equal(
    (await statusReader({ generationActive: () => true })()).status,
    "streaming",
  );
});

test("a blocked composer is failed before generation is considered", async () => {
  assert.equal(
    (await statusReader({
      composerBlockedReason: () => "blocked",
      generationActive: () => true,
    })()).status,
    "failed",
  );
});

test("a composer the page has more than one of is not ready rather than chosen between", async () => {
  assert.equal(
    (await statusReader({ composerConflict: () => "two composers" })()).status,
    "notReady",
  );
});

test("an empty conflict reason is still a conflict", async () => {
  // The hook answers with why, and "" is a why. Treating it as no conflict would let a page
  // that named its problem badly be reported as ready.
  assert.equal((await statusReader({ composerConflict: () => "" })()).status, "notReady");
});

test("a page that threw while being read is not ready, and is not a failure to clear", async () => {
  const answer = await statusReader({
    resolveComposer: () => { throw new Error("the page went away"); },
  })();
  assert.equal(answer.status, "notReady");
  assert.equal(answer.conversationState, "confirmed");
});

test("the quarantine authority is asked once per status call, whatever the answer", async () => {
  for (const overrides of [
    {},
    { resolveComposer: async () => undefined },
    { composerBlockedReason: () => "blocked" },
    { generationActive: () => true },
    { composerConflict: () => "two composers" },
    { resolveComposer: () => { throw new Error("gone"); } },
  ]) {
    let asked = 0;
    await statusReader({
      ...overrides,
      conversationIsQuarantined: async () => { asked += 1; return false; },
    })();
    assert.equal(asked, 1, JSON.stringify(Object.keys(overrides)));
  }
});

test("the provider name the authority is asked about is the configured one", async () => {
  const asked = [];
  await statusReader({
    provider: "claude",
    conversationIsQuarantined: async (provider, identity) => {
      asked.push([provider, identity]);
      return false;
    },
  })();
  assert.deepEqual(asked, [["claude", "chatgpt:https://chatgpt.com/c/one"]]);
});

test("the url is read once and every answer reports the same one", async () => {
  let reads = 0;
  const answer = await statusReader({
    currentUrl: () => {
      reads += 1;
      return `https://chatgpt.com/c/${String(reads)}`;
    },
  })();
  assert.equal(reads, 1, "the url moved between the identity and the answer");
  assert.equal(answer.conversationUrl, "https://chatgpt.com/c/1");
  assert.equal(answer.conversationIdentity, "chatgpt:https://chatgpt.com/c/1");
});

test("a composer resolved synchronously is accepted as readily as an awaited one", async () => {
  assert.equal(
    (await statusReader({ resolveComposer: () => ({ tagName: "DIV" }) })()).status,
    "ready",
  );
});

// BB-4. The response serializer. Both entries carried it byte for byte, differing only in the
// name of the part type. It walks a subtree the caller has already bound and decides what counts
// as content.

const serializerDom = createGenericDom("<main></main>");

const partsOf = (html) => {
  const root = serializerDom.document.createElement("div");
  root.innerHTML = html;
  return globalThis.__pairChatGptLogic.captureResponseParts(root);
};

test("plain prose is one run of text", () => {
  assert.deepEqual(partsOf("hello"), [{ type: "text", text: "hello" }]);
});

test("nothing a reader cannot read becomes content", () => {
  // A button is a control, an SVG is a picture, a script and a style are neither, and hidden
  // means hidden. A response that swallowed any of them would send the page's furniture to the
  // controller as if the model had written it.
  assert.deepEqual(partsOf("<button>Copy</button>"), []);
  assert.deepEqual(partsOf("<script>alert(1)</script>"), []);
  assert.deepEqual(partsOf("<style>p{}</style>"), []);
  assert.deepEqual(partsOf("<noscript>fallback</noscript>"), []);
  const hidden = partsOf("<p hidden>secret</p>");
  assert.deepEqual(hidden, []);
  assert.deepEqual(partsOf("<p aria-hidden=\"true\">secret</p>"), []);
});

test("a code block is one part carrying its language, not a run of text lines", () => {
  const parts = partsOf("<pre data-language=\"python\"><code>print(1)</code></pre>");
  const code = parts.find((part) => part.type === "codeBlock");
  assert.notEqual(code, undefined);
  assert.equal(code.language, "python");
  assert.match(code.text, /print\(1\)/u);
});

test("a language named by class is read when no attribute names one", () => {
  const parts = partsOf("<pre><code class=\"language-rust\">fn main(){}</code></pre>");
  assert.equal(parts.find((part) => part.type === "codeBlock").language, "rust");
});

test("a code block with no language stated carries none rather than a guess", () => {
  const code = partsOf("<pre><code>plain</code></pre>").find((part) => part.type === "codeBlock");
  assert.equal("language" in code, false);
});

test("a quote is one part, because flattening it loses what it was", () => {
  const parts = partsOf("<blockquote>quoted</blockquote>");
  assert.equal(parts.some((part) => part.type === "quote" && part.text.includes("quoted")), true);
});

test("a line break becomes a newline, and repeating one does not multiply it", () => {
  const parts = partsOf("a<br><br>b");
  const text = parts.map((part) => part.text).join("");
  assert.match(text, /a\nb/u);
  assert.equal(/\n\n/u.test(text), false, "two breaks in a row produced two newlines");
});

test("block elements are separated, and nesting them does not multiply the separation", () => {
  const flat = partsOf("<p>one</p><p>two</p>").map((part) => part.text).join("");
  assert.match(flat, /one\ntwo/u);
  const nested = partsOf("<div><div><p>one</p></div></div><p>two</p>")
    .map((part) => part.text).join("");
  assert.equal(/\n\n/u.test(nested), false, "nested blocks multiplied the separator");
});

test("empty text is never pushed as content, only as block separation", () => {
  // A block still separates whatever surrounds it, so an empty one leaves a newline and never a
  // part carrying nothing. An empty subtree leaves nothing at all.
  assert.deepEqual(partsOf(""), []);
  assert.deepEqual(
    partsOf("<p></p>").filter((part) => part.text.trim() !== ""),
    [],
  );
});

test("a subtree of nothing but skipped elements contributes no content", () => {
  assert.deepEqual(
    partsOf("<div><button>a</button><style>b{}</style></div>")
      .filter((part) => part.text.trim() !== ""),
    [],
  );
});

test("both provider entries now read a response through the same serializer", async () => {
  await import("../dist/content/claudeLogic.js");
  const root = serializerDom.document.createElement("div");
  root.innerHTML = "<p>same</p><pre data-language=\"go\"><code>x</code></pre>";
  assert.deepEqual(
    globalThis.__pairChatGptLogic.captureResponseParts(root),
    globalThis.__pairClaudeLogic.captureResponseParts(root),
  );
});

// BB-4. Stopping a turn and knowing that it stopped. Both entries carried this byte for byte;
// what differs is which element is Stop and what busy means on that page, both passed in.

const interruptHarness = (overrides = {}) => {
  const cancelled = new Set();
  let clock = 0;
  const clicks = [];
  const stop = { click: () => clicks.push("stop") };
  const state = {
    cancelled,
    clicks,
    clock: () => clock,
    control: globalThis.__pairChatGptLogic.createInterruptControl({
      stopButton: () => stop,
      isBusy: () => false,
      heal: async () => false,
      delay: async (ms) => { clock += ms; },
      // The polling resolver is injected in a page from another file, so it is passed here too.
      waitForResolvedControl: globalThis.__pairProviderControls.waitForResolvedControl,
      now: () => clock,
      rememberCancellation: (id) => cancelled.add(id),
      forgetCancellation: (id) => { cancelled.delete(id); },
      stillBound: () => true,
      ...overrides,
    }),
  };
  return state;
};

test("a provider is believed stopped only after it stays idle for a full second", async () => {
  let reads = 0;
  const harness = interruptHarness({ isBusy: () => { reads += 1; return false; } });
  assert.equal(await harness.control.confirmStopped(), true);
  // One idle reading is never enough: the loop has to see idle across the settle window.
  assert.ok(reads > 1, "a single idle reading confirmed a stop");
});

test("a provider that flickers back to busy restarts the idle window", async () => {
  // Idle, idle, busy, then idle forever. The busy reading must throw away the idle time before
  // it, or a mid-turn flicker reads as a completed stop.
  const readings = [false, false, true];
  let index = 0;
  const harness = interruptHarness({
    isBusy: () => (index < readings.length ? readings[index++] : false),
  });
  assert.equal(await harness.control.confirmStopped(), true);
  assert.ok(harness.clock() >= 1_000, "the window did not restart after the flicker");
});

test("a provider that never goes idle is not confirmed stopped, and gives up on its own", async () => {
  const harness = interruptHarness({ isBusy: () => true });
  assert.equal(await harness.control.confirmStopped(), false);
  assert.ok(harness.clock() >= 10_000, "it gave up before its own deadline");
});

test("a page that cannot be asked is not a page that answered idle", async () => {
  const harness = interruptHarness({
    isBusy: () => { throw new Error("the page went away"); },
  });
  assert.equal(await harness.control.confirmStopped(), false);
});

test("an interrupt records the cancellation before it clicks anything", async () => {
  const order = [];
  const harness = interruptHarness({
    isBusy: () => false,
    stopButton: () => ({ click: () => order.push("click") }),
    rememberCancellation: (id) => order.push(`remember:${id}`),
  });
  assert.equal(await harness.control.interruptAndConfirm("request-1"), true);
  assert.deepEqual(order.slice(0, 2), ["remember:request-1", "click"]);
});

test("an unconfirmed interrupt takes its cancellation back", async () => {
  // The caller has to see that the interrupt did not land, so it can quarantine. A request left
  // marked cancelled while the provider may still be answering is the dangerous outcome.
  const harness = interruptHarness({ isBusy: () => true });
  assert.equal(await harness.control.interruptAndConfirm("request-2"), false);
  assert.equal(harness.cancelled.has("request-2"), false);
});

test("no stop control and one required is refused without clicking anything", async () => {
  const harness = interruptHarness({ stopButton: () => undefined });
  assert.equal(await harness.control.interruptAndConfirm("request-3"), false);
  assert.deepEqual(harness.clicks, []);
  assert.equal(harness.cancelled.has("request-3"), false);
});

test("no stop control, when one is not required, still confirms on an idle provider", async () => {
  const harness = interruptHarness({ stopButton: () => undefined, isBusy: () => false });
  assert.equal(await harness.control.interruptAndConfirm("request-4", false), true);
  assert.equal(harness.cancelled.has("request-4"), true);
});

test("a confirmed interrupt leaves the cancellation recorded", async () => {
  const harness = interruptHarness({ isBusy: () => false });
  assert.equal(await harness.control.interruptAndConfirm("request-5"), true);
  assert.equal(harness.cancelled.has("request-5"), true);
});

test("waiting for a stop control gives up at its own timeout rather than the caller's patience", async () => {
  const harness = interruptHarness({ stopButton: () => undefined });
  const before = harness.clock();
  assert.equal(await harness.control.waitForStopButton(500), undefined);
  assert.ok(harness.clock() > before, "the wait did not advance its own clock");
});

// BR-G6-05. Resolving a Stop costs a poll loop and a full DOM heal; confirming one costs up to
// ten seconds of polling. The page can become a different conversation inside any of it, and a
// control resolved for one turn must not be clicked, or believed, on behalf of another —
// reporting an uninterrupted turn as stopped is the one state a retry duplicates a message from.
test("a Stop resolved while the page stopped being this turn's is never clicked", async () => {
  let bound = true;
  const harness = interruptHarness({
    // Reading the control is the last thing that happens before the await returns; the page
    // moves on immediately afterwards.
    stopButton: () => { bound = false; return { click: () => { throw new Error("clicked"); } }; },
    stillBound: () => bound,
  });
  assert.equal(await harness.control.interruptAndConfirm("request-1"), false);
  assert.deepEqual([...harness.cancelled], [], "a refused interrupt kept its cancellation");
});

test("a page that is no longer this turn's is neither resolved nor healed", async () => {
  let healed = 0;
  let resolved = 0;
  const harness = interruptHarness({
    stopButton: () => { resolved += 1; return undefined; },
    heal: async () => { healed += 1; return false; },
    stillBound: () => false,
  });
  assert.equal(await harness.control.interruptAndConfirm("request-1"), false);
  assert.equal(resolved, 0, "a foreign page was searched for this turn's Stop");
  assert.equal(healed, 0, "a foreign page was healed on this turn's behalf");
  assert.equal(harness.clock(), 0, "it waited on a page it had already abandoned");
});

test("a page that stops being this turn's while the Stop is clicked confirms nothing", async () => {
  let bound = true;
  const clicks = [];
  const harness = interruptHarness({
    // The click lands, and the page moves on before anything can be confirmed about it.
    stopButton: () => ({ click: () => { clicks.push("stop"); bound = false; } }),
    isBusy: () => false,
    stillBound: () => bound,
  });
  assert.equal(await harness.control.interruptAndConfirm("request-1"), false);
  assert.deepEqual(clicks, ["stop"], "the Stop this turn had already resolved was not clicked");
  assert.deepEqual([...harness.cancelled], [], "an unconfirmed interrupt kept its cancellation");
});

test("confirming a stop gives up the moment the page stops being this turn's", async () => {
  let bound = true;
  let reads = 0;
  const harness = interruptHarness({
    isBusy: () => { reads += 1; bound = false; return true; },
  });
  assert.equal(await harness.control.confirmStopped(() => bound), false);
  assert.equal(reads, 1, "it kept reading a page that stopped being this turn's");
  assert.ok(harness.clock() < 10_000, "it waited out its whole deadline on a foreign page");
});

test("both provider entries now interrupt through the same control", async () => {
  await import("../dist/content/claudeLogic.js");
  assert.equal(
    typeof globalThis.__pairClaudeLogic.createInterruptControl,
    typeof globalThis.__pairChatGptLogic.createInterruptControl,
  );
  // BB-A4-N01. And through the same lease over the request they are stopping.
  assert.equal(
    typeof globalThis.__pairClaudeLogic.createInterruptLease,
    typeof globalThis.__pairChatGptLogic.createInterruptLease,
  );
  const build = (logic) => {
    // An injected clock that only moves when the control waits: both the stop-control wait and
    // the idle window read it, so the whole interrupt settles without a real timer.
    let clock = 0;
    return logic.createInterruptControl({
      stopButton: () => undefined,
      isBusy: () => false,
      heal: async () => false,
      delay: async (ms) => { clock += ms; },
      waitForResolvedControl: globalThis.__pairProviderControls.waitForResolvedControl,
      now: () => clock,
      rememberCancellation: () => undefined,
      forgetCancellation: () => undefined,
      stillBound: () => true,
    });
  };
  assert.equal(
    await build(globalThis.__pairChatGptLogic).interruptAndConfirm("r"),
    await build(globalThis.__pairClaudeLogic).interruptAndConfirm("r"),
  );
});


// BB-4. The composer guard, tested where it now lives. Both providers instantiate the same
// implementation and differ only in the label inside three sentences, so each provider's test
// file asserts its own wording as well as the behaviour.
const withFileInputSetter = (state) => {
  const prototype = globalThis.HTMLInputElement.prototype;
  const previous = Object.getOwnPropertyDescriptor(prototype, "files");
  const previousTransfer = globalThis.DataTransfer;
  Object.defineProperty(prototype, "files", {
    configurable: true,
    set(value) {
      state.fileList = Array.from(value);
    },
    get() {
      return state.fileList.slice();
    },
  });
  globalThis.DataTransfer = class {
    constructor() {
      this.kept = [];
      this.items = { add: (file) => this.kept.push(file) };
    }
    get files() {
      return this.kept;
    }
  };
  return () => {
    if (previous) Object.defineProperty(prototype, "files", previous);
    else delete prototype.files;
    if (previousTransfer === undefined) delete globalThis.DataTransfer;
    else globalThis.DataTransfer = previousTransfer;
  };
};

const composerGuardFixture = (overrides = {}) => {
  const dom = createGenericDom(`
    <form id="form">
      <div id="composer"></div>
      <button id="remove" aria-label="Remove file"></button>
      <button id="unrelated" aria-label="Send message"></button>
      <button id="close" title="Close dialog"></button>
      <input id="input" type="file" />
    </form>
    <div id="loose"><button id="detached" title="Delete upload"></button></div>
  `);
  const state = {
    text: "",
    files: 0,
    removals: true,
    blocked: undefined,
    delays: 0,
    clock: 0,
    ...overrides,
  };
  const composer = dom.query("#composer");
  const input = dom.query("#input");
  // BR-G6-02. The staged files are the actual objects the guard now reasons about, not a count:
  // cleanup withdraws the exact `File` objects this request placed and leaves every other one.
  if (state.fileList === undefined) {
    state.fileList = Array.from(
      { length: state.files },
      (_, index) => ({ name: `staged-${index}.png` }),
    );
  }
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => state.fileList.slice(),
  });
  const guard = createComposerGuard({
    readComposer: () => state.text,
    writeComposer: (_element, text) => {
      if (state.writeThrows) throw new Error("composer is gone");
      state.text = text;
    },
    attachmentInput: () => (state.input === null ? undefined : input),
    // An injected clock and an injected wait: the cleanup deadline is three seconds of
    // production wall time, and a test that waited it out would prove the same thing slowly.
    delay: async () => {
      state.delays += 1;
      state.clock += 50;
    },
    now: () => state.clock,
    blockComposer: (reason) => {
      state.blocked = reason;
    },
    ...(state.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: state.cleanupTimeoutMs }),
  });
  return { dom, state, guard, composer, input };
};

test("the composer guard names the provider when the composer already holds text", () => {
  const fixture = composerGuardFixture({ text: "  drafted  " });
  try {
    assert.equal(
      fixture.guard.composerConflict(fixture.composer),
      `${PROVIDER_LABEL} composer already contains text. Send or clear it before using Bachata`,
    );
  } finally {
    fixture.dom.restore();
  }
});

test("the composer guard names the provider when something is already attached", () => {
  const staged = composerGuardFixture({ files: 1 });
  try {
    assert.equal(
      staged.guard.composerConflict(staged.composer),
      `${PROVIDER_LABEL} composer already contains attachments. Send or clear them before using Bachata`,
    );
  } finally {
    staged.dom.restore();
  }
  // A removal control is the other way an attachment shows itself: some composers stage a file
  // without the input still reporting it.
  const control = composerGuardFixture();
  try {
    assert.equal(
      control.guard.composerConflict(control.composer),
      `${PROVIDER_LABEL} composer already contains attachments. Send or clear them before using Bachata`,
    );
  } finally {
    control.dom.restore();
  }
});

test("an empty composer with nothing attached is no conflict at all", () => {
  const fixture = composerGuardFixture();
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    assert.equal(fixture.guard.composerConflict(fixture.composer), undefined);
  } finally {
    fixture.dom.restore();
  }
});

test("attachment removal controls are the ones that say they remove an attachment", () => {
  const fixture = composerGuardFixture();
  try {
    const controls = fixture.guard.attachmentRemovalControls(fixture.composer);
    assert.deepEqual(controls.map((button) => button.id), ["remove"]);
    // Outside a form the composer's own parent is the search root, so a control beside it is
    // still found and one in another part of the page is not.
    const loose = fixture.dom.query("#loose");
    assert.deepEqual(
      fixture.guard.attachmentRemovalControls(loose.querySelector("#detached")).map((b) => b.id),
      ["detached"],
    );
  } finally {
    fixture.dom.restore();
  }
});

test("withdrawing files does nothing when there is no input and nothing to set", async () => {
  const owned = { attachments: { before: [], files: [{ name: "ours.png" }], expected: 1 } };
  const missing = composerGuardFixture({ input: null });
  try {
    missing.dom.query("#remove").remove();
    missing.dom.query("#detached").remove();
    assert.equal(await missing.guard.cleanupComposer(missing.composer, owned), true);
  } finally {
    missing.dom.restore();
  }

  const fixture = composerGuardFixture();
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    // No `files` setter on the platform prototype: there is nothing to write, and writing
    // nothing is not an error.
    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, owned), true);
  } finally {
    fixture.dom.restore();
  }
});

test("withdrawing this request's files rewrites the staged list and tells the page", async () => {
  const ours = { name: "ours.png" };
  const theirs = { name: "theirs.png" };
  const fixture = composerGuardFixture({ fileList: [theirs, ours] });
  const restore = withFileInputSetter(fixture.state);
  const events = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    fixture.input.addEventListener("input", (event) => events.push(event.type));
    fixture.input.addEventListener("change", (event) => events.push(event.type));
    assert.equal(
      await fixture.guard.cleanupComposer(fixture.composer, {
        attachments: { before: [], files: [ours], expected: 1 },
      }),
      true,
    );
    assert.deepEqual(fixture.state.fileList.map((file) => file.name), ["theirs.png"]);
    assert.deepEqual(events, ["input", "change"]);
  } finally {
    restore();
    fixture.dom.restore();
  }
});

test("cleaning a composer succeeds once the text and the attachments are gone", async () => {
  const fixture = composerGuardFixture({ text: "drafted" });
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, { text: "drafted" }), true);
    assert.equal(fixture.state.text, "");
    assert.equal(fixture.state.delays, 0, "a composer that was already clean still waited");
  } finally {
    fixture.dom.restore();
  }
});

test("cleaning gives up at once when attachments may be staged and nothing can remove them", async () => {
  const fixture = composerGuardFixture();
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    assert.equal(
      await fixture.guard.cleanupComposer(fixture.composer, {
        text: "",
        attachments: { before: [], files: [], expected: 1 },
      }),
      false,
    );
    assert.equal(fixture.state.delays, 0);
  } finally {
    fixture.dom.restore();
  }
});

test("cleaning fails when the composer never comes back empty", async () => {
  const fixture = composerGuardFixture({ files: 1, cleanupTimeoutMs: 200 });
  try {
    assert.equal(
      await fixture.guard.cleanupComposer(fixture.composer, {
        text: "",
        attachments: {
          before: fixture.guard.attachmentRemovalControls(fixture.composer),
          files: [fixture.state.fileList[0]],
          expected: 1,
        },
      }),
      false,
    );
    // Bounded: it waited out the window on an injected clock rather than forever.
    assert.equal(fixture.state.delays, 4);
  } finally {
    fixture.dom.restore();
  }
});

test("a composer that throws while being cleared is a failed cleanup, not a raised error", async () => {
  const fixture = composerGuardFixture({ writeThrows: true });
  try {
    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, { text: "" }), false);
  } finally {
    fixture.dom.restore();
  }
});

test("a refusal before submission returns the reason it was given when the composer cleans", async () => {
  const fixture = composerGuardFixture({ text: "drafted" });
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    assert.deepEqual(
      await fixture.guard.rejectBeforeSubmission(fixture.composer, "the deadline expired", { text: "drafted" }),
      { submitted: false, error: "the deadline expired" },
    );
    assert.equal(fixture.state.blocked, undefined, "a clean composer was blocked anyway");
  } finally {
    fixture.dom.restore();
  }
});

test("a refusal whose cleanup cannot be verified blocks the composer in the provider's name", async () => {
  const fixture = composerGuardFixture({ files: 1, cleanupTimeoutMs: 100 });
  try {
    const outcome = await fixture.guard.rejectBeforeSubmission(
      fixture.composer,
      "the deadline expired",
      {
        text: "",
        attachments: {
          before: fixture.guard.attachmentRemovalControls(fixture.composer),
          files: [fixture.state.fileList[0]],
          expected: 1,
        },
      },
    );
    const reason =
      `${PROVIDER_LABEL} composer cleanup could not be verified. Reload the provider tab before continuing`;
    assert.equal(fixture.state.blocked, reason);
    assert.deepEqual(outcome, { submitted: false, error: `the deadline expired. ${reason}` });
  } finally {
    fixture.dom.restore();
  }
});

// BR-G6-02. The refusal that fires because a person's draft is in the composer used to be the
// thing that deleted it: the guard reported the conflict, and the cleanup behind the refusal
// cleared the text and clicked every attachment-removal control it could find. A request that
// has inserted nothing owns nothing.
test("a refusal before this request inserted anything leaves the draft and its attachments alone", async () => {
  const fixture = composerGuardFixture({ text: "a draft the person is still writing", files: 1 });
  const clicked = [];
  try {
    for (const id of ["remove", "detached"]) {
      const button = fixture.dom.query(`#${id}`);
      button.addEventListener("click", () => clicked.push(id));
    }
    const conflict =
      `${PROVIDER_LABEL} composer already contains text. Send or clear it before using Bachata`;
    assert.deepEqual(
      await fixture.guard.rejectBeforeSubmission(fixture.composer, conflict, {}),
      { submitted: false, error: conflict },
    );
    assert.equal(fixture.state.text, "a draft the person is still writing");
    assert.deepEqual(clicked, [], "a refusal that inserted nothing removed the person's attachments");
    assert.equal(fixture.state.blocked, undefined, "a document nothing was written to was blocked");
    assert.equal(fixture.state.delays, 0);
  } finally {
    fixture.dom.restore();
  }
});

test("cleaning a composer this request never wrote to changes nothing at all", async () => {
  const fixture = composerGuardFixture({ text: "a draft the person is still writing", files: 1 });
  try {
    assert.equal(
      await fixture.guard.cleanupComposer(fixture.composer, {}),
      true,
      "a cleanup that owns nothing reported failure over a composer it must not touch",
    );
    assert.equal(fixture.state.text, "a draft the person is still writing");
    assert.equal(fixture.state.delays, 0, "it waited for a composer it was never going to clear");
  } finally {
    fixture.dom.restore();
  }
});

// BR-G6-02, reopened. Boolean ownership answered "did this request write something", when the
// only safe question is "is what is in the composer still the exact thing this request wrote".
// Everything below is a person adding or changing something *after* staging started and *before*
// the refusal lands — the window the flags could not see.

test("a prompt the person rewrote after it was inserted is preserved, not withdrawn", async () => {
  const fixture = composerGuardFixture({ text: "the inserted prompt" });
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    // The request inserted its prompt; the person replaced it while the request was still
    // waiting for an enabled Send control; the submission then failed.
    const ownership = {};
    fixture.guard.recordInsertedText(ownership, "the inserted prompt");
    fixture.state.text = "no, ask it this instead";
    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.equal(fixture.state.text, "no, ask it this instead");
  } finally {
    fixture.dom.restore();
  }
});

test("a refusal over a rewritten prompt keeps the person's words and blocks reuse", async () => {
  const fixture = composerGuardFixture({ text: "the inserted prompt", cleanupTimeoutMs: 100 });
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    fixture.guard.recordInsertedText(ownership, "the inserted prompt");
    // Appending counts too: the composer no longer holds this request's insertion.
    fixture.state.text = "the inserted prompt and one more thing";
    const reason =
      `${PROVIDER_LABEL} composer cleanup could not be verified. Reload the provider tab before continuing`;
    assert.deepEqual(
      await fixture.guard.rejectBeforeSubmission(fixture.composer, "submission failed", ownership),
      { submitted: false, error: `submission failed. ${reason}` },
    );
    assert.equal(fixture.state.text, "the inserted prompt and one more thing");
    assert.equal(fixture.state.blocked, reason);
  } finally {
    fixture.dom.restore();
  }
});

test("an attachment the person adds while this request stages is kept while ours is withdrawn", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    // One attachment of this request's, staged.
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "ours.png" };
    fixture.state.fileList = [ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);
    // The person drops one of their own in while the upload settles: a second removal control
    // appears, and nothing on the page says which of the two is theirs.
    const form = fixture.dom.query("#form");
    for (const id of ["ours-control", "their-control"]) {
      const button = fixture.dom.document.createElement("button");
      button.id = id;
      button.setAttribute("aria-label", "Remove file");
      button.addEventListener("click", () => clicked.push(id));
      form.appendChild(button);
    }
    const theirs = { name: "theirs.png" };
    fixture.state.fileList = [ours, theirs];

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.deepEqual(clicked, [], "an unbindable control was clicked anyway");
    assert.deepEqual(
      fixture.state.fileList,
      [theirs],
      "the person's file was not the only thing left on the input",
    );
    // The provider's chips did not follow the rebuilt input, so nothing here proves the
    // withdrawal landed; it waited out its window and reported failure.
    assert.equal(fixture.state.delays, 2);
  } finally {
    restore();
    fixture.dom.restore();
  }
});

// BR-G6-02 residue. A control that names this request's filename is the case the previous
// binding accepted, and it is the case the owner reopened: a filename is metadata, not identity.
// Nothing is clicked, the input is rebuilt around the exact `File` objects this request placed,
// and a provider whose chip does not follow leaves the cleanup unproved.
test("a control that only names this request's file is never clicked", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#detached").remove();
    // `#remove` was already on the composer before this request staged anything, so it is the
    // person's and the snapshot has to keep it out of reach.
    const theirControl = fixture.dom.query("#remove");
    theirControl.setAttribute("aria-label", "Remove file theirs.png");
    theirControl.addEventListener("click", () => clicked.push("theirs"));
    const theirFile = { name: "theirs.png" };
    fixture.state.fileList = [theirFile];

    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "ours.png" };
    const ourControl = fixture.dom.document.createElement("button");
    ourControl.id = "ours-control";
    ourControl.setAttribute("aria-label", "Remove file ours.png");
    ourControl.addEventListener("click", () => {
      clicked.push("ours");
      ourControl.remove();
    });
    fixture.dom.query("#form").appendChild(ourControl);
    fixture.state.fileList = [theirFile, ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.deepEqual(clicked, [], "a filename was accepted as proof of control ownership");
    assert.deepEqual(
      fixture.state.fileList,
      [theirFile],
      "the input was not rebuilt from the exact File objects this request placed",
    );
  } finally {
    restore();
    fixture.dom.restore();
  }
});

// BR-G6-02 residue. The other half of the same rule: when the provider's own chips are driven by
// the input, rebuilding it is observable, and the cleanup is proved without clicking anything.
test("cleanup is proved when the provider's chips follow the rebuilt input", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const theirFile = { name: "theirs.png" };
    fixture.state.fileList = [theirFile];

    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "ours.png" };
    const ourControl = fixture.dom.document.createElement("button");
    ourControl.id = "ours-control";
    ourControl.setAttribute("aria-label", "Remove file upload");
    ourControl.addEventListener("click", () => clicked.push("ours"));
    fixture.dom.query("#form").appendChild(ourControl);
    fixture.state.fileList = [theirFile, ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);
    // This provider renders its chips from the input, so the rewrite the guard performs is what
    // takes the control away — no click, and the disappearance is the proof.
    fixture.input.addEventListener("change", () => {
      if (!fixture.state.fileList.includes(ours)) ourControl.remove();
    });

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), true);
    assert.deepEqual(clicked, []);
    assert.deepEqual(fixture.state.fileList, [theirFile]);
    assert.equal(fixture.state.delays, 0, "a cleanup the page had already proved still waited");
  } finally {
    restore();
    fixture.dom.restore();
  }
});

test("a request with nothing to attach never claims attachment ownership", async () => {
  const fixture = composerGuardFixture({ text: "the inserted prompt" });
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 0);
    fixture.guard.commitAttachmentOwnership(ownership);
    assert.deepEqual(ownership, {}, "a request with no attachments claimed some anyway");
    // Nothing was claimed, so nothing can be recorded against it either.
    fixture.guard.recordStagedFiles(ownership, [{ name: "stray.png" }]);
    assert.deepEqual(ownership, {});
    fixture.guard.recordInsertedText(ownership, "the inserted prompt");
    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), true);
    assert.equal(fixture.state.text, "");
  } finally {
    fixture.dom.restore();
  }
});

test("cleanup withdraws only the half of the composer this request supplied", async () => {
  const fixture = composerGuardFixture({ text: "a draft the person is still writing" });
  const clicked = [];
  try {
    fixture.dom.query("#detached").remove();
    // A control that was already on the composer when staging began is the person's for the
    // whole life of the request, whatever it goes on to say about itself.
    const theirControl = fixture.dom.query("#remove");
    theirControl.addEventListener("click", () => clicked.push("theirs"));
    assert.equal(
      await fixture.guard.cleanupComposer(fixture.composer, {
        attachments: {
          before: [theirControl],
          files: [{ name: "one.png" }, { name: "two.png" }],
          expected: 2,
        },
      }),
      true,
    );
    assert.deepEqual(clicked, [], "a control that predated this request's staging was clicked");
    assert.equal(fixture.state.text, "a draft the person is still writing");
  } finally {
    fixture.dom.restore();
  }
});

// BR-G6-02, reopened. Appearance after staging began, and a count no larger than the number of
// attachments this request set out to place, are not evidence of ownership. Each case below is a
// composer where those two facts point at an attachment that is the person's.
test("a control the person's attachment brought while this request's was still rendering is never clicked", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "ours.png" };
    fixture.state.fileList = [ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);
    // The person's own attachment renders its control first; this request's chip is still
    // coming. Exactly one control is new and exactly one attachment was expected, so counting
    // calls the one thing on the composer that is not this request's, this request's.
    const theirControl = fixture.dom.document.createElement("button");
    theirControl.id = "their-control";
    theirControl.setAttribute("aria-label", "Remove file theirs.png");
    theirControl.addEventListener("click", () => clicked.push("theirs"));
    fixture.dom.query("#form").appendChild(theirControl);
    fixture.state.fileList = [ours, { name: "theirs.png" }];

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.deepEqual(clicked, [], "a control that named the person's own attachment was clicked");
    assert.deepEqual(
      fixture.state.fileList.map((file) => file.name),
      ["theirs.png"],
      "the person's attachment was not the only thing left on the input",
    );
    assert.equal(fixture.state.delays, 2);
  } finally {
    restore();
    fixture.dom.restore();
  }
});

test("an ambiguous attachment cleanup clicks nothing, keeps everything, and blocks reuse", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "ours.png" };
    fixture.state.fileList = [ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);
    const theirControl = fixture.dom.document.createElement("button");
    theirControl.id = "their-control";
    theirControl.setAttribute("aria-label", "Remove file theirs.png");
    theirControl.addEventListener("click", () => clicked.push("theirs"));
    fixture.dom.query("#form").appendChild(theirControl);
    fixture.state.fileList = [ours, { name: "theirs.png" }];

    const reason =
      `${PROVIDER_LABEL} composer cleanup could not be verified. Reload the provider tab before continuing`;
    assert.deepEqual(
      await fixture.guard.rejectBeforeSubmission(fixture.composer, "submission failed", ownership),
      { submitted: false, error: `submission failed. ${reason}` },
    );
    assert.equal(fixture.state.blocked, reason);
    assert.deepEqual(clicked, []);
    assert.deepEqual(
      fixture.state.fileList.map((file) => file.name),
      ["theirs.png"],
    );
  } finally {
    restore();
    fixture.dom.restore();
  }
});

test("a removal control the provider replaced with a new node leaves cleanup unverified", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#detached").remove();
    const theirOld = fixture.dom.query("#remove");
    theirOld.setAttribute("aria-label", "Remove file theirs.png");
    theirOld.addEventListener("click", () => clicked.push("theirs-old"));
    const theirFile = { name: "theirs.png" };
    fixture.state.fileList = [theirFile];

    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 2);
    fixture.guard.commitAttachmentOwnership(ownership);
    const first = { name: "first.png" };
    const second = { name: "second.png" };
    fixture.state.fileList = [theirFile, first, second];
    fixture.guard.recordStagedFiles(ownership, [first, second]);

    // The provider re-renders the person's chip as a different node while this request's second
    // chip has not arrived: two controls are new, two attachments were expected, and one of the
    // two new nodes is the person's.
    theirOld.remove();
    const form = fixture.dom.query("#form");
    const theirNew = fixture.dom.document.createElement("button");
    theirNew.id = "their-new";
    theirNew.setAttribute("aria-label", "Remove file theirs.png");
    theirNew.addEventListener("click", () => clicked.push("theirs-new"));
    form.appendChild(theirNew);
    const firstControl = fixture.dom.document.createElement("button");
    firstControl.id = "first-control";
    firstControl.setAttribute("aria-label", "Remove file first.png");
    firstControl.addEventListener("click", () => clicked.push("first"));
    form.appendChild(firstControl);

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.deepEqual(clicked, [], "a replaced node was treated as this request's own control");
    assert.deepEqual(
      fixture.state.fileList,
      [theirFile],
      "the person's file was not the only thing left on the input",
    );
  } finally {
    restore();
    fixture.dom.restore();
  }
});

test("one aggregate removal control is never clicked while the person's file may be behind it", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "ours.png" };
    fixture.state.fileList = [ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);
    // One control, and it stands for everything staged — including what the person added.
    const aggregate = fixture.dom.document.createElement("button");
    aggregate.id = "aggregate";
    aggregate.setAttribute("aria-label", "Remove all attachments");
    aggregate.addEventListener("click", () => clicked.push("aggregate"));
    fixture.dom.query("#form").appendChild(aggregate);
    fixture.state.fileList = [ours, { name: "theirs.png" }];

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.deepEqual(clicked, [], "an aggregate control removed the person's attachment too");
    assert.deepEqual(
      fixture.state.fileList.map((file) => file.name),
      ["theirs.png"],
    );
  } finally {
    restore();
    fixture.dom.restore();
  }
});

test("an attachment the person adds under this request's own filename is preserved", async () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  const clicked = [];
  try {
    fixture.dom.query("#remove").remove();
    fixture.dom.query("#detached").remove();
    const ownership = {};
    fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
    fixture.guard.commitAttachmentOwnership(ownership);
    const ours = { name: "shared.png" };
    fixture.state.fileList = [ours];
    fixture.guard.recordStagedFiles(ownership, [ours]);
    // The person attaches a file of their own that happens to carry the same name, and its chip
    // renders first. The filename no longer picks one attachment out of the composer.
    const theirControl = fixture.dom.document.createElement("button");
    theirControl.id = "their-control";
    theirControl.setAttribute("aria-label", "Remove file shared.png");
    theirControl.addEventListener("click", () => clicked.push("theirs"));
    fixture.dom.query("#form").appendChild(theirControl);
    const theirs = { name: "shared.png" };
    fixture.state.fileList = [ours, theirs];

    assert.equal(await fixture.guard.cleanupComposer(fixture.composer, ownership), false);
    assert.deepEqual(clicked, [], "a shared filename was accepted as proof of ownership");
    assert.deepEqual(
      fixture.state.fileList,
      [theirs],
      "the person's identically named file was withdrawn with this request's",
    );
  } finally {
    restore();
    fixture.dom.restore();
  }
});


// BR-G6-02 residue. The four instants at which a person can attach a file of their own while a
// Bachata submission is in flight. Each case drives the production staging sequence — the awaited
// attachment-input discovery, the synchronous last look, the native `files` write, the settle
// loop and the check before Send — and asserts the same two things every time: the person's file
// survives, and nothing this request staged is ever submitted beside it.
const stagingRaceFixture = () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  fixture.dom.query("#remove").remove();
  fixture.dom.query("#detached").remove();
  fixture.state.fileList = [];
  const ownership = {};
  fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
  const ours = { name: "ours.png" };
  const theirs = { name: "theirs.png" };
  const attachHuman = () => {
    fixture.state.fileList = [...fixture.state.fileList, theirs];
    const control = fixture.dom.document.createElement("button");
    control.id = "their-control";
    control.setAttribute("aria-label", "Remove file theirs.png");
    fixture.dom.query("#form").appendChild(control);
  };
  // The provider entries' own order, with the production pieces they call.
  const stage = async ({ discover, settleTurns = 1, duringSettle } = {}) => {
    const input = await (discover ?? (async () => fixture.input))();
    writeStagedAttachments({
      input,
      files: [ours],
      refuseBeforeWrite: (candidate) =>
        fixture.guard.stagingWriteRefusal(fixture.composer, candidate, ownership),
      onBeforeWrite: () => fixture.guard.commitAttachmentOwnership(ownership),
      onStaged: (files) => fixture.guard.recordStagedFiles(ownership, files),
    });
    for (let turn = 0; turn < settleTurns; turn += 1) {
      await Promise.resolve();
      duringSettle?.(turn);
      const refusal = fixture.guard.stagedAttachmentRefusal(ownership);
      if (refusal) throw new Error(refusal);
    }
  };
  return { fixture, restore, ownership, ours, theirs, attachHuman, stage };
};

const FOREIGN_ATTACHMENT_REFUSAL =
  `${PROVIDER_LABEL} composer gained an attachment Bachata did not stage. Send or clear it before using Bachata`;


// BR-G6-02 residue, reopened. Ownership is a claim about a write, so it may not begin before a
// write is attempted. Everything below fails between the baseline reading and the native setter:
// the input is never found, the request is cancelled or expires while it is being found, the
// payload does not weigh what it claims, the browser offers no native setter at all, or the last
// synchronous look refuses. None of them placed anything, so none of them may clean or block a
// composer this request never wrote to. The two cases that did reach the setter are the opposite:
// a setter that throws may already have replaced the whole list, so the claim stands and the
// document is blocked rather than guessed at.
const preWriteFixture = () => {
  const fixture = composerGuardFixture({ cleanupTimeoutMs: 100 });
  const restore = withFileInputSetter(fixture.state);
  fixture.dom.query("#remove").remove();
  fixture.dom.query("#detached").remove();
  fixture.state.fileList = [];
  const ownership = {};
  // The provider entry's own order: the reading first, and no claim until the write.
  fixture.guard.captureAttachmentBaseline(fixture.composer, ownership, 1);
  const ours = { name: "ours.png" };
  const theirs = { name: "theirs.png" };
  const attachHuman = () => {
    fixture.state.fileList = [...fixture.state.fileList, theirs];
    const control = fixture.dom.document.createElement("button");
    control.id = "their-control";
    control.setAttribute("aria-label", "Remove file theirs.png");
    fixture.dom.query("#form").appendChild(control);
  };
  const stage = async ({ discover, buildFiles } = {}) => {
    const input = await (discover ?? (async () => fixture.input))();
    if (!input) throw new Error(`${PROVIDER_LABEL} image attachment input is unavailable`);
    writeStagedAttachments({
      input,
      files: (buildFiles ?? (() => [ours]))(),
      refuseBeforeWrite: (candidate) =>
        fixture.guard.stagingWriteRefusal(fixture.composer, candidate, ownership),
      onBeforeWrite: () => fixture.guard.commitAttachmentOwnership(ownership),
      onStaged: (staged) => fixture.guard.recordStagedFiles(ownership, staged),
    });
  };
  const assertUntouched = async () => {
    assert.equal(
      ownership.attachments,
      undefined,
      "a request that never reached the setter claimed an attachment",
    );
    assert.equal(
      await fixture.guard.cleanupComposer(fixture.composer, ownership),
      true,
      "a composer nothing was written to reported an unverified cleanup",
    );
    assert.deepEqual(
      await fixture.guard.rejectBeforeSubmission(fixture.composer, "submission failed", ownership),
      { submitted: false, error: "submission failed" },
    );
    assert.equal(fixture.state.blocked, undefined, "an untouched composer was blocked");
    assert.equal(fixture.state.text, "", "an untouched composer had its text rewritten");
    assert.equal(fixture.state.delays, 0, "an untouched composer was waited on");
  };
  const assertBlocked = async () => {
    assert.equal(ownership.attachments?.expected, 1, "an attempted write claimed nothing");
    const reason =
      `${PROVIDER_LABEL} composer cleanup could not be verified. Reload the provider tab before continuing`;
    assert.deepEqual(
      await fixture.guard.rejectBeforeSubmission(fixture.composer, "submission failed", ownership),
      { submitted: false, error: `submission failed. ${reason}` },
    );
    assert.equal(fixture.state.blocked, reason, "an attempted write left the composer reusable");
  };
  return { fixture, restore, ownership, ours, theirs, attachHuman, stage, assertUntouched, assertBlocked };
};

const withoutFileInputSetter = () => {
  const prototype = globalThis.HTMLInputElement.prototype;
  const previous = Object.getOwnPropertyDescriptor(prototype, "files");
  // `defineProperty` leaves an attribute it does not mention unchanged, so the setter installed
  // above this one has to be named and removed rather than merely omitted.
  Object.defineProperty(prototype, "files", { configurable: true, get: () => [], set: undefined });
  return () => {
    if (previous) Object.defineProperty(prototype, "files", previous);
    else delete prototype.files;
  };
};

const withThrowingFileInputSetter = (state, mutate) => {
  const prototype = globalThis.HTMLInputElement.prototype;
  const previous = Object.getOwnPropertyDescriptor(prototype, "files");
  Object.defineProperty(prototype, "files", {
    configurable: true,
    set(value) {
      if (mutate) state.fileList = Array.from(value);
      throw new Error("the provider input rejected the write");
    },
    get() {
      return state.fileList.slice();
    },
  });
  return () => {
    if (previous) Object.defineProperty(prototype, "files", previous);
    else delete prototype.files;
  };
};

const PRE_WRITE_DISCOVERY_FAILURES = [
  ["the attachment input is never found", undefined, `${PROVIDER_LABEL} image attachment input is unavailable`],
  [
    "the request is interrupted while the attachment input is being found",
    `${PROVIDER_LABEL} request was interrupted before attachments were staged`,
    `${PROVIDER_LABEL} request was interrupted before attachments were staged`,
  ],
  [
    "the request deadline expires while the attachment input is being found",
    `${PROVIDER_LABEL} request deadline expired before attachments were staged`,
    `${PROVIDER_LABEL} request deadline expired before attachments were staged`,
  ],
];

for (const [when, thrown, expected] of PRE_WRITE_DISCOVERY_FAILURES) {
  test(`a submission that fails because ${when} leaves the composer untouched`, async () => {
    const run = preWriteFixture();
    try {
      await assert.rejects(
        run.stage({
          discover: async () => {
            await Promise.resolve();
            if (thrown !== undefined) throw new Error(thrown);
            return undefined;
          },
        }),
        new Error(expected),
      );
      await run.assertUntouched();
    } finally {
      run.restore();
      run.fixture.dom.restore();
    }
  });
}

test("an attachment payload that does not weigh what it claims leaves the composer untouched", async () => {
  const run = preWriteFixture();
  try {
    await assert.rejects(
      run.stage({
        buildFiles: () => {
          throw new Error("Attachment ours.png size does not match its payload");
        },
      }),
      new Error("Attachment ours.png size does not match its payload"),
    );
    await run.assertUntouched();
  } finally {
    run.restore();
    run.fixture.dom.restore();
  }
});

test("a browser offering no native file input setter leaves the composer untouched", async () => {
  const run = preWriteFixture();
  const restoreSetter = withoutFileInputSetter();
  try {
    await assert.rejects(run.stage(), new Error("Browser file input setter is unavailable"));
    await run.assertUntouched();
  } finally {
    restoreSetter();
    run.restore();
    run.fixture.dom.restore();
  }
});

test("the last synchronous refusal before the write leaves the composer untouched", async () => {
  const run = preWriteFixture();
  try {
    await assert.rejects(
      run.stage({
        discover: async () => {
          const input = run.fixture.input;
          run.attachHuman();
          return input;
        },
      }),
      new Error(FOREIGN_ATTACHMENT_REFUSAL),
    );
    assert.deepEqual(run.fixture.state.fileList, [run.theirs], "the write ran anyway");
    await run.assertUntouched();
  } finally {
    run.restore();
    run.fixture.dom.restore();
  }
});

test("a native setter that throws before it mutates blocks the composer safely", async () => {
  const run = preWriteFixture();
  const restoreSetter = withThrowingFileInputSetter(run.fixture.state, false);
  try {
    await assert.rejects(run.stage(), new Error("the provider input rejected the write"));
    assert.deepEqual(run.fixture.state.fileList, [], "the input was mutated after all");
    await run.assertBlocked();
  } finally {
    restoreSetter();
    run.restore();
    run.fixture.dom.restore();
  }
});

test("a native setter that throws after it has already replaced the list blocks the composer safely", async () => {
  const run = preWriteFixture();
  const restoreSetter = withThrowingFileInputSetter(run.fixture.state, true);
  try {
    await assert.rejects(run.stage(), new Error("the provider input rejected the write"));
    assert.deepEqual(
      run.fixture.state.fileList,
      [run.ours],
      "the partial mutation this case exists for did not happen",
    );
    await run.assertBlocked();
    // Nothing is taken back: the request cannot say how much of its write landed, so the input
    // is left exactly as the throwing setter left it and the document is blocked instead.
    assert.deepEqual(run.fixture.state.fileList, [run.ours]);
  } finally {
    restoreSetter();
    run.restore();
    run.fixture.dom.restore();
  }
});

test("a file the person attaches while the attachment input is still being found is never overwritten", async () => {
  const race = stagingRaceFixture();
  try {
    await assert.rejects(
      race.stage({
        discover: async () => {
          await Promise.resolve();
          race.attachHuman();
          return race.fixture.input;
        },
      }),
      new Error(FOREIGN_ATTACHMENT_REFUSAL),
    );
    assert.deepEqual(race.fixture.state.fileList, [race.theirs], "the write ran anyway");
    assert.equal(race.ownership.attachments, undefined, "a refused write claimed ownership anyway");
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a file the person attaches in the instant before the write is refused, not replaced", async () => {
  const race = stagingRaceFixture();
  try {
    await assert.rejects(
      race.stage({
        discover: async () => {
          const input = race.fixture.input;
          // Discovery has already answered; the person attaches before the setter runs.
          race.attachHuman();
          return input;
        },
      }),
      new Error(FOREIGN_ATTACHMENT_REFUSAL),
    );
    assert.deepEqual(race.fixture.state.fileList, [race.theirs]);
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a file the person attaches after the write and before settlement aborts the submission", async () => {
  const race = stagingRaceFixture();
  try {
    await assert.rejects(
      race.stage({
        settleTurns: 3,
        duringSettle: (turn) => {
          if (turn === 1) race.attachHuman();
        },
      }),
      new Error(FOREIGN_ATTACHMENT_REFUSAL),
    );
    // Aborting is not enough on its own: the cleanup that follows must take back exactly what
    // this request placed and leave the person's file where it is.
    assert.equal(
      await race.fixture.guard.cleanupComposer(race.fixture.composer, race.ownership),
      false,
      "an unprovable cleanup reported success",
    );
    assert.deepEqual(race.fixture.state.fileList, [race.theirs]);
    assert.equal(race.fixture.state.fileList[0], race.theirs);
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a file the person attaches after settlement and before Send stops the Send", async () => {
  const race = stagingRaceFixture();
  try {
    await race.stage();
    assert.deepEqual(race.fixture.state.fileList, [race.ours], "staging did not complete cleanly");
    assert.equal(
      race.fixture.guard.stagedAttachmentRefusal(race.ownership),
      undefined,
      "a settled staging was refused",
    );
    // Everything that follows a settled staging re-asks the same question, and the last time it
    // is asked is immediately before the Send.
    race.attachHuman();
    assert.equal(
      race.fixture.guard.stagedAttachmentRefusal(race.ownership),
      FOREIGN_ATTACHMENT_REFUSAL,
    );
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("an attachment this request placed and then lost is refused rather than sent unproved", async () => {
  const race = stagingRaceFixture();
  try {
    await race.stage();
    race.fixture.state.fileList = [];
    assert.equal(
      race.fixture.guard.stagedAttachmentRefusal(race.ownership),
      `${PROVIDER_LABEL} composer no longer holds the attachments Bachata staged`,
    );
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("the composer's own foreign-file reading names the person's file and not this request's", async () => {
  const race = stagingRaceFixture();
  try {
    await race.stage();
    assert.deepEqual(race.fixture.guard.foreignStagedFiles(race.ownership), []);
    race.attachHuman();
    assert.deepEqual(race.fixture.guard.foreignStagedFiles(race.ownership), [race.theirs]);
    // Identity, not name: a file of the person's carrying this request's filename is still theirs.
    const twin = { name: "ours.png" };
    race.fixture.state.fileList = [race.ours, twin];
    assert.deepEqual(race.fixture.guard.foreignStagedFiles(race.ownership), [twin]);
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a write that was never attempted claims nothing, so nothing is blocked over an empty composer", async () => {
  const race = stagingRaceFixture();
  try {
    assert.equal(race.ownership.baseline.expected, 1);
    assert.equal(
      race.ownership.attachments,
      undefined,
      "reading the composer took a claim against it",
    );
    assert.equal(
      await race.fixture.guard.cleanupComposer(race.fixture.composer, race.ownership),
      true,
      "a request that wrote nothing had its cleanup reported unverified",
    );
    assert.equal(race.fixture.state.delays, 0);
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a removal control that appeared before the write is refused even with an empty input", () => {
  const race = stagingRaceFixture();
  try {
    // Nothing is on the input, but the composer already shows a chip: something is staged that
    // this request cannot see, and the write would replace it.
    const control = race.fixture.dom.document.createElement("button");
    control.id = "their-chip";
    control.setAttribute("aria-label", "Remove file theirs.png");
    race.fixture.dom.query("#form").appendChild(control);
    assert.equal(
      race.fixture.guard.stagingWriteRefusal(race.fixture.composer, race.fixture.input, race.ownership),
      FOREIGN_ATTACHMENT_REFUSAL,
    );
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a request that staged nothing is asked nothing about staged attachments", () => {
  const race = stagingRaceFixture();
  try {
    assert.equal(race.fixture.guard.stagedAttachmentRefusal({}), undefined);
    assert.equal(race.fixture.guard.foreignAttachmentRefusal({}), undefined);
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});

test("a browser with no file input setter refuses the staging instead of pretending it landed", () => {
  const fixture = composerGuardFixture();
  try {
    // No `withFileInputSetter` here: the platform property is absent, exactly as it would be in
    // a runtime that does not expose it.
    assert.throws(
      () => writeStagedAttachments({ input: fixture.input, files: [{ name: "ours.png" }] }),
      new Error("Browser file input setter is unavailable"),
    );
  } finally {
    fixture.dom.restore();
  }
});

test("the write refuses while the composer, the input or the page have moved under it", async () => {
  const race = stagingRaceFixture();
  try {
    const detached = race.fixture.dom.document.createElement("input");
    assert.equal(
      race.fixture.guard.stagingWriteRefusal(race.fixture.composer, detached, race.ownership),
      `${PROVIDER_LABEL} attachment input changed before Bachata staged its files`,
    );
    race.fixture.state.text = "a draft the person is still writing";
    assert.equal(
      race.fixture.guard.stagingWriteRefusal(race.fixture.composer, race.fixture.input, race.ownership),
      `${PROVIDER_LABEL} composer already contains text. Send or clear it before using Bachata`,
    );
    race.fixture.state.text = "";
    race.fixture.composer.remove();
    assert.equal(
      race.fixture.guard.stagingWriteRefusal(race.fixture.composer, race.fixture.input, race.ownership),
      `${PROVIDER_LABEL} composer changed before Bachata staged its files`,
    );
  } finally {
    race.restore();
    race.fixture.dom.restore();
  }
});


// BB-4. The one function every provider message goes through, now shared. `chrome` is the only
// thing it touches, so it is stubbed rather than driven through a whole content script.
test("a background acknowledgement is returned and a refusal is raised in the background's words", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const sent = [];
  try {
    let reply;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      writable: true,
      value: { runtime: { sendMessage: async (message) => { sent.push(message); return reply; } } },
    });
    reply = { success: true, documentToken: "token" };
    assert.deepEqual(await sendBackground({ type: "content.register" }), reply);
    assert.deepEqual(sent, [{ type: "content.register" }]);

    reply = { success: false, error: "The selected browser document changed" };
    await assert.rejects(
      () => sendBackground({ type: "content.stream" }),
      /The selected browser document changed/u,
    );
    // No answer at all, and an answer with no reason, both refuse rather than being taken as
    // acknowledgements.
    reply = undefined;
    await assert.rejects(
      () => sendBackground({ type: "content.stream" }),
      /Browser background rejected the message/u,
    );
    reply = { success: false };
    await assert.rejects(
      () => sendBackground({ type: "content.stream" }),
      /Browser background rejected the message/u,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else delete globalThis.chrome;
  }
});


test("a composer guard with no clock injected uses the real one and still terminates", async () => {
  // The injected clock is a test convenience; production supplies none, and that path has to
  // work. A composer that is already clean settles on the first read, so this stays fast.
  const dom = createGenericDom(`<form><div id="composer"></div></form>`);
  try {
    let text = "drafted";
    const guard = createComposerGuard({
      readComposer: () => text,
      writeComposer: (_element, value) => { text = value; },
      attachmentInput: () => undefined,
      delay: async () => undefined,
      blockComposer: () => undefined,
    });
    assert.equal(await guard.cleanupComposer(dom.query("#composer"), { text: "drafted" }), true);
    assert.equal(text, "");
  } finally {
    dom.restore();
  }
});

// BB-4. The document-level behaviour both provider entries share, driven directly.
//
// These arrived here as one implementation from two identical copies, and each of them decides
// something a turn depends on: when a page counts as having been busy, what a turn forgets when
// it ends, which file input a provider stages on, which response node this turn produced, when a
// running request may follow the page to another conversation, what a stream update is, and
// whether a stop may be reported as a stop. Every one is reachable without a page, so every one
// is tested without a page.

const fakeMutationObservers = [];

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    this.disconnected = false;
    fakeMutationObservers.push(this);
  }

  observe(target, options) {
    this.targets.push({ target, options });
  }

  disconnect() {
    this.disconnected = true;
  }

  fire() {
    this.callback([]);
  }
}

const withGlobals = async (values, run) => {
  const saved = Object.keys(values).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  Object.entries(values).forEach(([name, value]) => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  });
  try {
    return await run();
  } finally {
    saved.forEach(([name, descriptor]) => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
};

test("the lifecycle observer records that a page was ever busy, before the first mutation", async () => {
  fakeMutationObservers.length = 0;
  const root = { nodeType: 1 };
  let hasStop = true;
  await withGlobals({ MutationObserver: FakeMutationObserver }, () => {
    const lifecycle = startLifecycleObserver({ stopButton: () => (hasStop ? {} : undefined), root });
    // The first read happens at construction: a turn that finished before any mutation still ran.
    assert.equal(lifecycle.busyObserved, true);
    assert.equal(fakeMutationObservers.length, 1);
    assert.deepEqual(fakeMutationObservers[0].targets[0].options, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "data-state"],
    });
    assert.equal(fakeMutationObservers[0].targets[0].target, root);
    lifecycle.observer.disconnect();
    assert.equal(fakeMutationObservers[0].disconnected, true);
  });
});

test("a page that becomes busy later is recorded, and one that never does is not", async () => {
  fakeMutationObservers.length = 0;
  let hasStop = false;
  await withGlobals({ MutationObserver: FakeMutationObserver }, () => {
    const lifecycle = startLifecycleObserver({ stopButton: () => (hasStop ? {} : undefined), root: {} });
    assert.equal(lifecycle.busyObserved, false);
    fakeMutationObservers[0].fire();
    assert.equal(lifecycle.busyObserved, false);
    hasStop = true;
    fakeMutationObservers[0].fire();
    assert.equal(lifecycle.busyObserved, true);
    // Once observed, busy stays observed: the turn happened whatever the page shows now.
    hasStop = false;
    fakeMutationObservers[0].fire();
    assert.equal(lifecycle.busyObserved, true);
  });
});

test("a page whose stop control cannot be read leaves the busy record alone", async () => {
  fakeMutationObservers.length = 0;
  await withGlobals({ MutationObserver: FakeMutationObserver }, () => {
    const lifecycle = startLifecycleObserver({
      stopButton: () => {
        throw new Error("ambiguous provider controls");
      },
      root: {},
    });
    assert.equal(lifecycle.busyObserved, false);
    fakeMutationObservers[0].fire();
    assert.equal(lifecycle.busyObserved, false);
  });
});

test("the lifecycle observer defaults to the document element when no root is named", async () => {
  fakeMutationObservers.length = 0;
  const documentElement = { nodeType: 1 };
  await withGlobals({ MutationObserver: FakeMutationObserver, document: { documentElement } }, () => {
    startLifecycleObserver({ stopButton: () => undefined });
    assert.equal(fakeMutationObservers[0].targets[0].target, documentElement);
  });
});

test("forgetting a request clears its cancellation, releases the document and re-registers", () => {
  const deleted = [];
  let active = "request-1";
  let registered = 0;
  const forget = createRequestTeardown({
    cancelledRequests: { delete: (requestId) => deleted.push(requestId) },
    activeRequestId: () => active,
    clearActiveRequest: () => {
      active = undefined;
    },
    ensureRegisteredUrl: () => {
      registered += 1;
    },
  });
  forget("request-1");
  assert.deepEqual(deleted, ["request-1"]);
  assert.equal(active, undefined);
  assert.equal(registered, 1);
});

// BB-A4-N01. Interrupting a turn records the cancellation before it clicks Stop, and that record
// is exactly what makes the capture loop return and tear the request down. The teardown used to
// clear the active request and the cancellation record while the interrupt was still confirming
// the native Stop, so the interrupt lost the state its own guard reads and abandoned itself.
test("a native Stop still owns its request while the cancelled capture tears down", async () => {
  const lease = createInterruptLease();
  const cancelled = new Set();
  let active = { requestId: "request-1" };
  let registered = 0;
  const forget = createRequestTeardown({
    cancelledRequests: { delete: (requestId) => cancelled.delete(requestId) },
    activeRequestId: () => active?.requestId,
    clearActiveRequest: () => {
      active = undefined;
    },
    ensureRegisteredUrl: () => {
      registered += 1;
    },
    lease,
  });
  let clock = 0;
  const clicks = [];
  const control = createInterruptControl({
    stopButton: () => ({ click: () => clicks.push("stop") }),
    isBusy: () => false,
    heal: async () => false,
    delay: async (milliseconds) => { clock += milliseconds; },
    waitForResolvedControl: globalThis.__pairProviderControls.waitForResolvedControl,
    now: () => clock,
    // The capture loop watches for the cancellation and ends the turn the moment it appears.
    rememberCancellation: (requestId) => {
      cancelled.add(requestId);
      forget(requestId);
    },
    forgetCancellation: (requestId) => { cancelled.delete(requestId); },
    stillBound: (requestId) => active?.requestId === requestId,
    lease,
    retireRequest: (requestId) => forget(requestId),
  });

  assert.equal(
    await control.interruptAndConfirm("request-1"),
    true,
    "the interrupt lost the request its own confirmation reads",
  );
  assert.deepEqual(clicks, ["stop"]);
  // The teardown is owed, not skipped: it runs once the interrupt lets go.
  assert.equal(active, undefined, "a confirmed stop left the turn holding the document");
  assert.equal(cancelled.has("request-1"), false);
  assert.equal(registered, 1);
});

test("a request retired while no interrupt holds it is torn down at once", async () => {
  const lease = createInterruptLease();
  let active = "request-1";
  const forget = createRequestTeardown({
    cancelledRequests: { delete: () => undefined },
    activeRequestId: () => active,
    clearActiveRequest: () => {
      active = undefined;
    },
    ensureRegisteredUrl: () => undefined,
    lease,
  });
  forget("request-1");
  assert.equal(active, undefined);
  // And a lease that nothing deferred against owes nothing back.
  lease.hold("request-2");
  assert.equal(lease.held("request-2"), true);
  assert.equal(lease.release("request-2"), false);
  assert.equal(lease.held("request-2"), false);
});

test("forgetting a request never releases a document a different turn now holds", () => {
  let active = "request-2";
  const forget = createRequestTeardown({
    cancelledRequests: { delete: () => undefined },
    activeRequestId: () => active,
    clearActiveRequest: () => {
      active = undefined;
    },
    ensureRegisteredUrl: () => undefined,
  });
  forget("request-1");
  assert.equal(active, "request-2", "an old request released the turn that replaced it");
});

const composerResolver = (overrides = {}) => {
  const state = { healed: 0, composerThrows: false, healResult: true, healedComposer: undefined };
  const resolver = createComposerResolver({
    composer: () => {
      if (state.composerThrows) throw new Error("ambiguous provider controls");
      return state.composer;
    },
    sendButton: () => state.sendButton,
    healDom: async () => {
      state.healed += 1;
      return state.healResult;
    },
    healedControls: () => (state.healedComposer ? { composer: state.healedComposer } : undefined),
    controlDisabled: (element) => Boolean(element?.disabled),
    delay: async () => undefined,
    cancelled: () => false,
    waitForResolvedControl: globalThis.__pairProviderControls.waitForResolvedControl,
    ...overrides,
  });
  return { state, resolver };
};

test("a composer the page offers is returned without healing", async () => {
  const { state, resolver } = composerResolver();
  state.composer = { id: "composer" };
  assert.equal(await resolver.resolveComposer(), state.composer);
  assert.equal(state.healed, 0);
});

test("an ambiguous composer heals once and answers with the healed binding", async () => {
  const { state, resolver } = composerResolver();
  state.composerThrows = true;
  state.healedComposer = { id: "healed" };
  assert.equal(await resolver.resolveComposer(), state.healedComposer);
  assert.equal(state.healed, 1);
});

test("a page that cannot be healed resolves no composer rather than guessing one", async () => {
  const { state, resolver } = composerResolver();
  state.composerThrows = true;
  state.healResult = false;
  assert.equal(await resolver.resolveComposer(), undefined);
  // And a page with no composer at all is the same answer, reached the same way.
  const second = composerResolver();
  second.state.healResult = false;
  assert.equal(await second.resolver.resolveComposer(), undefined);
});

test("a healed page whose composer resolves after healing is used directly", async () => {
  const { state, resolver } = composerResolver();
  let attempts = 0;
  const late = composerResolver({
    composer: () => {
      attempts += 1;
      return attempts === 1 ? undefined : { id: "late" };
    },
  });
  assert.deepEqual(await late.resolver.resolveComposer(), { id: "late" });
  assert.equal(state.healed, 0);
});

test("the send control is waited for until it is both present and enabled", async () => {
  const enabled = { isConnected: true, disabled: false };
  let reads = 0;
  const { resolver } = composerResolver({
    sendButton: () => {
      reads += 1;
      if (reads === 1) return undefined;
      if (reads === 2) return { isConnected: true, disabled: true };
      if (reads === 3) return { isConnected: false, disabled: false };
      return enabled;
    },
  });
  assert.equal(await resolver.waitForEnabledSendButton(1_000), enabled);
  assert.equal(reads, 4, "a disconnected or disabled control was accepted");
});

test("a cancelled request stops waiting for a send control", async () => {
  const { state, resolver } = composerResolver({ cancelled: (requestId) => requestId === "cancelled" });
  state.sendButton = { isConnected: true, disabled: true };
  assert.equal(await resolver.waitForEnabledSendButton(1_000, undefined, "cancelled"), undefined);
});

test("a deadline that has passed stops waiting for a send control", async () => {
  const { state, resolver } = composerResolver();
  state.sendButton = { isConnected: true, disabled: true };
  assert.equal(await resolver.waitForEnabledSendButton(1_000, Date.now() - 1), undefined);
});

test("an attachment payload that does not weigh what was declared is refused", () => {
  assert.throws(
    () => attachmentFile({ dataBase64: "AAA=", name: "shot.png", mimeType: "image/png", size: 9 }),
    /Attachment shot\.png size does not match its payload/u,
  );
  const file = attachmentFile({ dataBase64: "AAA=", name: "shot.png", mimeType: "image/png", size: 2 });
  assert.equal(file.name, "shot.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 2);
});

const attachmentStaging = (overrides = {}) => {
  const state = { root: { id: "form" }, inputs: [], control: undefined, clicks: 0 };
  const controls = {
    eligibleAttachmentInputs: () => state.inputs,
    resolveExistingAttachmentInput: ({ inputs, selected }) =>
      selected && inputs.includes(selected) ? selected : inputs.find((input) => input.associated),
    resolveAttachmentControl: () => state.control,
    resolveIntroducedAttachmentInput: ({ introduced, acceptsDetachedInput }) =>
      acceptsDetachedInput ? introduced[0] : introduced.find((input) => input.associated),
  };
  const staging = createAttachmentStaging({
    controls,
    attachmentRoot: () => state.root,
    page: () => ({}),
    associatedSelectors: ["button[data-testid='upload']"],
    delay: async () => undefined,
    cancelled: (requestId) => state.cancelled === requestId,
    openTimeoutMs: 30,
    pollIntervalMs: 1,
    ...overrides,
  });
  return { state, staging, controls };
};

test("an attachment input already associated with the composer is reused and remembered", () => {
  const { state, staging } = attachmentStaging();
  const input = { associated: true };
  state.inputs = [input];
  assert.equal(staging.attachmentInput(), input);
  // Remembered: the same input is returned even once the page stops marking it associated.
  const detached = { associated: false };
  state.inputs = [detached, input];
  assert.equal(staging.attachmentInput(), input);
  // Forgetting it puts the resolution back to what the page says, with nothing remembered.
  staging.forgetAttachmentInput();
  state.inputs = [detached];
  assert.equal(staging.attachmentInput(), undefined);
});

test("a page with no composer root stages nothing and forgets what it had", async () => {
  const { state, staging } = attachmentStaging();
  const input = { associated: true };
  state.inputs = [input];
  assert.equal(staging.attachmentInput(), input);
  state.root = undefined;
  assert.equal(staging.attachmentInput(), undefined);
  assert.equal(await staging.openAttachmentInput(), undefined);
});

test("opening the picker resolves the input the page then introduces", async () => {
  const { state, staging } = attachmentStaging();
  const introduced = { associated: true };
  state.control = { button: { click: () => { state.inputs = [introduced]; } }, acceptsDetachedInput: false };
  assert.equal(await staging.openAttachmentInput(), introduced);
});

test("a detached input is accepted only when the resolved control says it may be", async () => {
  const detached = { associated: false };
  const trusted = attachmentStaging();
  trusted.state.control = {
    button: { click: () => { trusted.state.inputs = [detached]; } },
    acceptsDetachedInput: true,
  };
  assert.equal(await trusted.staging.openAttachmentInput(), detached);

  const strict = attachmentStaging();
  strict.state.control = {
    button: { click: () => { strict.state.inputs = [detached]; } },
    acceptsDetachedInput: false,
  };
  assert.equal(await strict.staging.openAttachmentInput(), undefined);
});

test("a page that offers no upload control stages nothing", async () => {
  const { staging } = attachmentStaging();
  assert.equal(await staging.openAttachmentInput(), undefined);
});

test("staging refuses to start, and stops mid-wait, for a cancelled or expired request", async () => {
  const cancelledBefore = attachmentStaging();
  cancelledBefore.state.cancelled = "request-1";
  assert.equal(await cancelledBefore.staging.openAttachmentInput("request-1"), undefined);

  const expired = attachmentStaging();
  assert.equal(await expired.staging.openAttachmentInput(undefined, Date.now() - 1), undefined);

  const cancelledDuring = attachmentStaging();
  cancelledDuring.state.control = {
    button: { click: () => { cancelledDuring.state.cancelled = "request-2"; } },
    acceptsDetachedInput: false,
  };
  assert.equal(await cancelledDuring.staging.openAttachmentInput("request-2"), undefined);
});

test("an input introduced before the picker opened is not the one the picker introduced", async () => {
  const { state, staging } = attachmentStaging();
  const pre = { associated: false };
  state.inputs = [pre];
  state.control = { button: { click: () => undefined }, acceptsDetachedInput: true };
  assert.equal(await staging.openAttachmentInput(), undefined);
});

const responseBinder = (overrides = {}) => {
  const state = { added: [], healed: 0, cancelled: false, bindings: 0 };
  const binder = createResponseBinder({
    cancelled: () => state.cancelled,
    ensureConversationBinding: async () => {
      state.bindings += 1;
    },
    newAssistantsAfterUser: () => state.added,
    messageId: (element) => element.messageId,
    healDom: async () => {
      state.healed += 1;
    },
    delay: async () => undefined,
    healAfterMs: 0,
    pollIntervalMs: 0,
    ...overrides,
  });
  return { state, binder };
};

const activeRequest = (overrides = {}) => ({
  requestId: "request-1",
  agentId: "agent-1",
  sessionId: "session-1",
  provider: "chatgpt",
  documentToken: "token-1",
  frameId: 0,
  conversationUrl: "https://chatgpt.com/",
  conversationIdentity: "chatgpt:/",
  authorizedConversationIdentity: "chatgpt:/",
  allowInitialConversationTransition: true,
  transitionUsed: false,
  // BR-G6-03. The transition a binder may absorb is the one the provider assigns to a turn
  // that has already been sent, so the default active request is one that has sent it.
  submissionCommitted: true,
  deadlineAt: Date.now() + 1_000,
  text: "hello",
  ...overrides,
});

const submittedUser = () => ({
  element: { messageId: "user-1" },
  previousUsers: new Set(),
  text: "hello",
});

test("exactly one new response after the prompt is what a turn binds to", async () => {
  const { state, binder } = responseBinder();
  const response = { messageId: "assistant-1" };
  state.added = [response];
  const previous = new Set();
  const user = submittedUser();
  assert.deepEqual(await binder.waitForResponseBinding(activeRequest(), previous, user), {
    element: response,
    providerMessageId: "assistant-1",
    previousAssistants: previous,
    submittedUser: user,
  });
  assert.equal(state.bindings, 1, "the turn did not re-check its conversation binding");
});

test("a response with no provider identifier is bound without inventing one", async () => {
  const { state, binder } = responseBinder();
  state.added = [{}];
  const binding = await binder.waitForResponseBinding(activeRequest(), new Set(), submittedUser());
  assert.equal("providerMessageId" in binding, false);
});

test("two new responses is ambiguity a turn refuses rather than guessing between", async () => {
  const { state, binder } = responseBinder();
  state.added = [{}, {}];
  await assert.rejects(
    () => binder.waitForResponseBinding(activeRequest(), new Set(), submittedUser()),
    /More than one new ChatGPT response appeared/u,
  );
});

test("a turn cancelled while waiting reports the interruption, not a timeout", async () => {
  const { state, binder } = responseBinder();
  state.cancelled = true;
  await assert.rejects(
    () => binder.waitForResponseBinding(activeRequest(), new Set(), submittedUser()),
    /ChatGPT request was interrupted/u,
  );
});

test("a response that never appears times out, having tried healing exactly once", async () => {
  const { state, binder } = responseBinder();
  let clock = 0;
  const { binder: bounded, state: boundedState } = responseBinder({ now: () => (clock += 10) });
  await assert.rejects(
    () => bounded.waitForResponseBinding(activeRequest({ deadlineAt: 200 }), new Set(), submittedUser()),
    /Timed out waiting for a new ChatGPT response/u,
  );
  assert.equal(boundedState.healed, 1, "healing was attempted more than once, or not at all");
  assert.equal(state.healed, 0);
});

test("re-binding a replaced response takes the replacement's identifier with it", () => {
  const { binder } = responseBinder();
  const binding = { element: { messageId: "assistant-1" }, providerMessageId: "assistant-1" };
  const replacement = { messageId: "assistant-2" };
  assert.equal(binder.rebindResponse(binding, [replacement]), replacement);
  assert.equal(binding.element, replacement);
  assert.equal(binding.providerMessageId, "assistant-2");
});

test("re-binding refuses an ambiguous or vanished replacement", () => {
  const { binder } = responseBinder();
  const binding = { element: {} };
  assert.throws(
    () => binder.rebindResponse(binding, [{}, {}]),
    /ChatGPT response association became ambiguous/u,
  );
  assert.throws(() => binder.rebindResponse(binding, []), /ChatGPT response association became ambiguous/u);
  assert.throws(() => binder.rebindResponse(binding, [undefined]), /The ChatGPT response disappeared/u);
});

test("re-binding keeps the identifier it had when the replacement carries none", () => {
  const { binder } = responseBinder();
  const binding = { element: {}, providerMessageId: "assistant-1" };
  binder.rebindResponse(binding, [{}]);
  assert.equal(binding.providerMessageId, "assistant-1");
});

const conversationBinder = (overrides = {}) => {
  const state = { url: "https://chatgpt.com/", sent: [], registered: 0 };
  const bind = createConversationBinder({
    documentToken: "token-1",
    provider: "chatgpt",
    currentUrl: () => state.url,
    sendBackground: async (message) => {
      state.sent.push(message);
      return { success: true };
    },
    registerDocument: async () => {
      state.registered += 1;
    },
    ...overrides,
  });
  return { state, bind };
};

test("a request already on the conversation it is bound to announces nothing", async () => {
  const { state, bind } = conversationBinder();
  await bind(activeRequest({ conversationUrl: "https://chatgpt.com/", conversationIdentity: conversationIdentityFor("https://chatgpt.com/") }));
  assert.deepEqual(state.sent, []);
  assert.equal(state.registered, 0);
});

test("the one permitted initial transition is announced and then used up", async () => {
  const { state, bind } = conversationBinder();
  state.url = "https://chatgpt.com/c/new-one";
  const request = activeRequest({
    conversationUrl: "https://chatgpt.com/",
    conversationIdentity: conversationIdentityFor("https://chatgpt.com/"),
  });
  await bind(request);
  assert.equal(state.sent.length, 1);
  assert.deepEqual(state.sent[0], {
    type: "content.transition",
    requestId: "request-1",
    agentId: "agent-1",
    sessionId: "session-1",
    documentToken: "token-1",
    submissionCommitted: true,
    previousConversationUrl: "https://chatgpt.com/",
    conversationUrl: "https://chatgpt.com/c/new-one",
    conversationIdentity: conversationIdentityFor("https://chatgpt.com/c/new-one"),
  });
  assert.equal(request.transitionUsed, true);
  assert.equal(request.conversationUrl, "https://chatgpt.com/c/new-one");
  assert.equal(state.registered, 1);
  // Used up: a second move is a lost binding, not a second transition.
  state.url = "https://chatgpt.com/c/new-two";
  await assert.rejects(
    () => bind(request),
    /The ChatGPT conversation changed during the active request/u,
  );
});

test("a request that may not transition loses its binding when the page moves", async () => {
  for (const change of [
    { allowInitialConversationTransition: false },
    { transitionUsed: true },
    // BR-G6-03. Before the Send there is no turn for the provider to have assigned a
    // conversation to, so a page that moves onto an existing conversation here is somebody
    // else's navigation and submitting into it would put this prompt where nobody asked.
    { submissionCommitted: false },
    { provider: "claude" },
    { documentToken: "token-2" },
    { frameId: 1 },
  ]) {
    const { state, bind } = conversationBinder();
    state.url = "https://chatgpt.com/c/new-one";
    await assert.rejects(
      () => bind(activeRequest({
        conversationUrl: "https://chatgpt.com/",
        conversationIdentity: conversationIdentityFor("https://chatgpt.com/"),
        ...change,
      })),
      /The ChatGPT conversation changed during the active request/u,
      JSON.stringify(change),
    );
    assert.deepEqual(state.sent, []);
  }
});

test("a move the provider's own rule does not recognise is not a transition", async () => {
  const { state, bind } = conversationBinder();
  state.url = "https://chatgpt.com/c/new-one";
  await assert.rejects(
    () => bind(activeRequest({
      conversationUrl: "https://chatgpt.com/c/already-one",
      conversationIdentity: conversationIdentityFor("https://chatgpt.com/c/already-one"),
    })),
    /The ChatGPT conversation changed during the active request/u,
  );
  assert.deepEqual(state.sent, []);
});

test("remembered asset sources are bounded by count, oldest first", () => {
  const store = createAssetSourceStore({ maximumSources: 2, maximumInlineBytes: 1_000 });
  const source = (id) => ({ metadata: { id } });
  store.remember([source("a"), source("b")]);
  assert.deepEqual([...store.sources.keys()], ["a", "b"]);
  store.remember([source("c")]);
  assert.deepEqual([...store.sources.keys()], ["b", "c"]);
  // Re-remembering moves an asset to the end, so the one in use is not the one evicted.
  store.remember([source("b")]);
  assert.deepEqual([...store.sources.keys()], ["c", "b"]);
});

test("remembered asset sources are bounded by inline bytes as well as by count", () => {
  const store = createAssetSourceStore({ maximumSources: 10, maximumInlineBytes: 8 });
  const source = (id, bytes) => ({ metadata: { id }, data: new Uint8Array(bytes) });
  store.remember([source("a", 5), source("b", 5)]);
  assert.deepEqual([...store.sources.keys()], ["b"]);
  // Replacing an asset accounts for the bytes it used to hold rather than double-counting them.
  store.remember([source("b", 2)]);
  assert.deepEqual([...store.sources.keys()], ["b"]);
  store.remember([source("c", 6)]);
  assert.deepEqual([...store.sources.keys()], ["b", "c"]);
});

test("a store that cannot get under its limit stops rather than looping", () => {
  const store = createAssetSourceStore({ maximumSources: 0, maximumInlineBytes: 0 });
  store.remember([{ metadata: { id: "a" } }]);
  assert.equal(store.sources.size, 0);
});

test("installing a document registers it, listens for navigation and re-registers on a clock", async () => {
  const windowListeners = new Map();
  const runtimeListeners = [];
  const intervals = [];
  let registrations = 0;
  let active;
  const ensured = [];
  await withGlobals(
    {
      window: { addEventListener: (type, handler) => windowListeners.set(type, handler) },
      chrome: { runtime: { onMessage: { addListener: (listener) => runtimeListeners.push(listener) } } },
      setInterval: (handler, milliseconds) => {
        intervals.push({ handler, milliseconds });
        return intervals.length;
      },
    },
    async () => {
      installProviderDocument({
        activeRequest: () => active,
        ensureRegisteredUrl: (verify) => ensured.push(verify),
        registerDocument: async () => {
          registrations += 1;
        },
        providerStatus: async () => ({ status: "ready" }),
        submit: async () => ({ submitted: true }),
        interrupt: async () => ({ interrupted: true }),
        assetSources: new Map([["asset-1", { metadata: { id: "asset-1" }, reveal: () => "revealed" }]]),
        publicAssetMetadata: (source) => source.metadata,
        fetchAsset: () => undefined,
        cancelAsset: () => true,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(registrations, 1);
      assert.equal(runtimeListeners.length, 1);
      assert.deepEqual(intervals[0].milliseconds, 1_000);
      intervals[0].handler();
      assert.deepEqual(ensured, [true]);

      // A real navigation re-registers, and one arriving mid-turn does not.
      const onPopState = windowListeners.get("popstate");
      onPopState();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(ensured, [true, undefined]);
      active = { requestId: "request-1" };
      onPopState();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(ensured, [true, undefined]);

      // And the table it installed answers for the assets this document published.
      const answer = (message) =>
        new Promise((resolve) => {
          runtimeListeners[0](message, {}, resolve);
        });
      assert.deepEqual(await answer({ type: "asset.probe", assetId: "asset-1" }), {
        success: true,
        asset: { id: "asset-1" },
      });
      assert.deepEqual(await answer({ type: "asset.probe", assetId: "asset-missing" }), { success: true });
      assert.deepEqual(await answer({ type: "asset.reveal", assetId: "asset-1" }), { success: true });
      const missingReveal = await answer({ type: "asset.reveal", assetId: "asset-missing" });
      assert.equal(missingReveal.success, false);
      // And a controller asking the document to re-register is answered by the same table.
      assert.deepEqual(await answer({ type: "content.reregister" }), { success: true });
      assert.equal(registrations, 2);
      // A status read re-registers the URL first, so the controller never reads a stale one.
      assert.deepEqual(await answer({ type: "provider.status" }), { status: "ready" });
      assert.deepEqual(ensured, [true, undefined, undefined]);
    },
  );
});

test("response activity is measured from the node the answer is being read from", async () => {
  fakeMutationObservers.length = 0;
  let clock = 100;
  await withGlobals({ MutationObserver: FakeMutationObserver }, () => {
    const activity = createResponseActivityObserver({ now: () => clock });
    assert.equal(activity.lastMutationAt(), 100);
    const first = {};
    clock = 200;
    activity.bind(first);
    assert.equal(activity.lastMutationAt(), 200);
    // Re-binding the same node changes nothing: it is the same reading.
    clock = 300;
    activity.bind(first);
    assert.equal(activity.lastMutationAt(), 200);
    assert.equal(fakeMutationObservers.length, 1);
    fakeMutationObservers[0].fire();
    assert.equal(activity.lastMutationAt(), 300);
    // A replacement is a fresh reading, so the quiet clock starts again with it.
    clock = 400;
    activity.bind({});
    assert.equal(fakeMutationObservers[0].disconnected, true);
    assert.equal(activity.lastMutationAt(), 400);
    clock = 500;
    activity.touch();
    assert.equal(activity.lastMutationAt(), 500);
    activity.disconnect();
    assert.equal(fakeMutationObservers[1].disconnected, true);
  });
});

const promptWaiter = (overrides = {}) => {
  const state = { messages: [], healed: 0, cancelled: false };
  const wait = createSubmittedPromptWaiter({
    cancelled: () => state.cancelled,
    ensureConversationBinding: async () => undefined,
    userMessages: () => state.messages,
    messageId: (element) => element.messageId,
    healDom: async () => {
      state.healed += 1;
    },
    delay: async () => undefined,
    healAfterMs: 0,
    pollIntervalMs: 0,
    ...overrides,
  });
  return { state, wait };
};

test("the submitted prompt is matched by its rendered text, not by position", async () => {
  const { state, wait } = promptWaiter();
  const match = { innerText: "hello\r\n", messageId: "user-1" };
  state.messages = [{ innerText: "something else" }, match];
  const binding = await wait(activeRequest(), new Set());
  assert.equal(binding.element, match);
  assert.equal(binding.providerMessageId, "user-1");
  assert.equal(binding.text, "hello");
});

test("a message the page already showed is not this turn's prompt", async () => {
  let clock = 0;
  const previous = { innerText: "hello" };
  const { wait } = promptWaiter({ now: () => (clock += 10) });
  await assert.rejects(
    () => wait(activeRequest({ deadlineAt: 100 }), new Set([previous])),
    /Timed out waiting for the submitted ChatGPT message/u,
  );
});

test("two messages with the prompt's text is ambiguity the turn refuses", async () => {
  const { state, wait } = promptWaiter();
  state.messages = [{ innerText: "hello" }, { innerText: "hello" }];
  await assert.rejects(
    () => wait(activeRequest(), new Set()),
    /More than one matching ChatGPT user message appeared/u,
  );
});

test("waiting for the prompt stops when the request is cancelled", async () => {
  const { state, wait } = promptWaiter();
  state.cancelled = true;
  await assert.rejects(() => wait(activeRequest(), new Set()), /ChatGPT request was interrupted/u);
});

test("waiting for the prompt heals once, and no more, before it gives up", async () => {
  let clock = 0;
  const { state, wait } = promptWaiter({ now: () => (clock += 10) });
  await assert.rejects(
    () => wait(activeRequest({ deadlineAt: 200 }), new Set()),
    /Timed out waiting for the submitted ChatGPT message/u,
  );
  assert.equal(state.healed, 1);
});

test("a stream update is sent only when the captured text has actually moved", async () => {
  const sent = [];
  const send = createStreamSender({ documentToken: "token-1", maximumResponseBytes: 1_000 });
  await withGlobals(
    { chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return { success: true }; } } } },
    async () => {
      await send(activeRequest(), "hello", "hello");
      assert.deepEqual(sent, []);
      await send(activeRequest(), "hello", "hello world");
      assert.deepEqual(sent, [{
        type: "content.stream",
        requestId: "request-1",
        agentId: "agent-1",
        sessionId: "session-1",
        documentToken: "token-1",
        mode: "append",
        text: " world",
      }]);
    },
  );
});

test("a captured response past the limit is refused before any of it is streamed", async () => {
  const sent = [];
  const send = createStreamSender({ documentToken: "token-1", maximumResponseBytes: 4 });
  await withGlobals(
    { chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return { success: true }; } } } },
    async () => {
      await assert.rejects(
        () => send(activeRequest(), "", "far too long"),
        /ChatGPT captured response/u,
      );
      assert.deepEqual(sent, []);
    },
  );
});

const indeterminateMonitor = (overrides = {}) => {
  const state = { busy: true, active: true, quarantined: [], cleared: [], settled: [], forgotten: [] };
  let clock = 0;
  const monitor = createIndeterminateMonitor({
    isBusy: () => {
      if (state.throws) throw new Error("ambiguous provider controls");
      return state.busy;
    },
    delay: async () => {
      clock += 500;
    },
    stillActive: () => state.active,
    quarantine: (identity) => state.quarantined.push(identity),
    clearQuarantine: (identity) => state.cleared.push(identity),
    settle: (requestId) => state.settled.push(requestId),
    forget: (requestId) => state.forgotten.push(requestId),
    now: () => clock,
    ...overrides,
  });
  return { state, monitor };
};

test("a turn seen busy and then quiet settles, and its quarantine is lifted", async () => {
  const { state, monitor } = indeterminateMonitor();
  let reads = 0;
  const { state: run, monitor: watch } = indeterminateMonitor({
    isBusy: () => {
      reads += 1;
      return reads < 2;
    },
  });
  await watch({ requestId: "request-1", conversationIdentity: "chatgpt:one" });
  assert.deepEqual(run.quarantined, ["chatgpt:one"]);
  assert.deepEqual(run.cleared, ["chatgpt:one"]);
  assert.deepEqual(run.settled, ["request-1"]);
  assert.deepEqual(run.forgotten, []);
  assert.deepEqual(state.settled, []);
});

test("a turn never seen busy waits far longer, and its quarantine stays", async () => {
  const { state, monitor } = indeterminateMonitor({ isBusy: () => false });
  await monitor({ requestId: "request-1", conversationIdentity: "chatgpt:one" });
  assert.deepEqual(state.quarantined, ["chatgpt:one"]);
  assert.deepEqual(state.cleared, [], "a turn that was never seen running had its quarantine lifted");
  assert.deepEqual(state.settled, ["request-1"]);
});

test("a page that cannot be read restarts the quiet clock rather than settling on it", async () => {
  let reads = 0;
  const { state, monitor } = indeterminateMonitor({
    isBusy: () => {
      reads += 1;
      if (reads < 3) throw new Error("ambiguous provider controls");
      return false;
    },
  });
  await monitor({ requestId: "request-1", conversationIdentity: "chatgpt:one" });
  assert.deepEqual(state.settled, ["request-1"]);
});

test("a document taken over by another turn forgets the monitored request and stops", async () => {
  const { state, monitor } = indeterminateMonitor({ stillActive: () => false });
  await monitor({ requestId: "request-1", conversationIdentity: "chatgpt:one" });
  assert.deepEqual(state.settled, []);
  assert.deepEqual(state.forgotten, ["request-1"]);
  assert.deepEqual(state.quarantined, ["chatgpt:one"]);
});

test("a message that does not name this document, frame and conversation matches nothing", () => {
  const bound = {
    boundProvider: "chatgpt",
    boundDocumentToken: "token-1",
    boundUrl: "https://chatgpt.com/c/one",
    boundIdentity: "chatgpt:one",
  };
  const message = {
    provider: "chatgpt",
    documentToken: "token-1",
    frameId: 0,
    conversationUrl: "https://chatgpt.com/c/one",
    conversationIdentity: "chatgpt:one",
  };
  assert.equal(requestMatchesDocument({ ...message, ...bound }), true);
  for (const change of [
    { provider: "claude" },
    { documentToken: "token-2" },
    { frameId: 1 },
    { conversationUrl: "https://chatgpt.com/c/two" },
    { conversationIdentity: "chatgpt:two" },
  ]) {
    assert.equal(requestMatchesDocument({ ...message, ...bound, ...change }), false, JSON.stringify(change));
  }
});

const interruptHandler = (overrides = {}) => {
  const state = {
    active: undefined,
    preSubmit: [],
    healingCancelled: 0,
    quarantined: [],
    cleared: [],
    confirmed: true,
    bindingThrows: false,
  };
  const handler = createInterruptHandler({
    provider: "chatgpt",
    documentToken: "token-1",
    currentUrl: () => "https://chatgpt.com/c/one",
    currentIdentity: () => "chatgpt:one",
    activeRequest: () => state.active,
    rememberPreSubmit: (requestId) => state.preSubmit.push(requestId),
    cancelHealing: () => {
      state.healingCancelled += 1;
    },
    ensureConversationBinding: async () => {
      if (state.bindingThrows) throw new Error("The ChatGPT conversation changed during the active request");
    },
    interruptAndConfirm: async () => state.confirmed,
    quarantine: (identity) => state.quarantined.push(identity),
    clearQuarantine: (identity) => state.cleared.push(identity),
    ...overrides,
  });
  return { state, handler };
};

const interruptMessage = (overrides = {}) => ({
  provider: "chatgpt",
  requestId: "request-1",
  documentToken: "token-1",
  frameId: 0,
  conversationUrl: "https://chatgpt.com/c/one",
  conversationIdentity: "chatgpt:one",
  ...overrides,
});

test("an interrupt for another document is refused without touching the page", async () => {
  const { state, handler } = interruptHandler();
  for (const change of [
    { provider: "claude" },
    { documentToken: "token-2" },
    { frameId: 1 },
    { conversationUrl: "https://chatgpt.com/c/two" },
    { conversationIdentity: "chatgpt:two" },
  ]) {
    assert.deepEqual(
      await handler(interruptMessage(change)),
      { interrupted: false, error: "The request no longer matches this browser document" },
      JSON.stringify(change),
    );
  }
  assert.deepEqual(state.preSubmit, []);
  assert.equal(state.healingCancelled, 0);
});

// BR-G6-04. After the provider assigns a conversation to the turn, the page shows the new one
// and the controller's Stop still names the one it authorized. Refusing that Stop leaves a
// committed turn running with nothing able to stop it.
test("a Stop naming the conversation the controller authorized reaches a transitioned turn", async () => {
  const { state, handler } = interruptHandler();
  state.active = {
    requestId: "request-1",
    documentToken: "token-1",
    frameId: 0,
    conversationUrl: "https://chatgpt.com/c/one",
    conversationIdentity: "chatgpt:one",
    authorizedConversationIdentity: "chatgpt:fresh",
    transitionUsed: true,
    submissionCommitted: true,
  };
  assert.deepEqual(
    await handler(interruptMessage({
      conversationUrl: "https://chatgpt.com/",
      conversationIdentity: "chatgpt:fresh",
    })),
    { interrupted: true },
  );
  assert.deepEqual(state.quarantined, []);
});

test("a Stop naming a conversation this turn was never bound to is still refused", async () => {
  const active = {
    requestId: "request-1",
    documentToken: "token-1",
    frameId: 0,
    conversationUrl: "https://chatgpt.com/c/one",
    conversationIdentity: "chatgpt:one",
    authorizedConversationIdentity: "chatgpt:fresh",
    transitionUsed: true,
    submissionCommitted: true,
  };
  const { handler } = interruptHandler({ activeRequest: () => active });
  assert.deepEqual(
    await handler(interruptMessage({
      conversationUrl: "https://chatgpt.com/c/three",
      conversationIdentity: "chatgpt:three",
    })),
    { interrupted: false, error: "The request no longer matches this browser document" },
  );
});

// A request that never transitioned cannot borrow the allowance: its authorization and its
// dispatch binding are the same conversation, so nothing else may stand in for the page.
test("an untransitioned turn does not accept a Stop for a conversation the page is not showing", async () => {
  const active = {
    requestId: "request-1",
    documentToken: "token-1",
    frameId: 0,
    conversationUrl: "https://chatgpt.com/c/one",
    conversationIdentity: "chatgpt:one",
    authorizedConversationIdentity: "chatgpt:fresh",
    transitionUsed: false,
    submissionCommitted: true,
  };
  const { handler } = interruptHandler({ activeRequest: () => active });
  assert.deepEqual(
    await handler(interruptMessage({
      conversationUrl: "https://chatgpt.com/",
      conversationIdentity: "chatgpt:fresh",
    })),
    { interrupted: false, error: "The request no longer matches this browser document" },
  );
});

test("cancelling a turn that was never running is enough, and stops any repair", async () => {
  const { state, handler } = interruptHandler();
  assert.deepEqual(await handler(interruptMessage()), { interrupted: true });
  assert.deepEqual(state.preSubmit, ["request-1"]);
  assert.equal(state.healingCancelled, 1);
});

test("a turn that has not committed is cancelled without asking the page to stop", async () => {
  const { state, handler } = interruptHandler();
  state.active = activeRequest({ submissionCommitted: false, conversationIdentity: "chatgpt:one" });
  assert.deepEqual(await handler(interruptMessage()), { interrupted: true });
  assert.deepEqual(state.preSubmit, ["request-1"]);
  assert.equal(state.quarantined.length, 0);
});

test("an interrupt naming a turn that is not the running one is refused", async () => {
  const { state, handler } = interruptHandler();
  state.active = activeRequest({ requestId: "request-2", conversationIdentity: "chatgpt:one" });
  assert.deepEqual(
    await handler(interruptMessage()),
    { interrupted: false, error: "The request is no longer active" },
  );
  state.active = activeRequest({ conversationIdentity: "chatgpt:other" });
  assert.deepEqual(
    await handler(interruptMessage()),
    { interrupted: false, error: "The request is no longer active" },
  );
  state.active = activeRequest({ frameId: 1, conversationIdentity: "chatgpt:one" });
  assert.equal((await handler(interruptMessage())).error, "The request is no longer active");
  state.active = activeRequest({ documentToken: "token-2", conversationIdentity: "chatgpt:one" });
  assert.equal((await handler(interruptMessage())).error, "The request is no longer active");
});

test("a committed turn the page confirms stopped lifts the conversation's quarantine", async () => {
  const { state, handler } = interruptHandler();
  state.active = activeRequest({ submissionCommitted: true, conversationIdentity: "chatgpt:one" });
  assert.deepEqual(await handler(interruptMessage()), { interrupted: true });
  assert.deepEqual(state.cleared, ["chatgpt:one"]);
  assert.deepEqual(state.quarantined, []);
});

test("a committed turn the page will not confirm is quarantined, not reported as stopped", async () => {
  const { state, handler } = interruptHandler();
  state.active = activeRequest({ submissionCommitted: true, conversationIdentity: "chatgpt:one" });
  state.confirmed = false;
  assert.deepEqual(await handler(interruptMessage()), {
    interrupted: false,
    error: "ChatGPT did not confirm interruption",
  });
  assert.deepEqual(state.quarantined, ["chatgpt:one"]);
  assert.deepEqual(state.cleared, []);
});

test("a committed turn whose conversation moved under it is quarantined with the reason", async () => {
  const { state, handler } = interruptHandler();
  state.active = activeRequest({ submissionCommitted: true, conversationIdentity: "chatgpt:one" });
  state.bindingThrows = true;
  assert.deepEqual(await handler(interruptMessage()), {
    interrupted: false,
    error: "The ChatGPT conversation changed during the active request",
  });
  assert.deepEqual(state.quarantined, ["chatgpt:one"]);
});

test("the shared behaviour reads the real clock when a caller supplies none", async () => {
  // Every one of these takes an injected clock so a bounded failure can be proved without a
  // multi-second wait. The default is the one production uses, so it is exercised too.
  fakeMutationObservers.length = 0;
  await withGlobals({ MutationObserver: FakeMutationObserver }, () => {
    const before = Date.now();
    const activity = createResponseActivityObserver();
    assert.ok(activity.lastMutationAt() >= before);
  });

  let active = true;
  const settled = [];
  const monitor = createIndeterminateMonitor({
    isBusy: () => false,
    delay: async () => {
      active = false;
    },
    stillActive: () => active,
    quarantine: () => undefined,
    clearQuarantine: () => undefined,
    settle: () => undefined,
    forget: (requestId) => settled.push(requestId),
  });
  await monitor({ requestId: "request-1", conversationIdentity: "chatgpt:one" });
  assert.deepEqual(settled, ["request-1"]);

  const control = createInterruptControl({
    stopButton: () => undefined,
    isBusy: () => false,
    heal: async () => false,
    delay: async () => undefined,
    waitForResolvedControl: globalThis.__pairProviderControls.waitForResolvedControl,
    rememberCancellation: () => undefined,
    forgetCancellation: () => undefined,
    stillBound: () => true,
  });
  assert.equal(await control.interruptAndConfirm("request-1", true), false);
});
