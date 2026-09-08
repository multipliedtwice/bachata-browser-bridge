import assert from "node:assert/strict";
import test from "node:test";

await import("../dist/content/providerControls.js");

const controls = globalThis.__pairProviderControls;
assert.ok(controls);

const button = (disabled = false) => ({ disabled });
const input = () => ({});

const rootWith = (matches, contained = []) => ({
  querySelectorAll: (selector) => matches.get(selector) ?? [],
  contains: (element) => contained.includes(element),
});

test("queryUniqueWithin returns no control without a root", () => {
  assert.equal(
    controls.queryUniqueWithin(undefined, ["button"], "ambiguous"),
    undefined,
  );
});

test("queryUniqueWithin deduplicates selector matches", () => {
  const candidate = button();
  const root = rootWith(new Map([
    ["button.send", [candidate]],
    ["button[aria-label='Send']", [candidate]],
  ]));
  assert.equal(
    controls.queryUniqueWithin(
      root,
      ["button.send", "button[aria-label='Send']"],
      "ambiguous",
    ),
    candidate,
  );
});

test("queryUniqueWithin rejects ambiguous controls", () => {
  const root = rootWith(new Map([["button", [button(), button()]]]));
  assert.throws(
    () => controls.queryUniqueWithin(root, ["button"], "ambiguous send controls"),
    /ambiguous send controls/u,
  );
});

test("attachment control prefers one enabled composer control", () => {
  const associated = button();
  const disabled = button(true);
  const root = rootWith(new Map([["attach", [associated, disabled]]]), [associated]);
  const page = rootWith(new Map([["trusted", [button()]]]));
  assert.deepEqual(
    controls.resolveAttachmentControl({
      provider: "Provider",
      root,
      page,
      associatedSelectors: ["attach"],
      trustedDetachedSelectors: ["trusted"],
    }),
    { button: associated, acceptsDetachedInput: false },
  );
});

test("attachment control rejects multiple composer controls", () => {
  const root = rootWith(new Map([["attach", [button(), button()]]]));
  assert.throws(
    () => controls.resolveAttachmentControl({
      provider: "Provider",
      root,
      page: root,
      associatedSelectors: ["attach"],
    }),
    /Provider composer contains ambiguous attachment controls/u,
  );
});

test("attachment control accepts one explicitly trusted detached control", () => {
  const trusted = button();
  const root = rootWith(new Map([["attach", []]]));
  const page = rootWith(new Map([["trusted", [trusted]]]));
  assert.deepEqual(
    controls.resolveAttachmentControl({
      provider: "Provider",
      root,
      page,
      associatedSelectors: ["attach"],
      trustedDetachedSelectors: ["trusted"],
    }),
    { button: trusted, acceptsDetachedInput: true },
  );
});

test("attachment control ignores trusted matches inside the composer", () => {
  const trusted = button();
  const root = rootWith(new Map([["attach", []]]), [trusted]);
  const page = rootWith(new Map([["trusted", [trusted]]]));
  assert.equal(
    controls.resolveAttachmentControl({
      provider: "Provider",
      root,
      page,
      associatedSelectors: ["attach"],
      trustedDetachedSelectors: ["trusted"],
    }),
    undefined,
  );
});

test("attachment control rejects multiple trusted detached controls", () => {
  const root = rootWith(new Map([["attach", []]]));
  const page = rootWith(new Map([["trusted", [button(), button()]]]));
  assert.throws(
    () => controls.resolveAttachmentControl({
      provider: "Provider",
      root,
      page,
      associatedSelectors: ["attach"],
      trustedDetachedSelectors: ["trusted"],
    }),
    /Provider page contains ambiguous trusted attachment controls/u,
  );
});

test("attachment control returns undefined without associated or trusted controls", () => {
  const root = rootWith(new Map());
  assert.equal(
    controls.resolveAttachmentControl({
      provider: "Provider",
      root,
      page: root,
      associatedSelectors: ["attach"],
    }),
    undefined,
  );
});

test("introduced input must belong to the composer for associated controls", () => {
  const associated = input();
  const root = rootWith(new Map(), [associated]);
  assert.equal(
    controls.resolveIntroducedAttachmentInput({
      provider: "Provider",
      root,
      introduced: [associated],
      acceptsDetachedInput: false,
    }),
    associated,
  );
});

test("introduced detached input is accepted only for a trusted detached control", () => {
  const detached = input();
  const root = rootWith(new Map());
  assert.equal(
    controls.resolveIntroducedAttachmentInput({
      provider: "Provider",
      root,
      introduced: [detached],
      acceptsDetachedInput: true,
    }),
    detached,
  );
  assert.throws(
    () => controls.resolveIntroducedAttachmentInput({
      provider: "Provider",
      root,
      introduced: [detached],
      acceptsDetachedInput: false,
    }),
    /Provider attachment control introduced an input outside the composer/u,
  );
});

test("introduced inputs reject ambiguity", () => {
  const first = input();
  const second = input();
  const root = rootWith(new Map(), [first, second]);
  assert.throws(
    () => controls.resolveIntroducedAttachmentInput({
      provider: "Provider",
      root,
      introduced: [first, second],
      acceptsDetachedInput: false,
    }),
    /Provider page introduced ambiguous attachment inputs/u,
  );
});

test("introduced input resolver waits when no input exists", () => {
  const root = rootWith(new Map());
  assert.equal(
    controls.resolveIntroducedAttachmentInput({
      provider: "Provider",
      root,
      introduced: [],
      acceptsDetachedInput: false,
    }),
    undefined,
  );
});

test("eligible attachment inputs accept enabled image-compatible inputs", () => {
  const unrestricted = { disabled: false, accept: "" };
  const image = { disabled: false, accept: "image/png" };
  const wildcard = { disabled: false, accept: "*/*" };
  const text = { disabled: false, accept: "text/plain" };
  const disabled = { disabled: true, accept: "image/jpeg" };
  const page = rootWith(new Map([
    ["input[type='file']", [unrestricted, image, wildcard, text, disabled]],
  ]));
  assert.deepEqual(
    controls.eligibleAttachmentInputs(page),
    [unrestricted, image, wildcard],
  );
});

test("existing attachment input retains a selected input that is still present", () => {
  const selected = input();
  const root = rootWith(new Map());
  assert.equal(
    controls.resolveExistingAttachmentInput({
      root,
      inputs: [selected],
      selected,
    }),
    selected,
  );
});

test("existing attachment input resolves one composer-associated input", () => {
  const associated = input();
  const detached = input();
  const root = rootWith(new Map(), [associated]);
  assert.equal(
    controls.resolveExistingAttachmentInput({
      root,
      inputs: [detached, associated],
    }),
    associated,
  );
});

test("existing attachment input returns undefined without an associated input", () => {
  const root = rootWith(new Map());
  assert.equal(
    controls.resolveExistingAttachmentInput({
      root,
      inputs: [input()],
    }),
    undefined,
  );
});

test("existing attachment input rejects ambiguous composer-associated inputs", () => {
  const first = input();
  const second = input();
  const root = rootWith(new Map(), [first, second]);
  assert.equal(
    controls.resolveExistingAttachmentInput({
      root,
      inputs: [first, second],
    }),
    undefined,
  );
});

// The verdict moved to background-owned chrome.storage.session. These exercise the client
// half that chatgpt.ts and claude.ts use: it must reach the authority, must keep providers
// apart, and must never turn an unreachable authority into a send.
const quarantineCalls = [];
let quarantineReply = async () => ({ ok: true, value: false });
globalThis.chrome = {
  runtime: {
    id: "bachata-bridge-test",
    sendMessage: async (message) => {
      quarantineCalls.push(message);
      return await quarantineReply(message);
    },
  },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a quarantine read asks the background rather than any page storage", async () => {
  quarantineCalls.length = 0;
  quarantineReply = async () => ({ ok: true, value: true });
  assert.equal(await controls.conversationIsQuarantined("chatgpt", "conversation-a"), true);
  assert.deepEqual(quarantineCalls.at(-1), {
    type: "BACHATA_QUARANTINE_IS",
    provider: "chatgpt",
    conversationIdentity: "conversation-a",
  });
});

test("quarantining and clearing reach the background as explicit verdict moves", async () => {
  quarantineCalls.length = 0;
  quarantineReply = async () => ({ ok: true });
  controls.quarantineConversation("chatgpt", "conversation-a");
  controls.clearConversationQuarantine("claude", "conversation-b");
  await settle();
  assert.deepEqual(quarantineCalls.map((call) => call.type), ["BACHATA_QUARANTINE_SET", "BACHATA_QUARANTINE_CLEAR"]);
  assert.equal(quarantineCalls[0].provider, "chatgpt");
  assert.equal(quarantineCalls[1].provider, "claude");
});

test("quarantine ignores empty provider or identity values", async () => {
  quarantineCalls.length = 0;
  controls.quarantineConversation("", "identity-x");
  controls.quarantineConversation("cov-empty", "");
  controls.clearConversationQuarantine("", "");
  await settle();
  assert.deepEqual(quarantineCalls, [], "an incomplete target was sent to the authority");
  assert.equal(await controls.conversationIsQuarantined("", "identity-x"), true);
  assert.equal(await controls.conversationIsQuarantined("cov-empty", ""), true);
});

test("an unreachable authority blocks the send, cache or no cache", async () => {
  quarantineReply = async () => ({ ok: true });
  controls.quarantineConversation("cov-offline", "kept-identity");
  await settle();
  quarantineReply = async () => { throw new Error("service worker asleep"); };
  assert.equal(
    await controls.conversationQuarantineState("cov-offline", "kept-identity"),
    "unavailable",
  );
  assert.equal(
    await controls.conversationIsQuarantined("cov-offline", "kept-identity"),
    true,
    "an unreachable authority read as not quarantined",
  );
  // The identity this realm has never heard of is exactly the one an unavailable authority
  // must still refuse: a fresh conversation is not evidence, it is only absence of evidence.
  assert.equal(
    await controls.conversationQuarantineState("cov-offline", "never-quarantined"),
    "unavailable",
  );
  assert.equal(
    await controls.conversationIsQuarantined("cov-offline", "never-quarantined"),
    true,
    "an empty cache turned an unreachable authority into permission to send",
  );
});

test("an unavailable answer never deletes a cached positive", async () => {
  quarantineReply = async () => ({ ok: true });
  controls.quarantineConversation("cov-keep", "identity");
  await settle();
  quarantineReply = async () => ({ ok: false, error: "Conversation quarantine authority is unavailable" });
  assert.equal(await controls.conversationQuarantineState("cov-keep", "identity"), "unavailable");
  // Recovery, not amnesia: once the authority answers again it still holds the verdict.
  quarantineReply = async () => ({ ok: true, value: true });
  assert.equal(await controls.conversationQuarantineState("cov-keep", "identity"), "quarantined");
  quarantineReply = async () => { throw new Error("asleep"); };
  assert.equal(await controls.conversationIsQuarantined("cov-keep", "identity"), true);
});

test("an invalid target is refused without asking, and never reads as clear", async () => {
  quarantineCalls.length = 0;
  assert.equal(await controls.conversationQuarantineState("", "identity"), "unavailable");
  assert.equal(await controls.conversationQuarantineState("cov-invalid", ""), "unavailable");
  assert.deepEqual(quarantineCalls, [], "an incomplete target was sent to the authority");
});

test("a confirmed clear overrides a stale local cache", async () => {
  quarantineReply = async () => ({ ok: true });
  controls.quarantineConversation("cov-sync", "identity");
  await settle();
  quarantineReply = async () => ({ ok: true, value: false });
  assert.equal(await controls.conversationQuarantineState("cov-sync", "identity"), "clear");
  assert.equal(await controls.conversationIsQuarantined("cov-sync", "identity"), false);
  // The cached positive is gone, but an authority that stops answering is still not a clear:
  // availability may drop, safety may not.
  quarantineReply = async () => { throw new Error("asleep"); };
  assert.equal(
    await controls.conversationQuarantineState("cov-sync", "identity"),
    "unavailable",
  );
});

test("a malformed authority answer is not read as a clear verdict", async () => {
  quarantineReply = async () => ({ ok: true });
  controls.quarantineConversation("cov-malformed", "identity");
  await settle();
  for (const reply of [undefined, {}, { ok: false, error: "nope" }, { ok: true, value: "yes" }]) {
    quarantineReply = async () => reply;
    assert.equal(
      await controls.conversationQuarantineState("cov-malformed", "identity"),
      "unavailable",
      `a ${JSON.stringify(reply)} answer was read as a verdict`,
    );
    assert.equal(
      await controls.conversationIsQuarantined("cov-malformed", "identity"),
      true,
      `a ${JSON.stringify(reply)} answer cleared the verdict`,
    );
  }
});

test("a built-in verdict whose write never landed survives an honest false", async () => {
  quarantineReply = async (message) => (
    message.type === "BACHATA_QUARANTINE_SET"
      ? { ok: false, error: "Conversation quarantine authority is unavailable" }
      : { ok: true, value: false }
  );
  controls.quarantineConversation("cov-unwritten", "identity");
  await settle();
  assert.equal(
    await controls.conversationQuarantineState("cov-unwritten", "identity"),
    "quarantined",
    "a failed write was released by the false the failure itself produced",
  );

  quarantineReply = async (message) => (
    message.type === "BACHATA_QUARANTINE_CLEAR" ? { ok: true } : { ok: true, value: false }
  );
  controls.clearConversationQuarantine("cov-unwritten", "identity");
  await settle();
  assert.equal(await controls.conversationQuarantineState("cov-unwritten", "identity"), "clear");
});

test("a clear the authority refused does not release the built-in verdict", async () => {
  quarantineReply = async () => ({ ok: true });
  controls.quarantineConversation("cov-refused-clear", "identity");
  await settle();
  quarantineReply = async (message) => (
    message.type === "BACHATA_QUARANTINE_CLEAR"
      ? { ok: false, error: "Conversation quarantine authority is unavailable" }
      : { ok: true, value: true }
  );
  controls.clearConversationQuarantine("cov-refused-clear", "identity");
  await settle();
  assert.equal(await controls.conversationQuarantineState("cov-refused-clear", "identity"), "quarantined");
});

// BB-AUD-10. Both providers wait for the send control and the stop control through this one
// seam. The resolver throws when the page offers more than one candidate, and that must never
// end as a resolved control: the wait absorbs it, repairs once, then fails closed.

const controlWait = (overrides = {}) => {
  const events = [];
  let clock = 0;
  const options = {
    resolve: () => undefined,
    heal: async () => { events.push("heal"); },
    delay: async (ms) => { events.push(`delay:${String(ms)}`); clock += ms; },
    pollIntervalMs: 50,
    timeoutMs: 200,
    now: () => clock,
    ...overrides,
  };
  return { events, options, advance: (ms) => { clock += ms; } };
};

test("a control that resolves at once is returned without repair or polling", async () => {
  const target = { isConnected: true };
  const wait = controlWait({ resolve: () => target });
  assert.equal(await controls.waitForResolvedControl(wait.options), target);
  assert.deepEqual(wait.events, []);
});

test("an ambiguous control is absorbed, repaired once, then fails closed at the deadline", async () => {
  let calls = 0;
  const wait = controlWait({
    resolve: () => {
      calls += 1;
      throw new Error("page contains ambiguous provider controls");
    },
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);
  assert.ok(calls > 1, "the wait gave up after the first ambiguous read");
  assert.equal(wait.events[0], "heal", "no repair was attempted");
  assert.equal(wait.events.filter((entry) => entry === "heal").length, 1, "repair repeated");
  assert.deepEqual(
    new Set(wait.events.filter((entry) => entry !== "heal")),
    new Set(["delay:50"]),
  );
});

test("a control that becomes resolvable after the repair is returned", async () => {
  const target = { isConnected: true };
  let ambiguous = true;
  const wait = controlWait({
    resolve: () => {
      if (ambiguous) throw new Error("ambiguous");
      return target;
    },
    heal: async () => { ambiguous = false; },
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), target);
});

test("a control that fails the extra condition is never returned", async () => {
  const disabled = { isConnected: true, disabled: true };
  const wait = controlWait({
    resolve: () => disabled,
    accept: (value) => value.isConnected && !value.disabled,
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);

  const enabled = { isConnected: true, disabled: false };
  const accepted = controlWait({
    resolve: () => enabled,
    accept: (value) => value.isConnected && !value.disabled,
  });
  assert.equal(await controls.waitForResolvedControl(accepted.options), enabled);
});

test("a detached control is refused as firmly as an ambiguous one", async () => {
  const wait = controlWait({
    resolve: () => ({ isConnected: false, disabled: false }),
    accept: (value) => value.isConnected && !value.disabled,
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);
});

test("an abandoned wait stops before resolving anything", async () => {
  let resolved = 0;
  const wait = controlWait({
    resolve: () => { resolved += 1; return { isConnected: true }; },
    abandoned: () => true,
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);
  assert.equal(resolved, 0, "an abandoned wait still touched the page");
  assert.deepEqual(wait.events, []);
});

test("a wait abandoned part way through stops repairing and polling", async () => {
  let reads = 0;
  const wait = controlWait({
    resolve: () => {
      reads += 1;
      throw new Error("ambiguous");
    },
    abandoned: () => reads >= 2,
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);
  assert.equal(reads, 2);
  // One repair and one poll interval, then the abandonment is seen at the top of the loop.
  assert.deepEqual(wait.events, ["heal", "delay:50"]);
});

test("a wait with no time left never touches the page", async () => {
  let resolved = 0;
  const wait = controlWait({
    resolve: () => { resolved += 1; return { isConnected: true }; },
    timeoutMs: 0,
  });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);
  assert.equal(resolved, 0);
});

test("the poll interval the caller asked for is the one that is waited", async () => {
  const wait = controlWait({ resolve: () => undefined, pollIntervalMs: 100, timeoutMs: 300 });
  assert.equal(await controls.waitForResolvedControl(wait.options), undefined);
  assert.deepEqual(
    wait.events,
    ["heal", "delay:100", "delay:100", "delay:100"],
  );
});

test("a wait with no clock injected reads the real one", async () => {
  // The providers pass no clock; the seam falls back to `Date.now`, and a wait whose time is
  // already gone touches nothing.
  let resolved = 0;
  assert.equal(
    await controls.waitForResolvedControl({
      resolve: () => { resolved += 1; return { isConnected: true }; },
      heal: async () => undefined,
      delay: async () => undefined,
      pollIntervalMs: 50,
      timeoutMs: 0,
    }),
    undefined,
  );
  assert.equal(resolved, 0);
});
