import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";

const dom = createGenericDom("<main id=\"root\"></main>");
const {
  captureGenericResponse,
  conversationHoldsNonce,
  createGenericResponseLifecycleState,
} = await import("../dist/content/generic/responseCapture.js");

const NONCE = "bachata-nonce-91af";

const conversation = (assistantHtml = "") => {
  dom.document.body.innerHTML = `
    <main id="root">
      <article data-message-author-role="user">Please review this. ${NONCE}</article>
      ${assistantHtml}
    </main>
  `;
  return dom.query("#root");
};

const assistant = (body) =>
  `<article data-message-author-role="assistant">${body}</article>`;

const rootResolver = () => dom.query("#root") ?? undefined;

// Completion is confirmed only after a quiet period, so a lifecycle that has already seen
// generation end lets a test prove the confirmed path without waiting out a real generation.
const settledLifecycle = (timeoutMs = 20_000) => ({
  ...createGenericResponseLifecycleState(Date.now() + timeoutMs),
  sawGeneration: true,
  generationEndedAt: Date.now() - 5_000,
});

const capture = (options = {}) => captureGenericResponse(
  options.resolveRoot ?? rootResolver,
  options.nonce ?? NONCE,
  options.signal ?? new AbortController().signal,
  options.timeoutMs ?? 20_000,
  options.generationActive,
  options.responseRecipe,
  options.assertCurrentConversation,
  options.onStream,
  options.lifecycle,
  options.attestOwnership,
);

test("a cancelled capture aborts instead of returning a partial answer", async () => {
  conversation(assistant("<p>partial answer</p>"));
  const controller = new AbortController();
  controller.abort();
  const failure = await capture({
    signal: controller.signal,
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  }).then(() => undefined, (error) => error);
  assert.ok(failure, "a cancelled capture returned a response");
  assert.equal(failure.name, "AbortError");
});

test("a deadline that has already passed is refused before the page is touched", async () => {
  conversation(assistant("<p>answer</p>"));
  let reads = 0;
  const failure = await capture({
    resolveRoot: () => {
      reads += 1;
      return dom.query("#root");
    },
    lifecycle: {
      ...createGenericResponseLifecycleState(Date.now() - 1),
      sawGeneration: true,
    },
  }).then(() => undefined, (error) => error);
  assert.match(String(failure.message), /deadline has expired/u);
  assert.equal(reads, 0, "an expired capture still read the page");
});

test("a conversation that never shows the submitted request is reported, not guessed at", async () => {
  dom.document.body.innerHTML = `<main id="root"><article>an unrelated conversation</article></main>`;
  const failure = await capture({ timeoutMs: 1_100, generationActive: () => false })
    .then(() => undefined, (error) => error);
  assert.match(String(failure.message), /nonce was not found/u);
});

test("a capture stops when the human sends another turn before the answer is captured", async () => {
  conversation(`${assistant("<p>partial</p>")}<article data-message-author-role="user">and another thing</article>`);
  const failure = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  }).then(() => undefined, (error) => error);
  assert.match(String(failure.message), /Another user turn appeared/u);
});

test("a response with no observable generation lifecycle is refused rather than trusted", async () => {
  conversation(assistant("<p>an answer that simply appeared</p>"));
  const failure = await capture({
    generationActive: () => false,
    lifecycle: {
      ...createGenericResponseLifecycleState(Date.now() + 20_000),
      sawGeneration: false,
      responseObservedAt: Date.now() - 20_000,
    },
  }).then(() => undefined, (error) => error);
  assert.match(String(failure.message), /without an observable generation lifecycle/u);
  assert.match(String(failure.message), /Stop control/u, "the refusal does not say what to repair");
});

test("a capture stops the moment the conversation it was bound to changed", async () => {
  conversation(assistant("<p>answer</p>"));
  const failure = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
    assertCurrentConversation: () => {
      throw new Error("The active generic conversation changed");
    },
  }).then(() => undefined, (error) => error);
  assert.match(String(failure.message), /conversation changed/u);
});

test("a re-rendered conversation is re-anchored rather than abandoned", async () => {
  conversation(assistant("<p>first draft</p>"));
  let renders = 0;
  const streamed = [];
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
    onStream: (text) => {
      streamed.push(text);
      renders += 1;
      if (renders === 1) {
        // The provider replaces the whole conversation subtree mid-answer.
        conversation(assistant("<p>first draft, now complete</p>"));
      }
    },
  });
  assert.ok(renders >= 2, "the capture never re-anchored after the page was rebuilt");
  assert.match(captured.text, /now complete/u, "the capture kept the answer from the discarded tree");
  assert.ok(
    streamed.some((text) => /first draft/u.test(text)),
    "the partial answer was never streamed",
  );
});

test("a root that disappears briefly is waited out, not treated as a lost conversation", async () => {
  conversation(assistant("<p>answer</p>"));
  const detached = dom.document.createElement("main");
  let reads = 0;
  const captured = await capture({
    resolveRoot: () => {
      reads += 1;
      // The provider swaps the conversation container out for two polls.
      return reads <= 2 ? detached : dom.query("#root");
    },
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.ok(reads > 2, "the capture never waited out the missing conversation root");
  assert.match(captured.text, /answer/u);
});

test("a confirmed answer is captured as text, Markdown and segments", async () => {
  conversation(assistant(`
    <p>The retry loop is unbounded.</p>
    <blockquote>Traced to the cancel path.</blockquote>
    <pre><code class="language-js">while (true) {}</code></pre>
  `));
  const streamed = [];
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
    onStream: (text) => streamed.push(text),
  });
  assert.match(captured.text, /The retry loop is unbounded\./u);
  assert.match(captured.markdown, /```js\nwhile \(true\) \{\}\n```/u, "the code block lost its language");
  assert.match(captured.markdown, /> Traced to the cancel path\./u, "the quote was not preserved");
  assert.deepEqual(
    [...new Set(captured.segments.map((segment) => segment.type))].sort(),
    ["codeBlock", "quote", "text"],
    "the captured answer was not separated into text, quote and code",
  );
  const code = captured.segments.find((segment) => segment.type === "codeBlock");
  assert.equal(code.language, "js");
  assert.equal(captured.text.slice(code.start, code.end), code.text, "a segment does not index its own text");
  assert.ok(streamed.length >= 1, "nothing was streamed while the answer was being captured");
});

test("the newest assistant turn is captured when the provider left older ones in place", async () => {
  conversation(`
    ${assistant("<p>an older answer</p>")}
    ${assistant("<p>the newest answer</p>")}
  `);
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.match(captured.text, /the newest answer/u);
  assert.doesNotMatch(captured.text, /an older answer/u);
});

test("a page that never confirms completion times out saying what would fix it", async () => {
  conversation(assistant("<p>answer</p>"));
  const failure = await capture({ timeoutMs: 1_400 })
    .then(() => undefined, (error) => error);
  assert.match(String(failure.message), /Timed out/u);
  assert.match(
    String(failure.message),
    /bind a Stop control or use explicit manual completion/u,
    "the timeout does not say how to make completion observable",
  );
});

test("a page whose generation never ends times out as an unfinished lifecycle", async () => {
  conversation(assistant("<p>still writing</p>"));
  const failure = await capture({
    timeoutMs: 1_400,
    generationActive: () => true,
  }).then(() => undefined, (error) => error);
  assert.match(String(failure.message), /confirmed generic browser generation lifecycle/u);
});

test("a bound response locator finds the answer on a page with no message roles", async () => {
  dom.document.body.innerHTML = `
    <main id="root">
      <div class="turn"><span>Please review this. ${NONCE}</span></div>
      <div class="turn" data-testid="assistant-turn"><span>The bound answer</span></div>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
    responseRecipe: {
      tag: "div",
      stableAttributes: { "data-testid": "assistant-turn" },
      structuralPath: [],
    },
  });
  assert.match(captured.text, /The bound answer/u);
});

test("a provider that labels nothing still yields the sibling turn that follows the request", async () => {
  dom.document.body.innerHTML = `
    <main id="root">
      <div class="turn"><span>Please review this. ${NONCE}</span></div>
      <div class="turn"><span>The structural answer</span></div>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.match(
    captured.text,
    /The structural answer/u,
    "an unlabelled provider yielded no answer at all",
  );
});

test.after(() => dom.restore());

// BB-9. The prompt search ran `root.querySelectorAll("*")` and then measured every element it
// found — `getBoundingClientRect` plus `getComputedStyle`, forcing layout and style recalc — at
// 10 Hz over the whole conversation subtree. The cheap text test runs first now, so only the
// elements that could be the prompt are ever measured.
test("the prompt search measures only the elements whose text could match", async () => {
  const noise = Array.from(
    { length: 200 },
    (_unused, index) => `<p data-noise="${String(index)}">unrelated paragraph ${String(index)}</p>`,
  ).join("");
  conversation(assistant(`<div>${noise}<p>answer</p></div>`));

  const elementPrototype = Object.getPrototypeOf(dom.query("#root"));
  const original = elementPrototype.getBoundingClientRect;
  const measured = new Set();
  Object.defineProperty(elementPrototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: function getBoundingClientRect() {
      measured.add(this);
      return original.call(this);
    },
  });
  try {
    const response = await capture({
      generationActive: () => false,
      lifecycle: settledLifecycle(),
    });
    assert.match(response.text, /answer/u);
  } finally {
    Object.defineProperty(elementPrototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: original,
    });
  }

  const measuredNoise = [...measured].filter(
    (element) => element.getAttribute?.("data-noise") !== null,
  );
  assert.deepEqual(
    measuredNoise.map((element) => element.getAttribute("data-noise")),
    [],
    "the prompt search measured elements whose text cannot contain the nonce",
  );
});

// BR-G6-06. Node identity is not ownership. An SPA that recycles its message nodes when the
// conversation changes leaves the anchor connected, in the same root, still passing every
// structural check, while the turn underneath became somebody else's. Only the nonce says
// whose turn it is, so it is rechecked every pass rather than remembered from the first.
test("a recycled anchor node stops owning a capture once it carries another conversation's turn", async () => {
  conversation(assistant("<p>answer</p>"));
  const anchor = dom.query('[data-message-author-role="user"]');
  let polls = 0;
  const failure = await capture({
    generationActive: () => {
      polls += 1;
      if (polls === 2) {
        anchor.textContent = "A question from a conversation nobody asked for";
        dom.query('[data-message-author-role="assistant"]').textContent = "another conversation's answer";
      }
      return false;
    },
    // Long enough that a capture which kept trusting the recycled node would settle on the
    // foreign answer and return it, and short enough that losing the anchor times out instead.
    lifecycle: settledLifecycle(5_000),
    timeoutMs: 5_000,
  }).then((value) => value, (error) => error);
  assert.ok(polls >= 2, "the capture never reached the poll that recycled the node");
  assert.ok(
    failure instanceof Error,
    `a recycled node returned another conversation's response: ${JSON.stringify(failure)}`,
  );
});

test("a conversation that changes during the last stream frame is not finalized", async () => {
  conversation(assistant("<p>answer</p><pre><code>const x = 1;</code></pre>"));
  const anchor = dom.query('[data-message-author-role="user"]');
  const streamed = [];
  const failure = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(3_000),
    timeoutMs: 3_000,
    // The final frame is the one sent from inside the confirmed branch, after the response is
    // chosen and before it is returned. The page moves on while it is in flight.
    onStream: async (text) => {
      streamed.push(text);
      if (streamed.length === 2) {
        anchor.textContent = "A question from a conversation nobody asked for";
      }
    },
  }).then((value) => value, (error) => error);
  assert.equal(streamed.length, 2, "the capture never sent a final frame, so nothing was raced");
  assert.ok(failure instanceof Error, "a response was finalized after its conversation changed");
  assert.match(failure.message, /nonce is no longer present in the active generic conversation/u);
});

// BR-G6-13. A site that marks up its bubbles as well as its turns matches the message selector
// twice over. The anchor used to be the innermost of those, so the rest of the user's own turn —
// an attachment strip, a second bubble — read as messages that arrived after the prompt: one of
// them was reported as another user turn and aborted the capture, and on markup without author
// roles one of them would have been captured as the answer.
test("a turn whose own markup nests message nodes still captures the real answer", async () => {
  dom.document.body.innerHTML = `
    <main id="root">
      <article data-message-author-role="user">
        <div data-testid="message-text">Please review this. ${NONCE}</div>
        <div data-testid="message-attachments">screenshot.png</div>
      </article>
      <article data-message-author-role="assistant">
        <div data-testid="message-text">the real answer</div>
      </article>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.match(captured.text, /the real answer/u);
  assert.doesNotMatch(captured.text, /screenshot\.png/u, "the prompt's own attachment strip was captured as the answer");
});

test("a nested message node inside the prompt's own turn is not a later user turn", async () => {
  // The same markup without author roles: nothing can tell the fragments apart by role, so the
  // only thing keeping the prompt's own contents out of the answer is that they are inside it.
  dom.document.body.innerHTML = `
    <main id="root">
      <div data-testid="turn">
        <div data-testid="message-text">Please review this. ${NONCE}</div>
        <div data-testid="message-attachments">screenshot.png</div>
      </div>
      <div data-testid="turn"><div data-testid="message-text">the real answer</div></div>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.match(captured.text, /the real answer/u);
  assert.doesNotMatch(captured.text, /screenshot\.png/u);
});


// BB-A4-N03. The conversation an answer belongs to used to be read after the capture had
// returned, so a page that navigated in between named the conversation it had moved to. The
// answer now carries the page it was accepted in, recorded in the same synchronous run as the
// checks that proved the answer is this request's.
test("an accepted answer carries the page it was accepted in, not the page as it is later", async () => {
  conversation(assistant("<p>the answer from conversation A</p>"));
  const page = {
    requestId: "request-a",
    documentRevision: 4,
    conversationUrl: "https://generic.invalid/chat/a",
    conversationIdentity: "generic:https://generic.invalid/chat/a",
  };
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
    attestOwnership: () => ({ ...page }),
  });
  // The page navigates the instant the capture returns — the window between accepting an answer
  // and the finalizer's first line, which no await inside the finalizer can see.
  page.documentRevision = 5;
  page.conversationUrl = "https://generic.invalid/chat/b";
  page.conversationIdentity = "generic:https://generic.invalid/chat/b";

  assert.equal(captured.text.includes("the answer from conversation A"), true);
  assert.equal(captured.attestation.requestId, "request-a");
  assert.equal(captured.attestation.documentRevision, 4);
  assert.equal(captured.attestation.conversationUrl, "https://generic.invalid/chat/a");
  assert.equal(captured.attestation.conversationIdentity, "generic:https://generic.invalid/chat/a");
  assert.equal(captured.attestation.nonce, NONCE);
  // The bound response identity travels with it, so finalization can prove the node it read is
  // still the node it read, inside the conversation it read it from.
  assert.equal(captured.attestation.responseElement, dom.query("[data-message-author-role=assistant]"));
  assert.equal(captured.attestation.conversationRoot, dom.query("#root"));
  assert.equal(
    conversationHoldsNonce(captured.attestation.promptElement, NONCE),
    true,
    "the attested anchor no longer proves whose turn the answer answers",
  );
});

test("a capture with no ownership to attest still reports which turn it answered", async () => {
  conversation(assistant("<p>an answer</p>"));
  const captured = await capture({ generationActive: () => false, lifecycle: settledLifecycle() });
  assert.equal(captured.attestation.requestId, "");
  assert.equal(captured.attestation.conversationIdentity, "");
  assert.equal(captured.attestation.nonce, NONCE);
});

// BB-A4-F13. An assistant turn and the action strip a site marks up inside it both answer to the
// message selector, and `DOCUMENT_POSITION_FOLLOWING` is set for a descendant — so the innermost
// node sorted last and "the latest candidate" was the Copy button. Instrumented against the
// unfixed build the candidate list reads `["turn:assistant", "strip:assistant"]` and the captured
// answer is "Copy".
test("a nested action strip never becomes the answer", async () => {
  dom.document.body.innerHTML = `
    <main id="root">
      <article data-message-author-role="user">Please review this. ${NONCE}</article>
      <article data-message-author-role="assistant" data-testid="conversation-turn-3">
        <div class="markdown">The retry loop is unbounded.</div>
        <div data-testid="message-actions"><button>Copy</button></div>
      </article>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.match(captured.text, /The retry loop is unbounded/u, "the action strip was captured as the answer");
});

test("the bound response region wins over the action strip beside it", async () => {
  dom.document.body.innerHTML = `
    <main id="root">
      <article data-message-author-role="user">Please review this. ${NONCE}</article>
      <article data-message-author-role="assistant">
        <div data-testid="message-content">The retry loop is unbounded.</div>
        <div data-testid="message-actions"><button>Copy</button></div>
      </article>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
    responseRecipe: {
      tag: "div",
      stableAttributes: { "data-testid": "message-content" },
      structuralPath: [],
    },
  });
  assert.match(captured.text, /The retry loop is unbounded/u);
  assert.doesNotMatch(captured.text, /Copy/u, "the bound region lost to the strip beside it");
});

test("an action strip does not become the answer when no author role labels the turn", async () => {
  dom.document.body.innerHTML = `
    <main id="root">
      <div data-testid="turn">Please review this. ${NONCE}</div>
      <div data-testid="turn">
        <div data-testid="message-body">The retry loop is unbounded.</div>
        <div data-testid="message-actions"><button>Copy</button></div>
      </div>
    </main>
  `;
  const captured = await capture({
    generationActive: () => false,
    lifecycle: settledLifecycle(),
  });
  assert.match(captured.text, /The retry loop is unbounded/u);
});
