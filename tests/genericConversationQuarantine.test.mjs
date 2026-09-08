import assert from "node:assert/strict";
import test from "node:test";

// The verdict now lives in chrome.storage.session, owned by the background. A page cannot
// reach that area, so these tests drive the authority directly and then drive the content
// client against a background that can be made to disagree or disappear.

const sessionArea = new Map();
// Production has both areas. The emergency store is where a verdict goes when the session store
// refuses it, so a harness without one cannot exercise the path that keeps a refusal alive.
const localArea = new Map();
const runtimeId = "bachata-bridge-test";
let deliver = async () => undefined;

globalThis.chrome = {
  runtime: {
    id: runtimeId,
    sendMessage: async (message) => await deliver(message),
  },
  storage: {
    session: {
      get: async (key) => (sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) sessionArea.set(key, value);
      },
    },
    local: {
      get: async (key) => (localArea.has(key) ? { [key]: localArea.get(key) } : {}),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) localArea.set(key, value);
      },
    },
  },
};

// The authority holds unpersistable verdicts in worker memory, which outlives page reloads but not
// a worker restart. That restart needs a second module instance, and a second instance of the same
// path confuses coverage attribution, so it lives in its own file: tests/quarantineWorkerRestart.
const authority = await import("../dist/background/quarantine.js");
const client = await import("../dist/content/generic/conversationQuarantine.js");

const storageKey = "bachataConversationQuarantine.v1";
const emergencyStorageKey = "bachataConversationQuarantineEmergency.v1";
const overflowKey = "bachataConversationQuarantineOverflow.v1";
const reset = async () => {
  sessionArea.clear();
  localArea.clear();
  client.resetConversationQuarantineCache();
  deliver = async (message) => await authority.handleQuarantineMessage(message, { id: runtimeId });
};

// Isolation between tests comes from distinct conversation identities. A held verdict for one
// identity cannot answer for another, so no test needs a fresh module and the module under test
// stays a single measured module.

test("the authority holds a verdict the page storage area never sees", async () => {
  await reset();
  assert.equal(await authority.quarantineConversation("generic", "generic:https://x/y"), true);
  assert.equal(
    await authority.conversationQuarantineVerdict("generic", "generic:https://x/y"),
    "quarantined",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic", "generic:https://x/other"),
    "clear",
  );
  assert.equal(sessionArea.has(storageKey), true, "the verdict was not written to extension session storage");
});

// The exact defeat that made this a defect: a valid empty object accepted by the old reader
// replaced the in-memory copy as well, so nothing survived it.
test("a page-shaped empty-object overwrite cannot clear the verdict", async () => {
  await reset();
  await authority.quarantineConversation("chatgpt", "chatgpt:https://chatgpt.com/c/a");
  globalThis.sessionStorage = {
    getItem: () => "{}",
    setItem: () => undefined,
    clear: () => undefined,
  };
  assert.equal(
    await client.conversationIsQuarantined("chatgpt", "chatgpt:https://chatgpt.com/c/a"),
    true,
    "a page-controlled empty object defeated the verdict",
  );
  delete globalThis.sessionStorage;
});

test("a verdict survives a document reload, which discards every content-script cache", async () => {
  await reset();
  await authority.quarantineConversation("generic", "generic:https://x/y");
  // A reload gives the page a fresh realm: the client cache starts empty.
  client.resetConversationQuarantineCache();
  assert.equal(await client.conversationIsQuarantined("generic", "generic:https://x/y"), true);
});

test("clearing through the client reaches the authority", async () => {
  await reset();
  await authority.quarantineConversation("generic", "generic:https://x/y");
  client.clearConversationQuarantine("generic", "generic:https://x/y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await authority.conversationIsQuarantined("generic", "generic:https://x/y"), false);
});

test("quarantining through the client reaches the authority", async () => {
  await reset();
  client.quarantineConversation("generic", "generic:https://x/z");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await authority.conversationIsQuarantined("generic", "generic:https://x/z"), true);
});

test("providers stay isolated from one another", async () => {
  await reset();
  await authority.quarantineConversation("chatgpt", "shared-identity");
  assert.equal(await authority.conversationIsQuarantined("chatgpt", "shared-identity"), true);
  assert.equal(await authority.conversationIsQuarantined("claude", "shared-identity"), false);
  assert.equal(await authority.conversationIsQuarantined("generic", "shared-identity"), false);
});

test("a verdict expires instead of outliving its window", async () => {
  await reset();
  const now = Date.now();
  await authority.quarantineConversation("generic", "generic:https://x/y", now);
  assert.equal(
    await authority.conversationIsQuarantined("generic", "generic:https://x/y", now + 1_000),
    true,
  );
  assert.equal(
    await authority.conversationIsQuarantined(
      "generic",
      "generic:https://x/y",
      now + authority.quarantineLifetimeMs + 1,
    ),
    false,
    "an expired verdict was still enforced",
  );
});

// Availability must not be able to turn a refusal into a send.
test("an unreachable background falls back to the cache rather than to confirmed", async () => {
  await reset();
  client.quarantineConversation("generic", "generic:https://x/offline");
  await new Promise((resolve) => setTimeout(resolve, 0));
  deliver = async () => { throw new Error("service worker asleep"); };
  assert.equal(
    await client.conversationIsQuarantined("generic", "generic:https://x/offline"),
    true,
    "an unreachable authority read as not quarantined",
  );
});

test("a foreign sender cannot move the verdict", async () => {
  await reset();
  const refused = await authority.handleQuarantineMessage(
    { type: "BACHATA_QUARANTINE_SET", provider: "generic", conversationIdentity: "generic:https://x/y" },
    { id: "some-other-extension" },
  );
  assert.deepEqual(refused, { ok: false, error: "Invalid conversation quarantine sender" });
  assert.equal(await authority.conversationIsQuarantined("generic", "generic:https://x/y"), false);
});

test("unrelated message types are declined so other handlers still see them", async () => {
  await reset();
  assert.equal(
    await authority.handleQuarantineMessage({ type: "BACHATA_GENERIC_STATUS" }, { id: runtimeId }),
    undefined,
  );
});

// Malformed is not empty. The authority never wrote these shapes, so it cannot read them as a
// verdict — and reading them as "no verdict" is the same fail-open as a rejected `get`.
test("malformed stored state is unavailable, not a confirmed clear", async () => {
  await reset();
  for (const corrupt of [
    "{}",
    [],
    null,
    7,
    { generic: "not-an-array" },
    { generic: [{ identity: 1 }] },
    { generic: [{ identity: "x" }] },
    { generic: [{ identity: "x", expiresAt: "soon" }] },
    { "": [] },
  ]) {
    sessionArea.set(storageKey, corrupt);
    assert.equal(
      await authority.conversationQuarantineVerdict("generic", "generic:https://x/y"),
      "unavailable",
      `${JSON.stringify(corrupt)} was read as a verdict`,
    );
    assert.equal(await authority.conversationIsQuarantined("generic", "generic:https://x/y"), true);
    assert.deepEqual(
      await authority.handleQuarantineMessage(
        { type: "BACHATA_QUARANTINE_IS", provider: "generic", conversationIdentity: "generic:https://x/y" },
        { id: runtimeId },
      ),
      { ok: false, error: authority.quarantineUnavailableError },
    );
  }
});

test("an absent key and an empty state are both a confirmed clear", async () => {
  await reset();
  assert.equal(
    await authority.conversationQuarantineVerdict("generic", "generic:https://x/y"),
    "clear",
    "an untouched storage area was read as unavailable",
  );
  // What a full clear leaves behind: the key present, holding nothing.
  sessionArea.set(storageKey, {});
  assert.equal(await authority.conversationQuarantineVerdict("generic", "generic:https://x/y"), "clear");
});

test("an expired record is well formed and simply out of force", async () => {
  await reset();
  const now = Date.now();
  sessionArea.set(storageKey, { generic: [{ identity: "generic:https://x/y", expiresAt: now - 1 }] });
  assert.equal(
    await authority.conversationQuarantineVerdict("generic", "generic:https://x/y", now),
    "clear",
  );
});

test("an authority answer of false clears a cached verdict", async () => {
  await reset();
  client.quarantineConversation("generic", "generic:https://x/y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The authority is the source of truth in both directions, not only when it says true.
  deliver = async () => ({ ok: true, value: false });
  assert.equal(await client.conversationIsQuarantined("generic", "generic:https://x/y"), false);
  // The cached positive is gone, but an authority that stops answering is still not a clear.
  deliver = async () => { throw new Error("asleep"); };
  assert.equal(
    await client.conversationQuarantineState("generic", "generic:https://x/y"),
    "unavailable",
  );
});

test("an incomplete target never reaches the authority and never reads as clear", async () => {
  await reset();
  const seen = [];
  deliver = async (message) => { seen.push(message); return { ok: true, value: false }; };
  assert.equal(await client.conversationQuarantineState("", "generic:https://x/y"), "unavailable");
  assert.equal(await client.conversationQuarantineState("generic", ""), "unavailable");
  assert.equal(await client.conversationIsQuarantined("", "generic:https://x/y"), true);
  assert.equal(await client.conversationIsQuarantined("generic", ""), true);
  client.quarantineConversation("", "generic:https://x/y");
  client.quarantineConversation("generic", "");
  client.clearConversationQuarantine("", "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [], "an incomplete target was sent to the authority");
});

test("a malformed authority answer does not read as a clear verdict", async () => {
  await reset();
  client.quarantineConversation("generic", "generic:https://x/y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const reply of [undefined, {}, { ok: false, error: "nope" }, { ok: true, value: "yes" }]) {
    deliver = async () => reply;
    assert.equal(
      await client.conversationQuarantineState("generic", "generic:https://x/y"),
      "unavailable",
      `a ${JSON.stringify(reply)} answer was read as a verdict`,
    );
    assert.equal(
      await client.conversationIsQuarantined("generic", "generic:https://x/y"),
      true,
      `a ${JSON.stringify(reply)} answer cleared the verdict`,
    );
  }
});

// Storage failure is the case the old reader turned into permission to send: it mapped a
// rejected `get` to an empty state and then answered "not quarantined" from it.
test("a storage area that throws is unavailable, never an empty verdict", async () => {
  await reset();
  const refusing = {
    get: async () => { throw new Error("storage unavailable"); },
    set: async () => { throw new Error("storage unavailable"); },
  };
  const workingSession = globalThis.chrome.storage.session;
  const workingLocal = globalThis.chrome.storage.local;
  // Every durable store refuses. A single broken store is the cascade's job, tested below.
  globalThis.chrome.storage.session = refusing;
  globalThis.chrome.storage.local = refusing;
  try {
    assert.equal(
      await authority.conversationQuarantineVerdict("generic", "generic:https://x/y"),
      "unavailable",
    );
    assert.equal(
      await authority.conversationIsQuarantined("generic", "generic:https://x/y"),
      true,
      "an unreadable authority answered that the conversation was safe to reuse",
    );
    // A write that cannot land must not throw into the caller, and must not claim success.
    assert.equal(await authority.quarantineConversation("generic", "generic:https://x/unstored"), false);
    assert.equal(await authority.clearConversationQuarantine("generic", "generic:https://x/unstored"), false);
    assert.equal(await authority.quarantinedIdentities("generic"), undefined);
    for (const type of ["BACHATA_QUARANTINE_SET", "BACHATA_QUARANTINE_CLEAR", "BACHATA_QUARANTINE_LIST"]) {
      assert.deepEqual(
        await authority.handleQuarantineMessage(
          { type, provider: "generic", conversationIdentity: "generic:https://x/y" },
          { id: runtimeId },
        ),
        { ok: false, error: authority.quarantineUnavailableError },
        `${type} acknowledged a verdict move that never landed`,
      );
    }
    // The write failed, but the verdict was still made: the worker holds it and answers with it.
    assert.equal(
      await authority.conversationQuarantineVerdict("generic", "generic:https://x/unstored"),
      "quarantined",
    );
    assert.deepEqual(
      await authority.handleQuarantineMessage(
        { type: "BACHATA_QUARANTINE_IS", provider: "generic", conversationIdentity: "generic:https://x/unstored" },
        { id: runtimeId },
      ),
      { ok: true, value: true },
    );
  } finally {
    globalThis.chrome.storage.session = workingSession;
    globalThis.chrome.storage.local = workingLocal;
  }
});

// The cascade: one broken store is not a lost verdict, because the other one is still durable.
test("a session store that refuses hands the verdict to the store that outlives the worker", async () => {
  await reset();
  const workingSession = globalThis.chrome.storage.session;
  globalThis.chrome.storage.session = {
    get: async () => { throw new Error("session storage unavailable"); },
    set: async () => { throw new Error("session storage unavailable"); },
  };
  try {
    assert.equal(
      await authority.quarantineConversation("generic-cascade", "generic:https://x/durable"),
      true,
      "a verdict that reached the emergency store was reported as unwritten",
    );
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-cascade", "generic:https://x/durable"),
      "quarantined",
    );
    assert.equal(localArea.size, 1, "the emergency store was not used");
    assert.equal(sessionArea.size, 0);
    // A second rescue for the same provider joins the first rather than replacing it.
    assert.equal(
      await authority.quarantineConversation("generic-cascade", "generic:https://x/durable-2"),
      true,
    );
    assert.deepEqual(
      (await authority.quarantinedIdentities("generic-cascade"))?.sort(),
      undefined,
      "a store that cannot answer was listed as complete",
    );
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-cascade", "generic:https://x/durable-2"),
      "quarantined",
    );
    // An identity nobody ruled on is still unknowable while a store cannot answer.
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-cascade", "generic:https://x/other"),
      "unavailable",
    );
  } finally {
    globalThis.chrome.storage.session = workingSession;
  }
  // With both stores readable again, the emergency copy is what still refuses the send.
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cascade", "generic:https://x/durable"),
    "quarantined",
  );
  assert.equal(
    await authority.clearConversationQuarantine("generic-cascade", "generic:https://x/durable"),
    true,
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cascade", "generic:https://x/durable"),
    "clear",
  );
  // Releasing the last rescued verdict empties the provider from the emergency store entirely.
  assert.equal(
    await authority.clearConversationQuarantine("generic-cascade", "generic:https://x/durable-2"),
    true,
  );
  assert.equal(
    localArea.get(emergencyStorageKey)["generic-cascade"],
    undefined,
    "an emptied provider was left behind in the emergency store",
  );
  assert.deepEqual(await authority.quarantinedIdentities("generic-cascade"), []);
});

test("a client cannot send while the authority is unavailable, cached or fresh", async () => {
  await reset();
  client.quarantineConversation("generic", "generic:https://x/cached");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const workingSession = globalThis.chrome.storage.session;
  globalThis.chrome.storage.session = {
    get: async () => { throw new Error("session storage unavailable"); },
    set: async () => { throw new Error("session storage unavailable"); },
  };
  try {
    for (const identity of ["generic:https://x/cached", "generic:https://x/never-seen"]) {
      assert.equal(await client.conversationQuarantineState("generic", identity), "unavailable");
      assert.equal(
        await client.conversationIsQuarantined("generic", identity),
        true,
        `${identity} was sendable while the authority could not answer`,
      );
    }
  } finally {
    globalThis.chrome.storage.session = workingSession;
  }
  // Recovery: the cached positive was never dropped, and the authority still holds it.
  assert.equal(
    await client.conversationQuarantineState("generic", "generic:https://x/cached"),
    "quarantined",
  );
  assert.equal(
    await client.conversationQuarantineState("generic", "generic:https://x/never-seen"),
    "clear",
  );
});

test("a malformed request is refused as invalid, not as an unavailable authority", async () => {
  await reset();
  for (const message of [
    { type: "BACHATA_QUARANTINE_IS", provider: "", conversationIdentity: "generic:https://x/y" },
    { type: "BACHATA_QUARANTINE_SET", provider: "generic", conversationIdentity: "" },
    { type: "BACHATA_QUARANTINE_CLEAR", provider: 7, conversationIdentity: "generic:https://x/y" },
    { type: "BACHATA_QUARANTINE_LIST", provider: "" },
  ]) {
    assert.deepEqual(
      await authority.handleQuarantineMessage(message, { id: runtimeId }),
      { ok: false, error: authority.quarantineInvalidTargetError },
      `${message.type} accepted an unnamed target`,
    );
  }
});

test("the authority lists the identities it is holding for one provider", async () => {
  await reset();
  await authority.quarantineConversation("generic-list", "generic:https://x/a");
  await authority.quarantineConversation("generic-list", "generic:https://x/b");
  await authority.quarantineConversation("chatgpt", "chatgpt:https://chatgpt.com/c/z");
  assert.deepEqual(
    (await authority.quarantinedIdentities("generic-list")).sort(),
    ["generic:https://x/a", "generic:https://x/b"],
  );
  assert.equal(
    await authority.quarantinedIdentities(""),
    undefined,
    "an invalid provider listed identities",
  );

  const listed = await authority.handleQuarantineMessage(
    { type: "BACHATA_QUARANTINE_LIST", provider: "chatgpt" },
    { id: runtimeId },
  );
  assert.deepEqual(listed, { ok: true, value: ["chatgpt:https://chatgpt.com/c/z"] });
});

test("a missing session storage area is unavailable, not an empty verdict", async () => {
  await reset();
  const workingStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = {};
  try {
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-list", "generic:https://x/missing-area"),
      "unavailable",
    );
    assert.equal(
      await authority.conversationIsQuarantined("generic-list", "generic:https://x/missing-area"),
      true,
    );
    assert.equal(
      await authority.quarantineConversation("generic-list", "generic:https://x/missing-area"),
      false,
    );
    assert.equal(await authority.quarantinedIdentities("generic-list"), undefined);
  } finally {
    globalThis.chrome.storage = workingStorage;
  }
});

// Every provider's records live under one storage key, so a verdict move is a whole-key
// read-modify-write. Without serialization two moves read the same state and the second write
// erases the first — the storage area below yields between get and set to force exactly that
// interleaving, which the old implementation lost and the queued one survives.
const yieldingSession = () => {
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    get: async (key) => {
      await settle();
      return sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {};
    },
    set: async (values) => {
      await settle();
      for (const [key, value] of Object.entries(values)) sessionArea.set(key, value);
    },
  };
};

// Failing "storage" means every durable store, not just the primary one: leaving the emergency
// store working would quietly rescue the very writes a test is trying to fail.
const withSession = async (area, run) => {
  const workingSession = globalThis.chrome.storage.session;
  const workingLocal = globalThis.chrome.storage.local;
  globalThis.chrome.storage.session = area;
  globalThis.chrome.storage.local = area;
  try {
    return await run();
  } finally {
    globalThis.chrome.storage.session = workingSession;
    globalThis.chrome.storage.local = workingLocal;
  }
};

test("concurrent verdict moves for one provider keep both", async () => {
  await reset();
  await withSession(yieldingSession(), async () => {
    await Promise.all([
      authority.quarantineConversation("generic-race-set", "generic:https://x/a"),
      authority.quarantineConversation("generic-race-set", "generic:https://x/b"),
    ]);
    assert.deepEqual(
      (await authority.quarantinedIdentities("generic-race-set")).sort(),
      ["generic:https://x/a", "generic:https://x/b"],
      "a concurrent verdict move erased the other one",
    );
  });
});

test("a concurrent set and clear leave the set standing", async () => {
  await reset();
  await authority.quarantineConversation("generic-race-clear", "generic:https://x/a");
  await withSession(yieldingSession(), async () => {
    await Promise.all([
      authority.quarantineConversation("generic-race-clear", "generic:https://x/b"),
      authority.clearConversationQuarantine("generic-race-clear", "generic:https://x/a"),
    ]);
    assert.deepEqual(
      await authority.quarantinedIdentities("generic-race-clear"),
      ["generic:https://x/b"],
      "a clear and a set raced and one of them was lost",
    );
  });
});

test("verdict moves for different providers cannot clobber one another", async () => {
  await reset();
  await withSession(yieldingSession(), async () => {
    await Promise.all([
      authority.quarantineConversation("chatgpt", "chatgpt:https://chatgpt.com/c/a"),
      authority.quarantineConversation("claude", "claude:https://claude.ai/chat/b"),
      authority.quarantineConversation("generic-race-clear", "generic:https://x/c"),
    ]);
    assert.deepEqual(await authority.quarantinedIdentities("chatgpt"), ["chatgpt:https://chatgpt.com/c/a"]);
    assert.deepEqual(await authority.quarantinedIdentities("claude"), ["claude:https://claude.ai/chat/b"]);
    assert.deepEqual(await authority.quarantinedIdentities("generic-race-clear"), ["generic:https://x/c"]);
  });
});

test("a read waits behind every verdict move accepted before it", async () => {
  await reset();
  await withSession(yieldingSession(), async () => {
    const moves = [
      authority.quarantineConversation("generic-race-read", "generic:https://x/a"),
      authority.quarantineConversation("generic-race-read", "generic:https://x/b"),
    ];
    // Queued after both moves without awaiting them: the read must still observe both.
    const verdict = await authority.conversationQuarantineVerdict("generic-race-read", "generic:https://x/a");
    const identities = await authority.quarantinedIdentities("generic-race-read");
    await Promise.all(moves);
    assert.equal(verdict, "quarantined");
    assert.deepEqual(identities.sort(), ["generic:https://x/a", "generic:https://x/b"]);
  });
});

test("one failed verdict move does not poison the moves behind it", async () => {
  await reset();
  let failNext = true;
  const flaky = {
    get: async (key) => {
      await Promise.resolve();
      if (failNext) {
        failNext = false;
        throw new Error("session storage unavailable");
      }
      return sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {};
    },
    set: async (values) => {
      await Promise.resolve();
      for (const [key, value] of Object.entries(values)) sessionArea.set(key, value);
    },
  };
  await withSession(flaky, async () => {
    const [failed, succeeded] = await Promise.all([
      authority.quarantineConversation("generic-race-fail", "generic:https://x/lost"),
      authority.quarantineConversation("generic-race-fail", "generic:https://x/kept"),
    ]);
    // The first move met a refusing read and went to the emergency store; the second ran normally
    // behind it. Neither was lost, and neither blocked the other.
    assert.equal(failed, true, "a move that reached the emergency store was reported as unwritten");
    assert.equal(succeeded, true, "a failed move blocked the move queued behind it");
    assert.deepEqual(
      (await authority.quarantinedIdentities("generic-race-fail")).sort(),
      ["generic:https://x/kept", "generic:https://x/lost"],
    );
    // Both verdicts are durable: the second in the primary store, the first in the emergency one.
    // A later move that reads both stores may copy the rescued verdict forward, which is
    // redundancy rather than conflict — a clear removes it from every store it lives in.
    assert.equal(
      sessionArea.get(storageKey)["generic-race-fail"].some(
        (record) => record.identity === "generic:https://x/kept",
      ),
      true,
    );
    assert.equal(
      sessionArea.get(emergencyStorageKey)["generic-race-fail"].map((record) => record.identity).join(),
      "generic:https://x/lost",
    );
  });
});

// A readable area whose writes reject is the case the old writer swallowed: it acknowledged a
// verdict move that never landed, and the client kept its cached positive on that acknowledgement.
test("a write that cannot land is never acknowledged as a verdict move", async () => {
  await reset();
  const rejectingWrites = {
    get: async (key) => (sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
    set: async () => { throw new Error("session storage is full"); },
  };
  await withSession(rejectingWrites, async () => {
    assert.equal(await authority.quarantineConversation("generic-unwritable", "generic:https://x/unwritten"), false);
    assert.deepEqual(
      await authority.handleQuarantineMessage(
        { type: "BACHATA_QUARANTINE_SET", provider: "generic-unwritable", conversationIdentity: "generic:https://x/unwritten" },
        { id: runtimeId },
      ),
      { ok: false, error: authority.quarantineUnavailableError },
    );
    assert.deepEqual(
      await authority.handleQuarantineMessage(
        { type: "BACHATA_QUARANTINE_CLEAR", provider: "generic-unwritable", conversationIdentity: "generic:https://x/unwritten" },
        { id: runtimeId },
      ),
      { ok: false, error: authority.quarantineUnavailableError },
    );
    // Reads still work, and the refused write is still an authority verdict: it is held in the
    // worker rather than answered away as clear.
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-unwritable", "generic:https://x/unwritten"),
      "quarantined",
    );
  });
  assert.equal(sessionArea.has(storageKey), false, "a refused write reached storage anyway");
  assert.deepEqual(await authority.quarantinedIdentities("generic-unwritable"), ["generic:https://x/unwritten"]);
});

// The sequence the first fail-closed pass still let through: the SET never landed, so the
// authority honestly answers false, and the client used to read that as a release.
test("a verdict whose write never landed is not released by the authority's honest false", async () => {
  await reset();
  deliver = async (message) => (
    message.type === "BACHATA_QUARANTINE_SET"
      ? { ok: false, error: authority.quarantineUnavailableError }
      : { ok: true, value: false }
  );
  client.quarantineConversation("generic-unwritable", "generic:https://x/unwritten");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    await client.conversationQuarantineState("generic-unwritable", "generic:https://x/unwritten"),
    "quarantined",
    "a failed write was released by a confirmed clear the authority could only give because the write failed",
  );
  // Repeatedly, not once: the local positive is sticky until a clear actually lands.
  assert.equal(await client.conversationIsQuarantined("generic-unwritable", "generic:https://x/unwritten"), true);

  // A clear that also fails changes nothing.
  deliver = async () => ({ ok: false, error: authority.quarantineUnavailableError });
  client.clearConversationQuarantine("generic-unwritable", "generic:https://x/unwritten");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await client.conversationIsQuarantined("generic-unwritable", "generic:https://x/unwritten"), true);

  // Only an acknowledged clear releases it.
  deliver = async (message) => (
    message.type === "BACHATA_QUARANTINE_CLEAR" ? { ok: true } : { ok: true, value: false }
  );
  client.clearConversationQuarantine("generic-unwritable", "generic:https://x/unwritten");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    await client.conversationQuarantineState("generic-unwritable", "generic:https://x/unwritten"),
    "clear",
  );
});

test("an acknowledged write stops being sticky, so a real clear still releases it", async () => {
  await reset();
  client.quarantineConversation("generic-unwritable", "generic:https://x/written");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await client.conversationQuarantineState("generic-unwritable", "generic:https://x/written"), "quarantined");
  client.clearConversationQuarantine("generic-unwritable", "generic:https://x/written");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await client.conversationQuarantineState("generic-unwritable", "generic:https://x/written"), "clear");
});

// The hole the first fix left: stickiness lived in the content script's own memory, so a reload
// discarded it and the authority's honest "clear" let the send through.
test("a verdict whose write failed survives the page realm that made it", async () => {
  await reset();
  const rejectingWrites = {
    get: async (key) => (sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
    set: async () => { throw new Error("session storage is full"); },
  };
  await withSession(rejectingWrites, async () => {
    client.quarantineConversation("generic-unwritable", "generic:https://x/reloaded");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      await client.conversationQuarantineState("generic-unwritable", "generic:https://x/reloaded"),
      "quarantined",
    );

    // The reload: the document's realm dies and every content-side cache dies with it. The
    // authority is the only thing left that can still refuse.
    client.resetConversationQuarantineCache();
    assert.equal(
      await client.conversationQuarantineState("generic-unwritable", "generic:https://x/reloaded"),
      "quarantined",
      "a page reload turned an unpersisted verdict into permission to send",
    );
    assert.equal(await client.conversationIsQuarantined("generic-unwritable", "generic:https://x/reloaded"), true);
  });

  // Storage recovers; the verdict is still refused, and a landed clear is what releases it.
  assert.equal(
    await client.conversationQuarantineState("generic-unwritable", "generic:https://x/reloaded"),
    "quarantined",
  );
  client.clearConversationQuarantine("generic-unwritable", "generic:https://x/reloaded");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    await client.conversationQuarantineState("generic-unwritable", "generic:https://x/reloaded"),
    "clear",
  );
});

test("a verdict held without storage still expires on its own window", async () => {
  await reset();
  const now = Date.now();
  await withSession(
    { get: async () => ({}), set: async () => { throw new Error("no"); } },
    async () => {
      await authority.quarantineConversation("generic-unwritable", "generic:https://x/aging", now);
    },
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-unwritable", "generic:https://x/aging", now + 1_000),
    "quarantined",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict(
      "generic-unwritable",
      "generic:https://x/aging",
      now + authority.quarantineLifetimeMs + 1,
    ),
    "clear",
  );
});

// Over-limit state used to be trimmed on read, which silently answered "clear" for whichever
// verdict fell off the front.
test("a stored state larger than this worker can write is unavailable, not trimmed", async () => {
  await reset();
  const expiresAt = Date.now() + 60_000;
  sessionArea.set(storageKey, {
    "generic-oversize": Array.from({ length: 17 }, (_, index) => ({
      identity: `generic:https://x/${index}`,
      expiresAt,
    })),
  });
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-oversize", "generic:https://x/0"),
    "unavailable",
    "the discarded identity was answered as clear",
  );
  assert.equal(await authority.quarantinedIdentities("generic-oversize"), undefined);

  await reset();
  sessionArea.set(storageKey, Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `provider-${index}`,
      [{ identity: "generic:https://x/y", expiresAt }],
    ]),
  ));
  assert.equal(
    await authority.conversationQuarantineVerdict("provider-0", "generic:https://x/y"),
    "unavailable",
  );
});

test("a verdict that does not fit is refused, never swapped for one still in force", async () => {
  await reset();
  for (let index = 0; index < 16; index += 1) {
    assert.equal(
      await authority.quarantineConversation("generic-overflow", `generic:https://x/${index}`),
      true,
    );
  }
  // The primary store cannot hold a seventeenth, and the answer is not to evict a live verdict:
  // it goes to the emergency store, which keeps its own capacity.
  assert.equal(
    await authority.quarantineConversation("generic-overflow", "generic:https://x/overflow"),
    true,
  );
  assert.equal(
    sessionArea.get(storageKey)["generic-overflow"].some(
      (record) => record.identity === "generic:https://x/overflow",
    ),
    false,
    "a seventeenth verdict was written by evicting one that is still in force",
  );
  // The oldest verdict is intact, and the overflowing one is held rather than dropped.
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-overflow", "generic:https://x/0"),
    "quarantined",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-overflow", "generic:https://x/overflow"),
    "quarantined",
  );
  assert.equal(sessionArea.get(storageKey)["generic-overflow"].length, 16);
});

// The last-resort hold is still an answer once a store can talk again: a verdict made while every
// store refused must appear in what the authority reports afterwards, not vanish on recovery.
test("a verdict held only in memory is still listed once storage recovers", async () => {
  await reset();
  const refusing = {
    get: async () => { throw new Error("storage unavailable"); },
    set: async () => { throw new Error("storage unavailable"); },
  };
  await withSession(refusing, async () => {
    assert.equal(
      await authority.quarantineConversation("generic-memory", "generic:https://x/only-memory"),
      false,
    );
  });
  assert.deepEqual(
    await authority.quarantinedIdentities("generic-memory"),
    ["generic:https://x/only-memory"],
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-memory", "generic:https://x/only-memory"),
    "quarantined",
  );
});

// Two stores holding verdicts for one provider is agreement, not conflict: the union is what the
// authority answers with, and a repeated identity keeps the later expiry.
test("verdicts in both stores are merged rather than shadowed", async () => {
  await reset();
  const now = Date.now();
  sessionArea.set(storageKey, {
    "generic-merge": [
      { identity: "generic:https://x/primary", expiresAt: now + 60_000 },
      { identity: "generic:https://x/both", expiresAt: now + 10_000 },
    ],
  });
  localArea.set(emergencyStorageKey, {
    "generic-merge": [
      { identity: "generic:https://x/emergency", expiresAt: now + 60_000 },
      { identity: "generic:https://x/both", expiresAt: now + 90_000 },
    ],
  });
  assert.deepEqual(
    (await authority.quarantinedIdentities("generic-merge", now)).sort(),
    ["generic:https://x/both", "generic:https://x/emergency", "generic:https://x/primary"],
  );
  // The shorter window would have expired by now; the longer one is what holds.
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-merge", "generic:https://x/both", now + 20_000),
    "quarantined",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-merge", "generic:https://x/both", now + 120_000),
    "clear",
  );
});

// A verdict is a conversation identity. Keeping one past its window is keeping a record of where
// someone was talking, for no purpose the extension has — so expiry has to remove it from the
// store, not merely filter it out of an answer.
test("expired identities are removed from both stores, not just from the answer", async () => {
  await reset();
  const now = Date.now();
  sessionArea.set(storageKey, {
    "generic-expiry": [
      { identity: "generic:https://x/gone", expiresAt: now - 1 },
      { identity: "generic:https://x/live", expiresAt: now + 60_000 },
    ],
  });
  localArea.set(emergencyStorageKey, {
    "generic-expiry": [{ identity: "generic:https://x/also-gone", expiresAt: now - 1 }],
  });

  assert.equal(
    await authority.conversationQuarantineVerdict("generic-expiry", "generic:https://x/live", now),
    "quarantined",
  );

  assert.deepEqual(
    sessionArea.get(storageKey)["generic-expiry"].map((record) => record.identity),
    ["generic:https://x/live"],
    "an expired identity was left in the session store",
  );
  assert.equal(
    localArea.get(emergencyStorageKey)["generic-expiry"],
    undefined,
    "an expired identity was left in the emergency store, which outlives the session",
  );
});

test("an expired overflow marker stops standing, and stops being stored", async () => {
  await reset();
  const now = Date.now();
  localArea.set(overflowKey, { providers: { "generic-stale-overflow": now - 1 } });
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-stale-overflow", "generic:https://x/any", now),
    "clear",
  );
  assert.deepEqual(
    localArea.get(overflowKey),
    { providers: {} },
    "an expired overflow marker was left in the store",
  );
});

// Every store full. The verdict cannot be recorded as an identity, so it is recorded as the fact
// that one exists: unknown identities of that provider stop being answerable.
test("a verdict past every store's capacity becomes a durable overflow marker", async () => {
  await reset();
  for (let index = 0; index < 32; index += 1) {
    assert.equal(
      await authority.quarantineConversation("generic-cap", `generic:https://x/${index}`),
      true,
      `verdict ${index} was not stored`,
    );
  }
  assert.equal(
    await authority.quarantineConversation("generic-cap", "generic:https://x/overflow"),
    false,
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cap", "generic:https://x/overflow"),
    "unavailable",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cap", "generic:https://x/unknown"),
    "unavailable",
    "an unknown identity was called clear while a verdict of that provider went unrecorded",
  );
  assert.equal(await authority.quarantinedIdentities("generic-cap"), undefined);
  // A recorded identity is still exactly quarantined, and other providers are untouched.
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cap", "generic:https://x/0"),
    "quarantined",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cap-other", "generic:https://x/0"),
    "clear",
  );

  // Clearing one recorded identity does not retract the overflow: the unrecorded verdict is still
  // out there until its window closes. So the clear cannot be acknowledged either — a success here
  // would be contradicted by the very next read.
  assert.equal(
    await authority.clearConversationQuarantine("generic-cap", "generic:https://x/0"),
    false,
    "a clear was acknowledged while a marker still refuses that provider",
  );
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-cap", "generic:https://x/0"),
    "unavailable",
  );
  const marker = sessionArea.get(overflowKey) ?? localArea.get(overflowKey);
  assert.equal(
    typeof marker.providers["generic-cap"],
    "number",
    "the overflow marker was dropped by a clear",
  );
});

// The overflow key is parsed as strictly as the identity map: anything this worker did not write
// is a state it cannot read, and reading it as "no marker" would answer clear for a provider whose
// verdict went unrecorded.
test("a malformed overflow marker is unavailable, not an absent marker", async () => {
  for (const corrupt of [
    [],
    7,
    { providers: [] },
    { providers: {}, allUntil: "soon" },
    { providers: { "generic-bad": "soon" } },
    { providers: { "": 1 } },
    { providers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, Date.now() + 60_000])) },
  ]) {
    await reset();
    sessionArea.set(overflowKey, corrupt);
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-bad", "generic:https://x/y"),
      "unavailable",
      `${JSON.stringify(corrupt)} was read as an absent marker`,
    );
  }
});

test("an expired hold and an expired overflow entry are both dropped rather than answered", async () => {
  await reset();
  const now = Date.now();
  const refusing = {
    get: async () => ({}),
    set: async () => { throw new Error("storage unavailable"); },
  };
  await withSession(refusing, async () => {
    await authority.quarantineConversation("generic-aged", "generic:https://x/aged", now);
  });
  // Past its window, the held verdict stops answering and stops being held.
  assert.equal(
    await authority.conversationQuarantineVerdict(
      "generic-aged",
      "generic:https://x/aged",
      now + authority.quarantineLifetimeMs + 1,
    ),
    "clear",
  );
  assert.deepEqual(
    await authority.quarantinedIdentities("generic-aged", now + authority.quarantineLifetimeMs + 1),
    [],
  );

  sessionArea.set(overflowKey, { providers: { "generic-aged": now - 1 }, allUntil: now - 1 });
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-aged", "generic:https://x/other", now),
    "clear",
  );
  assert.deepEqual(sessionArea.get(overflowKey), { providers: {} });
});

test("a clear that one store refuses is not acknowledged, and the verdict stands", async () => {
  await reset();
  assert.equal(
    await authority.quarantineConversation("generic-halfclear", "generic:https://x/held"),
    true,
  );
  const workingSession = globalThis.chrome.storage.session;
  globalThis.chrome.storage.session = {
    get: async (key) => (sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  try {
    assert.equal(
      await authority.clearConversationQuarantine("generic-halfclear", "generic:https://x/held"),
      false,
      "a clear the store refused was acknowledged",
    );
  } finally {
    globalThis.chrome.storage.session = workingSession;
  }
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-halfclear", "generic:https://x/held"),
    "quarantined",
  );
});

test("a compaction that cannot land keeps the read incomplete", async () => {
  await reset();
  const now = Date.now();
  sessionArea.set(storageKey, {
    "generic-nocompact": [{ identity: "generic:https://x/old", expiresAt: now - 1 }],
  });
  const workingSession = globalThis.chrome.storage.session;
  globalThis.chrome.storage.session = {
    get: async (key) => (sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  try {
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-nocompact", "generic:https://x/any", now),
      "unavailable",
    );
  } finally {
    globalThis.chrome.storage.session = workingSession;
  }
});

test("an expired overflow marker that cannot be compacted keeps the read incomplete", async () => {
  await reset();
  const now = Date.now();
  sessionArea.set(overflowKey, { providers: { "generic-staleoverflow": now - 1 } });
  const workingSession = globalThis.chrome.storage.session;
  globalThis.chrome.storage.session = {
    get: async (key) => (sessionArea.has(key) ? { [key]: sessionArea.get(key) } : {}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  try {
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-staleoverflow", "generic:https://x/any", now),
      "unavailable",
      "a marker the store could not drop was answered around",
    );
  } finally {
    globalThis.chrome.storage.session = workingSession;
  }
});

test("a held verdict answers while it is in force and stops when it expires", async () => {
  await reset();
  const now = Date.now();
  const refusing = {
    get: async () => ({}),
    set: async () => { throw new Error("storage unavailable"); },
  };
  await withSession(refusing, async () => {
    await authority.quarantineConversation("generic-held-window", "generic:https://x/held", now);
    // In force: answered from the hold, without any store being able to confirm it.
    assert.equal(
      await authority.conversationQuarantineVerdict(
        "generic-held-window",
        "generic:https://x/held",
        now + 1_000,
      ),
      "quarantined",
    );
    // Past its window: the hold is dropped, and with no readable store the answer is unavailable
    // rather than clear.
    assert.equal(
      await authority.conversationQuarantineVerdict(
        "generic-held-window",
        "generic:https://x/held",
        now + authority.quarantineLifetimeMs + 1,
      ),
      "unavailable",
    );
  });
});

// `{}` is not "no markers": it is a shape this worker never writes, and reading it as empty would
// answer clear from a state it cannot account for.
test("an overflow value that is not the exact written shape is unavailable", async () => {
  for (const corrupt of [
    {},
    { allUntil: Date.now() + 60_000 },
    { providers: {}, extra: 1 },
    { providers: {}, allUntil: Date.now() + 60_000, extra: true },
  ]) {
    await reset();
    sessionArea.set(overflowKey, corrupt);
    assert.equal(
      await authority.conversationQuarantineVerdict("generic-shape", "generic:https://x/y"),
      "unavailable",
      `${JSON.stringify(corrupt)} was read as an absent marker`,
    );
  }
  // The exact written shape stays readable, both with and without a global marker.
  await reset();
  sessionArea.set(overflowKey, { providers: {} });
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-shape", "generic:https://x/y"),
    "clear",
  );
  sessionArea.set(overflowKey, { providers: {}, allUntil: Date.now() + 60_000 });
  assert.equal(
    await authority.conversationQuarantineVerdict("generic-shape", "generic:https://x/y"),
    "unavailable",
  );
});
