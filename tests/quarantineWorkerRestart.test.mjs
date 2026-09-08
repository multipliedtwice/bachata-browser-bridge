import assert from "node:assert/strict";
import test from "node:test";

// A verdict has to outlive the worker that made it. Session storage is the normal home; when it
// refuses, the verdict goes to a store that survives a worker restart, and only when every durable
// store refuses does it fall back to worker memory — where losing it still cannot read as "clear",
// because a total storage failure answers unavailable.
//
// This lives apart from the rest of the quarantine suite because it loads the module more than
// once, and two instances of one path split that file's coverage attribution.

const sessionStore = new Map();
const localStore = new Map();
const workingArea = (store) => ({
  get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
  set: async (values) => {
    for (const [key, value] of Object.entries(values)) store.set(key, value);
  },
});
const refusingArea = {
  get: async () => { throw new Error("storage unavailable"); },
  set: async () => { throw new Error("storage unavailable"); },
};

globalThis.chrome = {
  runtime: { id: "bachata-bridge-test" },
  storage: { session: refusingArea, local: workingArea(localStore) },
};

let generation = 0;
const restartWorker = async () => {
  generation += 1;
  return await import(`../dist/background/quarantine.js?restart=${generation}`);
};

test("a verdict the session store refused survives a worker restart", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = refusingArea;
  globalThis.chrome.storage.local = workingArea(localStore);

  const before = await restartWorker();
  assert.equal(
    await before.quarantineConversation("generic-restart", "generic:https://x/held"),
    true,
    "a verdict that reached the durable emergency store was reported as unwritten",
  );
  assert.equal(
    await before.conversationQuarantineVerdict("generic-restart", "generic:https://x/held"),
    "quarantined",
  );

  // The restart: a new module instance, remembering nothing of its own.
  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("generic-restart", "generic:https://x/held"),
    "quarantined",
    "a worker restart turned a refusal into permission to send",
  );

  // And the session store coming back does not resurrect a send either.
  globalThis.chrome.storage.session = workingArea(sessionStore);
  const recovered = await restartWorker();
  assert.equal(
    await recovered.conversationQuarantineVerdict("generic-restart", "generic:https://x/held"),
    "quarantined",
  );

  // Only a clear that lands in every store releases it.
  assert.equal(
    await recovered.clearConversationQuarantine("generic-restart", "generic:https://x/held"),
    true,
  );
  const afterClear = await restartWorker();
  assert.equal(
    await afterClear.conversationQuarantineVerdict("generic-restart", "generic:https://x/held"),
    "clear",
  );
});

test("a clear that cannot reach the emergency store is not acknowledged", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = refusingArea;
  globalThis.chrome.storage.local = workingArea(localStore);
  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("generic-restart", "generic:https://x/stuck"),
    true,
  );

  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = refusingArea;
  assert.equal(
    await worker.clearConversationQuarantine("generic-restart", "generic:https://x/stuck"),
    false,
    "a clear was acknowledged while a store that may still hold the verdict was unreachable",
  );
});

test("when every durable store refuses, a restart reads unavailable rather than clear", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = refusingArea;
  globalThis.chrome.storage.local = refusingArea;

  const before = await restartWorker();
  assert.equal(
    await before.quarantineConversation("generic-restart", "generic:https://x/memory"),
    false,
    "a verdict no store accepted was reported as written",
  );
  assert.equal(
    await before.conversationQuarantineVerdict("generic-restart", "generic:https://x/memory"),
    "quarantined",
  );

  // The residual, and the reason it is not a hole: the restart forgets the in-memory hold, but a
  // worker that cannot read any store cannot answer "clear" either.
  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("generic-restart", "generic:https://x/memory"),
    "unavailable",
  );
  assert.equal(
    await after.conversationIsQuarantined("generic-restart", "generic:https://x/memory"),
    true,
    "a total storage failure plus a worker restart became permission to send",
  );
});

// Reads work, writes do not. Nothing durable records the verdict, so a restarted worker sees two
// empty stores — which is indistinguishable from "no verdict was ever made" unless it checks
// whether it can write at all.
test("a store that reads fine and refuses writes cannot answer clear after a restart", async () => {
  sessionStore.clear();
  localStore.clear();
  const writeOnlyFailure = {
    get: async () => ({}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  globalThis.chrome.storage.session = writeOnlyFailure;
  globalThis.chrome.storage.local = writeOnlyFailure;

  const before = await restartWorker();
  assert.equal(
    await before.quarantineConversation("generic-writeonly", "generic:https://x/held"),
    false,
    "a verdict no store accepted was reported as written",
  );
  assert.equal(
    await before.conversationQuarantineVerdict("generic-writeonly", "generic:https://x/held"),
    "quarantined",
  );

  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("generic-writeonly", "generic:https://x/held"),
    "unavailable",
    "two empty reads from stores that cannot be written were read as permission to send",
  );
  assert.equal(
    await after.conversationIsQuarantined("generic-writeonly", "generic:https://x/held"),
    true,
  );

  // And once writing works again, an untouched identity is clear on its own evidence.
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);
  const recovered = await restartWorker();
  assert.equal(
    await recovered.conversationQuarantineVerdict("generic-writeonly", "generic:https://x/other"),
    "clear",
  );
});

// Both stores full. The verdict cannot be recorded as an identity anywhere, so it is recorded as
// the fact that one exists: every unknown identity of that provider reads unavailable.
test("a verdict past every store's capacity is recorded as an overflow that survives a restart", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);

  const worker = await restartWorker();
  for (let index = 0; index < 32; index += 1) {
    assert.equal(
      await worker.quarantineConversation("generic-full", `generic:https://x/${index}`),
      true,
      `verdict ${index} was not stored`,
    );
  }
  assert.equal(
    await worker.quarantineConversation("generic-full", "generic:https://x/overflow"),
    false,
    "a thirty-third verdict claimed a home that does not exist",
  );

  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("generic-full", "generic:https://x/overflow"),
    "unavailable",
    "a verdict that overflowed every store came back as permission to send",
  );
  // Everything actually recorded is still exactly quarantined, and other providers are unaffected.
  assert.equal(
    await after.conversationQuarantineVerdict("generic-full", "generic:https://x/0"),
    "quarantined",
  );
  assert.equal(
    await after.conversationQuarantineVerdict("generic-other", "generic:https://x/overflow"),
    "clear",
  );
  assert.equal(await after.quarantinedIdentities("generic-full"), undefined);
});

// Clearing one identity out of a 32-record union used to write the whole union into one store,
// overflowing that store's own format and leaving it permanently unreadable.
test("clearing from a union that spans both stores keeps each store within its own format", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);

  const worker = await restartWorker();
  for (let index = 0; index < 32; index += 1) {
    await worker.quarantineConversation("generic-union", `generic:https://x/${index}`);
  }
  assert.equal(
    await worker.clearConversationQuarantine("generic-union", "generic:https://x/0"),
    true,
  );

  const primary = sessionStore.get("bachataConversationQuarantine.v1")["generic-union"];
  const emergency = localStore.get("bachataConversationQuarantineEmergency.v1")["generic-union"];
  assert.equal(primary.length <= 16, true, `primary store holds ${primary.length} records`);
  assert.equal(emergency.length <= 16, true, `emergency store holds ${emergency.length} records`);
  assert.equal(primary.length + emergency.length, 31);

  // The store stayed readable, so the remaining verdicts are still verdicts and further clears work.
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-union", "generic:https://x/1"),
    "quarantined",
  );
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-union", "generic:https://x/0"),
    "clear",
  );
  assert.equal(
    await worker.clearConversationQuarantine("generic-union", "generic:https://x/1"),
    true,
  );
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-union", "generic:https://x/1"),
    "clear",
  );
});

// An extension upgrade replaces the worker's code, not its storage. A verdict the shipped version
// wrote must still be a verdict afterwards, so the identity map keeps the key and shape it shipped
// with rather than starting a new one.
test("a verdict written by the shipped version survives an upgrade", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);

  // Exactly what 330049e writes: one key, provider to records.
  sessionStore.set("bachataConversationQuarantine.v1", {
    "generic-upgrade": [
      { identity: "generic:https://x/from-v1", expiresAt: Date.now() + 60_000 },
    ],
  });

  const upgraded = await restartWorker();
  assert.equal(
    await upgraded.conversationQuarantineVerdict("generic-upgrade", "generic:https://x/from-v1"),
    "quarantined",
    "an upgrade read the previous version's storage as empty",
  );
  assert.deepEqual(
    await upgraded.quarantinedIdentities("generic-upgrade"),
    ["generic:https://x/from-v1"],
  );
});

// Overflow marking must not need the very capacity that is exhausted.
test("an overflow marker is recorded even when every provider slot is taken", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);
  const expiresAt = Date.now() + 60_000;
  const full = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `provider-${index}`,
      Array.from({ length: 16 }, (_, slot) => ({
        identity: `generic:https://x/${index}-${slot}`,
        expiresAt,
      })),
    ]),
  );
  sessionStore.set("bachataConversationQuarantine.v1", full);
  localStore.set("bachataConversationQuarantineEmergency.v1", full);

  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("provider-33", "generic:https://x/homeless"),
    false,
  );

  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("provider-33", "generic:https://x/homeless"),
    "unavailable",
    "a verdict for a provider with no slot left came back as permission to send",
  );
  // Scoped to the provider whose verdict went unrecorded: other providers still answer normally.
  assert.equal(
    await after.conversationQuarantineVerdict("provider-0", "generic:https://x/anything"),
    "clear",
  );
});

// And when even the marker map is full, the marker becomes global rather than being dropped.
test("an overflow marker that cannot name its provider refuses every provider", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);
  const expiresAt = Date.now() + 60_000;
  const fullRecords = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `provider-${index}`,
      Array.from({ length: 16 }, (_, slot) => ({
        identity: `generic:https://x/${index}-${slot}`,
        expiresAt,
      })),
    ]),
  );
  const fullMarkers = {
    providers: Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`marked-${index}`, expiresAt]),
    ),
  };
  for (const [store, recordsKey] of [
    [sessionStore, "bachataConversationQuarantine.v1"],
    [localStore, "bachataConversationQuarantineEmergency.v1"],
  ]) {
    store.set(recordsKey, fullRecords);
    store.set("bachataConversationQuarantineOverflow.v1", fullMarkers);
  }

  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("provider-99", "generic:https://x/nameless"),
    false,
  );

  const after = await restartWorker();
  for (const [provider, identity] of [
    ["provider-99", "generic:https://x/nameless"],
    ["provider-0", "generic:https://x/anything"],
    ["never-seen", "generic:https://x/anything"],
  ]) {
    assert.equal(
      await after.conversationQuarantineVerdict(provider, identity),
      "unavailable",
      `${provider} answered while a verdict nobody can name is outstanding`,
    );
  }
});

// A store whose expired records cannot be compacted has just given a read it could not clean up.
test("a compaction that cannot land makes the read unavailable, and removal happens on recovery", async () => {
  sessionStore.clear();
  localStore.clear();
  const expired = { "generic-compaction": [{ identity: "generic:https://x/old", expiresAt: Date.now() - 1 }] };
  localStore.set("bachataConversationQuarantineEmergency.v1", expired);
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = {
    get: async (key) => (localStore.has(key) ? { [key]: localStore.get(key) } : {}),
    set: async () => { throw new Error("quota exceeded"); },
  };

  const worker = await restartWorker();
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-compaction", "generic:https://x/any"),
    "unavailable",
    "a store that could not drop an expired identity still answered clear",
  );
  assert.deepEqual(
    localStore.get("bachataConversationQuarantineEmergency.v1"),
    expired,
    "precondition: the expired identity is still physically stored",
  );

  // Storage recovers: the promise is eventual removal, and this is where it is kept.
  globalThis.chrome.storage.local = workingArea(localStore);
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-compaction", "generic:https://x/any"),
    "clear",
  );
  assert.deepEqual(
    localStore.get("bachataConversationQuarantineEmergency.v1"),
    {},
    "the expired identity was not removed once storage accepted writes again",
  );
});

// A verdict with no durable home when it was made gets one as soon as a store accepts writes, so
// the window where it lives only in this worker is as short as storage allows.
test("a verdict held in memory is flushed to storage the moment writing works again", async () => {
  sessionStore.clear();
  localStore.clear();
  const refusing = {
    get: async () => ({}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  globalThis.chrome.storage.session = refusing;
  globalThis.chrome.storage.local = refusing;

  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("generic-flush", "generic:https://x/held"),
    false,
  );

  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-flush", "generic:https://x/held"),
    "quarantined",
  );

  // Durable now, so a restart keeps refusing it.
  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("generic-flush", "generic:https://x/held"),
    "quarantined",
    "a held verdict was never written down once storage recovered",
  );
});

// A held verdict must reach durability by whatever route is open when storage returns, including
// the marker route. Recording was the only one the flush used to try, so stores that came back
// full left the verdict in memory and a restart lost it.
test("a held verdict is marked when the recovered stores are full", async () => {
  sessionStore.clear();
  localStore.clear();
  const refusing = {
    get: async () => ({}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  globalThis.chrome.storage.session = refusing;
  globalThis.chrome.storage.local = refusing;

  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("generic-flushfull", "generic:https://x/held"),
    false,
  );

  // Storage returns, but there is no room to name the identity.
  const expiresAt = Date.now() + 60_000;
  const full = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `provider-${index}`,
      Array.from({ length: 16 }, (_, slot) => ({
        identity: `generic:https://x/${index}-${slot}`,
        expiresAt,
      })),
    ]),
  );
  sessionStore.set("bachataConversationQuarantine.v1", full);
  localStore.set("bachataConversationQuarantineEmergency.v1", full);
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);

  // The identity could not be named, so it became a nameless marker: still refused, no longer
  // reported as a verdict about this exact conversation.
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-flushfull", "generic:https://x/held"),
    "unavailable",
  );
  assert.equal(
    await worker.conversationIsQuarantined("generic-flushfull", "generic:https://x/held"),
    true,
  );
  const after = await restartWorker();
  assert.equal(
    await after.conversationQuarantineVerdict("generic-flushfull", "generic:https://x/held"),
    "unavailable",
    "a held verdict was lost because the recovered stores had no room to name it",
  );
});

// Any read of the stores is a chance to notice storage came back, not only a verdict read.
for (const [name, act] of [
  ["a list", async (worker) => await worker.quarantinedIdentities("generic-other")],
  ["an unrelated verdict", async (worker) => await worker.quarantineConversation("generic-other", "generic:https://x/unrelated")],
  ["an unrelated clear", async (worker) => await worker.clearConversationQuarantine("generic-other", "generic:https://x/unrelated")],
]) {
  test(`${name} flushes a held verdict once storage recovers`, async () => {
    sessionStore.clear();
    localStore.clear();
    const refusing = {
      get: async () => ({}),
      set: async () => { throw new Error("quota exceeded"); },
    };
    globalThis.chrome.storage.session = refusing;
    globalThis.chrome.storage.local = refusing;

    const worker = await restartWorker();
    assert.equal(
      await worker.quarantineConversation("generic-held", "generic:https://x/held"),
      false,
    );

    globalThis.chrome.storage.session = workingArea(sessionStore);
    globalThis.chrome.storage.local = workingArea(localStore);
    await act(worker);

    const after = await restartWorker();
    assert.equal(
      await after.conversationQuarantineVerdict("generic-held", "generic:https://x/held"),
      "quarantined",
      `${name} read recovered storage without writing the held verdict down`,
    );
  });
}

// The clear path used to flush its own target: with the recovered stores full, the verdict being
// retracted became a nameless marker, and the clear then reported success over a conversation the
// next read still refused. The target is excluded from the flush now, so a clear either retracts
// the thing it names or is not acknowledged — the two answers can no longer disagree.
test("clearing a held verdict retracts exactly that verdict, and says so consistently", async () => {
  sessionStore.clear();
  localStore.clear();
  const refusing = {
    get: async () => ({}),
    set: async () => { throw new Error("quota exceeded"); },
  };
  globalThis.chrome.storage.session = refusing;
  globalThis.chrome.storage.local = refusing;

  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("generic-clearheld", "generic:https://x/held"),
    false,
  );

  // Storage returns with no room to name anything.
  const expiresAt = Date.now() + 60_000;
  const full = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `provider-${index}`,
      Array.from({ length: 16 }, (_, slot) => ({
        identity: `generic:https://x/${index}-${slot}`,
        expiresAt,
      })),
    ]),
  );
  sessionStore.set("bachataConversationQuarantine.v1", full);
  localStore.set("bachataConversationQuarantineEmergency.v1", full);
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);

  assert.equal(
    await worker.clearConversationQuarantine("generic-clearheld", "generic:https://x/held"),
    true,
  );
  // The retraction and the verdict agree. Previously the clear said yes while the read said
  // unavailable, because the flush had turned this very verdict into a nameless marker first.
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-clearheld", "generic:https://x/held"),
    "clear",
  );
  assert.deepEqual(
    localStore.get("bachataConversationQuarantineOverflow.v1"),
    undefined,
    "the verdict being retracted was turned into a marker on the way out",
  );
  assert.deepEqual(
    sessionStore.get("bachataConversationQuarantineOverflow.v1"),
    undefined,
  );
});

// A marker raised by some *other* unrecorded verdict is different: it stands over the whole
// provider, so this identity cannot be proven to be the one retracted.
test("a clear is refused while a marker from another verdict still stands", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);
  const expiresAt = Date.now() + 60_000;
  const full = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `provider-${index}`,
      Array.from({ length: 16 }, (_, slot) => ({
        identity: `generic:https://x/${index}-${slot}`,
        expiresAt,
      })),
    ]),
  );
  sessionStore.set("bachataConversationQuarantine.v1", full);
  localStore.set("bachataConversationQuarantineEmergency.v1", full);

  const worker = await restartWorker();
  // Someone else's verdict for this provider could not be named, so a marker went up.
  assert.equal(
    await worker.quarantineConversation("provider-0", "generic:https://x/nameless"),
    false,
  );
  assert.equal(
    await worker.clearConversationQuarantine("provider-0", "generic:https://x/0-0"),
    false,
    "a clear was acknowledged while a marker still refuses that provider",
  );
  assert.equal(
    await worker.conversationQuarantineVerdict("provider-0", "generic:https://x/0-0"),
    "unavailable",
  );
});

test("a clear is acknowledged once the stores can name the verdict again", async () => {
  sessionStore.clear();
  localStore.clear();
  globalThis.chrome.storage.session = workingArea(sessionStore);
  globalThis.chrome.storage.local = workingArea(localStore);

  const worker = await restartWorker();
  assert.equal(
    await worker.quarantineConversation("generic-clearok", "generic:https://x/held"),
    true,
  );
  assert.equal(
    await worker.clearConversationQuarantine("generic-clearok", "generic:https://x/held"),
    true,
  );
  assert.equal(
    await worker.conversationQuarantineVerdict("generic-clearok", "generic:https://x/held"),
    "clear",
  );
});
