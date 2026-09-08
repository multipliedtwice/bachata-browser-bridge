import assert from "node:assert/strict";
import test from "node:test";

import * as backgroundConversation from "../dist/background/conversation.js";
import { createGenericDom } from "./support/genericDom.mjs";

await import("../dist/content/providerLogic.js");
await import("../dist/content/claudeLogic.js");

const PROVIDER_LABEL = "Claude";

const {
  assertTextWithinLimit,
  createComposerGuard,
  writeStagedAttachments,
  canonicalConversationUrl,
  canonicalizeRenderedPrompt,
  composeCapturedResponse,
  conversationIdentityFor,
  createRegistrationCoordinator,
  isBusyState,
  isSupportedInitialTransition,
  sessionIdForConversation,
  shouldCompleteResponse,
  singleNewItem,
  streamUpdate,
  uniqueItem,
  utf8ByteLength,
} = globalThis.__pairClaudeLogic;

test("Claude prompt canonicalization and stream updates are deterministic", () => {
  assert.equal(canonicalizeRenderedPrompt("a\r\nb\u00a0c\n"), "a\nb c");
  assert.deepEqual(streamUpdate("hello", "hello world"), {
    mode: "append",
    text: " world",
  });
  assert.deepEqual(streamUpdate("hello x", "hello y"), {
    mode: "replace",
    text: "hello y",
  });
  assert.equal(streamUpdate("same", "same"), undefined);
});

test("Claude response association rejects ambiguous messages and controls", () => {
  const old = {};
  const added = {};
  assert.equal(singleNewItem(new Set([old]), [old, added]), added);
  assert.throws(
    () => singleNewItem(new Set([old]), [old, {}, {}]),
    /More than one new Claude message appeared/,
  );
  assert.equal(uniqueItem([added, added]), added);
  assert.throws(() => uniqueItem([{}, {}]), /ambiguous provider controls/);
});

test("Claude response limits use UTF-8 bytes", () => {
  assert.equal(utf8ByteLength("🙂"), 4);
  assert.doesNotThrow(() => assertTextWithinLimit("🙂", 4, "response"));
  assert.throws(
    () => assertTextWithinLimit("🙂", 3, "response"),
    /response exceeds 3 bytes/,
  );
});

test("Claude conversation binding helpers match the background", () => {
  const url = "https://claude.ai/chat/example/?ignored=1#ignored";
  const identity = conversationIdentityFor(url);
  assert.equal(
    canonicalConversationUrl(url),
    backgroundConversation.canonicalConversationUrl("claude", url),
  );
  assert.equal(
    identity,
    backgroundConversation.conversationIdentityFor("claude", url),
  );
  assert.equal(
    sessionIdForConversation(8, "doc", identity),
    backgroundConversation.sessionIdForConversation("claude", 8, "doc", identity),
  );
  assert.equal(
    isSupportedInitialTransition(
      "https://claude.ai/new",
      "https://claude.ai/chat/example",
    ),
    backgroundConversation.isSupportedInitialTransition(
      "claude",
      "https://claude.ai/new",
      "https://claude.ai/chat/example",
    ),
  );
  assert.equal(
    isSupportedInitialTransition(
      "https://claude.ai/chat/one",
      "https://claude.ai/chat/two",
    ),
    false,
  );
});

test("Claude structured capture preserves code and quote ranges", () => {
  const captured = composeCapturedResponse([
    { type: "text", text: "Result\n" },
    { type: "quote", text: "quoted\n" },
    { type: "codeBlock", text: "const x = 1;", language: "typescript" },
  ]);
  assert.equal(captured.text, "Result\nquoted\nconst x = 1;");
  assert.deepEqual(captured.segments, [
    { type: "text", text: "Result\n", start: 0, end: 7 },
    { type: "quote", text: "quoted\n", start: 7, end: 14 },
    {
      type: "codeBlock",
      text: "const x = 1;",
      start: 14,
      end: 26,
      language: "typescript",
    },
  ]);
});

test("Claude response completion requires a busy-to-idle transition", () => {
  assert.equal(isBusyState(true), true);
  assert.equal(isBusyState(false), false);
  assert.equal(
    shouldCompleteResponse({
      busyObserved: false,
      currentlyBusy: false,
      responseText: "complete",
      quietForMs: 2_000,
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

test("Claude registration retries and verifies stable URLs", async () => {
  let attempts = 0;
  let now = 1_000;
  const coordinator = createRegistrationCoordinator({
    currentUrl: () => "https://claude.ai/chat/example",
    now: () => now,
    verificationIntervalMs: 10_000,
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
  now += 10_000;
  await coordinator.ensure(true);
  assert.equal(attempts, 3);
});

// BB-6. The second parameter was declared, computed at every call site, and ignored. Only the
// Stop control marks generation: providers disable Send while composing, while uploading and
// on an empty composer, so a disabled Send is not evidence of a running response.
test("busy state is decided by the Stop control alone", () => {
  assert.equal(isBusyState(true), true);
  assert.equal(isBusyState(false), false);
  assert.equal(isBusyState.length, 1, "isBusyState still declares an ignored parameter");
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
