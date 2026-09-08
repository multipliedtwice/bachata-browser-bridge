import assert from "node:assert/strict";
import test from "node:test";

// REVIEW-11 / BB-5. The local-model client is the content side of the extension's only
// outbound network path. Nothing exercised it: the module is bundled into the generic content
// script and was never imported on its own, so its cancellation handshake, its refusal
// mapping and its candidate bounds were unguarded.

const saved = new Map();
const define = (name, value) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
const restore = () => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  saved.clear();
};

const pageEvents = [];
define("addEventListener", (type, listener, options) => {
  pageEvents.push({ type, listener, options });
});
define("removeEventListener", (type, listener) => {
  const index = pageEvents.findIndex((entry) => entry.type === type && entry.listener === listener);
  if (index >= 0) pageEvents.splice(index, 1);
});

let sent = [];
let reply = { ok: true, text: "{}" };
define("chrome", {
  runtime: {
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === "BACHATA_LOCAL_MODEL_CANCEL") return { ok: true };
      return typeof reply === "function" ? reply(message) : reply;
    },
  },
});

const { healWithLocalModel, healResponseWithLocalModel } = await import(
  "../dist/content/generic/localModel.js"
);
const { DOM_HEALING_CANDIDATE_LIMIT, RESPONSE_HEALING_CANDIDATE_LIMIT } = await import(
  "../dist/content/generic/healing.js"
);

test.after(restore);

const candidate = (overrides = {}) => ({
  id: "c1",
  kindHint: "unknown",
  tag: "div",
  visible: true,
  domOrder: 0,
  mutationCount: 0,
  textGrowth: 0,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  ...overrides,
});

const reset = (nextReply) => {
  sent = [];
  pageEvents.length = 0;
  reply = nextReply;
};

test("a healing request carries one identifier and a prompt built from the candidates", async () => {
  reset({ ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) });
  await healWithLocalModel([candidate()], 1_800_000_000_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "BACHATA_LOCAL_MODEL_PROMPT");
  assert.equal(typeof sent[0].requestId, "string");
  assert.ok(sent[0].requestId.length > 0);
  assert.equal(sent[0].deadlineAt, 1_800_000_000_000);
  assert.match(sent[0].prompt, /c1/u);
});

test("a request with no deadline sends none rather than an empty one", async () => {
  reset({ ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) });
  await healWithLocalModel([candidate()]);
  assert.equal(Object.hasOwn(sent[0], "deadlineAt"), false);
});

test("the page-hide cancellation is armed for the request and disarmed when it ends", async () => {
  reset({ ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) });
  let armedDuringRequest = 0;
  reply = (message) => {
    armedDuringRequest = pageEvents.filter((entry) => entry.type === "pagehide").length;
    return { ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) };
  };
  await healWithLocalModel([candidate()]);
  assert.equal(armedDuringRequest, 1);
  assert.equal(pageEvents.filter((entry) => entry.type === "pagehide").length, 0);
});

test("leaving the page cancels the request by its own identifier", async () => {
  reset({ ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) });
  let cancel;
  reply = () => {
    cancel = pageEvents.find((entry) => entry.type === "pagehide").listener;
    cancel();
    return { ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) };
  };
  await healWithLocalModel([candidate()]);
  const cancellation = sent.find((message) => message.type === "BACHATA_LOCAL_MODEL_CANCEL");
  assert.ok(cancellation, "leaving the page sent no cancellation");
  assert.equal(cancellation.requestId, sent[0].requestId);
});

test("a refusal is reported in the broker's own words, and an unexplained one is named", async () => {
  reset({ ok: false, error: "Selector healing is disabled in Bachata settings" });
  await assert.rejects(
    healWithLocalModel([candidate()]),
    /disabled in Bachata settings/u,
  );

  reset({ ok: false });
  await assert.rejects(
    healWithLocalModel([candidate()]),
    /Local model selector-healing request failed/u,
  );

  reset(undefined);
  await assert.rejects(
    healWithLocalModel([candidate()]),
    /Local model selector-healing request failed/u,
  );

  reset({ ok: true });
  await assert.rejects(
    healWithLocalModel([candidate()]),
    /Local model selector-healing request failed/u,
  );
});

test("the candidate list handed to the model is bounded", async () => {
  reset({ ok: true, text: JSON.stringify({ protocol: "bachata-dom-heal-v1", status: "unsupported", roles: {} }) });
  const many = Array.from({ length: DOM_HEALING_CANDIDATE_LIMIT + 10 }, (_unused, index) =>
    candidate({ id: `c${String(index + 1)}`, domOrder: index }));
  await healWithLocalModel(many);
  assert.equal(
    sent[0].prompt.includes(`"c${String(DOM_HEALING_CANDIDATE_LIMIT + 1)}"`),
    false,
    "the prompt carried a candidate past the bound",
  );
});

test("response healing asks nothing when no candidate could be a response", async () => {
  reset(() => {
    throw new Error("no request should be made");
  });
  const decision = await healResponseWithLocalModel([candidate({ kindHint: "composer" })]);
  assert.deepEqual(decision, {
    protocol: "bachata-response-heal-v1",
    status: "unsupported",
    responseMessageIds: [],
  });
  assert.deepEqual(sent, []);
});

test("response healing prefers messages, keeps text-bearing candidates, and stays bounded", async () => {
  reset({
    ok: true,
    text: JSON.stringify({
      protocol: "bachata-response-heal-v1",
      status: "ok",
      responseMessageIds: ["m1"],
    }),
  });
  await healResponseWithLocalModel([
    candidate({ id: "t1", textPreview: "some text" }),
    candidate({ id: "m1", kindHint: "message", textPreview: "an answer" }),
    candidate({ id: "x1" }),
  ]);
  // A candidate with neither a message hint nor any text is not a possible response.
  assert.equal(sent[0].prompt.includes("x1"), false);
  // Messages are offered before other text-bearing candidates.
  assert.ok(sent[0].prompt.indexOf("m1") < sent[0].prompt.indexOf("t1"));
});

test("the response candidate list is bounded, and messages fill it first", async () => {
  reset({ ok: true, text: "{}" });
  const overflow = RESPONSE_HEALING_CANDIDATE_LIMIT + 5;
  await healResponseWithLocalModel([
    candidate({ id: "t1", textPreview: "some text" }),
    ...Array.from({ length: overflow }, (_unused, index) =>
      candidate({ id: `m${String(index + 1)}`, kindHint: "message", textPreview: "more" })),
  ]);
  assert.equal(sent[0].prompt.includes("t1"), false, "a text-only candidate displaced a message");
  assert.equal(
    sent[0].prompt.includes(`m${String(overflow)}`),
    false,
    "the prompt carried a candidate past the bound",
  );
});
