// Quarantine is an enforcement verdict: it says a conversation may not be sent to again because
// provider idle state could not be confirmed. It used to live in the provider page's own
// sessionStorage, which the page can rewrite. A bare clear was survived by an in-memory copy, but
// a valid `{}` overwrite replaced that copy too, and a clear followed by a reload lost it outright
// — ordinary logout-and-navigate behaviour, no attacker required. The extension then reported
// conversationState "confirmed" and unattended runs reused it.
//
// The background owns the verdict now. Content scripts read and write it through runtime messages
// and may cache it, but the cache is never the authority.
//
// Five rules hold the design together, each one paid for by a defect that came before it:
//
//  1. Every store keeps its own state and is written on its own terms. A merged view is only ever
//     read from, never written back, because writing a union into one store overflows that store's
//     own format and corrupts it.
//  2. Identities and overflow markers live under separate keys. A marker that had to fit inside
//     the identity map could not be written exactly when the map was full, which is the one moment
//     it matters.
//  3. A verdict that cannot be recorded as an identity is recorded as an overflow marker — for its
//     provider, or globally when even that cannot fit — so unknown identities read unavailable
//     rather than clear. Silence is not evidence of absence.
//  4. A store that cannot be written to is not believed when it says "nothing here", because that
//     is exactly what it would say after losing a write. Nor is a store whose expired records
//     could not be compacted away, because the read it just gave is one it could not clean up.
//  5. The identity map keeps the shape and key it shipped with, so an extension upgrade reads the
//     verdicts the previous version wrote rather than starting empty.

import { createRevisionQueue } from "./serializedState.js";

export type QuarantineRequest = {
  type: "BACHATA_QUARANTINE_IS" | "BACHATA_QUARANTINE_SET" | "BACHATA_QUARANTINE_CLEAR" | "BACHATA_QUARANTINE_LIST";
  provider?: unknown;
  conversationIdentity?: unknown;
};

// Three states, not two. "clear" is a verdict the authority read from a store it can also write;
// "unavailable" means it could not read, could not write, or knows a verdict went unrecorded.
export type QuarantineVerdict = "quarantined" | "clear" | "unavailable";

export const quarantineUnavailableError = "Conversation quarantine authority is unavailable";
export const quarantineInvalidTargetError = "Invalid conversation quarantine target";

type QuarantineRecord = { identity: string; expiresAt: number };
type QuarantineState = Record<string, QuarantineRecord[]>;
type OverflowState = { providers: Record<string, number>; allUntil?: number };

type StoreRead = {
  complete: boolean;
  records: QuarantineState;
  overflow: OverflowState;
};

type StorageAreas = {
  storage?: {
    session?: chrome.storage.StorageArea;
    local?: chrome.storage.StorageArea;
  };
};

const queue = createRevisionQueue();

// The identity map keeps the key and shape the shipped version wrote, so an upgrade is not a way
// to lose every live verdict. Overflow is new, and lives beside it rather than inside it.
const primaryRecordsKey = "bachataConversationQuarantine.v1";
const emergencyRecordsKey = "bachataConversationQuarantineEmergency.v1";
const overflowKey = "bachataConversationQuarantineOverflow.v1";
const maximumProviders = 16;
const maximumIdentitiesPerProvider = 16;
const maximumIdentityLength = 4_096;
const maximumProviderLength = 32;
export const quarantineLifetimeMs = 24 * 60 * 60 * 1_000;

// Verdicts this worker decided but could not record anywhere durable. They are flushed to storage
// as soon as any store accepts writes again.
//
// The stated limit of this whole design: if every durable store refuses a write and the worker
// restarts before any of them recovers, that verdict is gone, and stores that later come back
// empty will answer "clear" for it. No durable evidence of the refusal can be written by a worker
// that cannot write.
//
// What actually happens to that refusal in the meantime, stated exactly: this worker keeps
// refusing the conversation for as long as it lives, and the failed write is returned to the
// message handler as `{ ok: false }`. The content client sends SET fire-and-forget, so nothing
// waits on that answer; what observes it is the client's own unacknowledged-positive cache, which
// keeps its local refusal in that realm until a clear is acknowledged. Neither the caller of the
// send nor the controller is told, and no message is emitted for it.
const heldWithoutStorage = new Map<string, Map<string, number>>();

let storesWritable: boolean | undefined;

const validProvider = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximumProviderLength;

const validIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximumIdentityLength;

const wellFormedRecord = (value: unknown): value is QuarantineRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return validIdentity(record.identity)
    && typeof record.expiresAt === "number"
    && Number.isFinite(record.expiresAt);
};

// Malformed is not empty. A key this worker never wrote, or wrote in another shape, is a state it
// cannot read — and reading it as "no verdict" is the same fail-open as a rejected `get`. Only an
// absent key is legitimately empty. Over-limit is malformed too: trimming a state to fit would
// discard a verdict still in force and then answer "clear" for it.
const parseRecords = (
  value: unknown,
  now: number,
): { state: QuarantineState; stale: boolean } | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state: QuarantineState = {};
  let stale = false;
  const providers = Object.entries(value as Record<string, unknown>);
  if (providers.length > maximumProviders) return undefined;
  for (const [provider, records] of providers) {
    if (!validProvider(provider) || !Array.isArray(records)) return undefined;
    if (records.length > maximumIdentitiesPerProvider) return undefined;
    const kept: QuarantineRecord[] = [];
    const seen = new Set<string>();
    for (const record of records as unknown[]) {
      if (!wellFormedRecord(record)) return undefined;
      const typed = record as QuarantineRecord;
      // An expired record is well formed and simply no longer in force.
      if (typed.expiresAt <= now || seen.has(typed.identity)) {
        stale = true;
        continue;
      }
      seen.add(typed.identity);
      kept.push({ identity: typed.identity, expiresAt: typed.expiresAt });
    }
    if (kept.length === 0) {
      if (records.length > 0) stale = true;
      continue;
    }
    state[provider] = kept;
  }
  return { state, stale };
};

const parseOverflow = (
  value: unknown,
  now: number,
): { state: OverflowState; stale: boolean } | undefined => {
  // An absent key is legitimately empty. A present value has to be exactly what this worker
  // writes: `providers` always, `allUntil` optionally, nothing else. `{}` is not "no markers", it
  // is a shape this worker never wrote, and reading it as empty is the same fail-open the identity
  // map already refuses.
  if (value === undefined) return { state: { providers: {} }, stale: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.includes("providers")) return undefined;
  if (keys.some((key) => key !== "providers" && key !== "allUntil")) return undefined;
  const { providers, allUntil } = record;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  if (allUntil !== undefined && (typeof allUntil !== "number" || !Number.isFinite(allUntil))) {
    return undefined;
  }
  const entries = Object.entries(providers as Record<string, unknown>);
  if (entries.length > maximumProviders) return undefined;
  const kept: Record<string, number> = {};
  let stale = false;
  for (const [provider, until] of entries) {
    if (!validProvider(provider) || typeof until !== "number" || !Number.isFinite(until)) {
      return undefined;
    }
    if (until <= now) {
      stale = true;
      continue;
    }
    kept[provider] = until;
  }
  const globalInForce = typeof allUntil === "number" && allUntil > now;
  if (typeof allUntil === "number" && !globalInForce) stale = true;
  return {
    state: globalInForce ? { providers: kept, allUntil: allUntil as number } : { providers: kept },
    stale,
  };
};

const sessionArea = (): chrome.storage.StorageArea | undefined =>
  (chrome as typeof chrome & StorageAreas).storage?.session;

// The emergency store. Session storage is the normal home because it dies with the browsing
// session, the right lifetime for a verdict about a live conversation. Local storage outlives the
// worker, so a verdict the session store refuses still outlives a restart.
const emergencyArea = (): chrome.storage.StorageArea | undefined =>
  (chrome as typeof chrome & StorageAreas).storage?.local;

type Store = { area: chrome.storage.StorageArea | undefined; recordsKey: string };

const stores = (): Store[] => [
  { area: sessionArea(), recordsKey: primaryRecordsKey },
  { area: emergencyArea(), recordsKey: emergencyRecordsKey },
];

const readKey = async (store: Store, key: string): Promise<{ ok: boolean; raw?: unknown }> => {
  if (!store.area) return { ok: false };
  try {
    const stored = await store.area.get(key);
    return { ok: true, raw: stored[key] };
  } catch {
    return { ok: false };
  }
};

const writeKey = async (store: Store, key: string, value: unknown): Promise<boolean> => {
  if (!store.area) return false;
  try {
    await store.area.set({ [key]: value });
    storesWritable = true;
    return true;
  } catch {
    // The most recent evidence, not a one-time verdict: a store that worked earlier and refuses
    // now is exactly the case where a later empty read must not be believed.
    storesWritable = false;
    return false;
  }
};

// Expired identities are dropped on read, and the store is compacted so the dropped ones stop
// existing on disk. A verdict is a conversation identity; keeping one past its window is keeping a
// record of where someone was talking, for no purpose the extension has. A compaction that cannot
// land makes the read incomplete: the answer would be based on a state this worker could neither
// clean up nor trust, and the identity is still physically there until a later read succeeds.
const readStore = async (store: Store, now: number): Promise<StoreRead> => {
  const empty: StoreRead = { complete: false, records: {}, overflow: { providers: {} } };
  const [recordsRaw, overflowRaw] = await Promise.all([
    readKey(store, store.recordsKey),
    readKey(store, overflowKey),
  ]);
  if (!recordsRaw.ok || !overflowRaw.ok) return empty;
  const parsedRecords = recordsRaw.raw === undefined
    ? { state: {} as QuarantineState, stale: false }
    : parseRecords(recordsRaw.raw, now);
  const parsedOverflow = parseOverflow(overflowRaw.raw, now);
  if (!parsedRecords || !parsedOverflow) return empty;
  let complete = true;
  if (parsedRecords.stale && !await writeKey(store, store.recordsKey, parsedRecords.state)) {
    complete = false;
  }
  if (parsedOverflow.stale && !await writeKey(store, overflowKey, parsedOverflow.state)) {
    complete = false;
  }
  return { complete, records: parsedRecords.state, overflow: parsedOverflow.state };
};

const readStores = async (
  now: number,
): Promise<Array<{ store: Store; read: StoreRead }>> => await Promise.all(
  stores().map(async (store) => ({ store, read: await readStore(store, now) })),
);

const readEveryStore = async (
  now: number,
  exclude?: { provider: string; identity: string },
): Promise<{ complete: boolean; reads: Array<{ store: Store; read: StoreRead }> }> => {
  const reads = await readStores(now);
  await flushHeldVerdicts(reads, now, exclude);
  return { complete: reads.every((entry) => entry.read.complete), reads };
};

// "Nothing here" from a store that cannot be written to is not evidence: it is exactly what that
// store would say after silently losing the write that mattered. A remembered "yes" stands until a
// write says otherwise; a remembered "no" is re-tested, because a store that refused earlier is
// the one whose recovery must be noticed.
const provenWritable = async (
  reads: Array<{ store: Store; read: StoreRead }>,
): Promise<boolean> => {
  if (storesWritable === true) return true;
  for (const { store, read } of reads) {
    if (!read.complete) continue;
    // Writing back exactly what was just read: no new data, and the store is left as it was.
    if (await writeKey(store, store.recordsKey, read.records)) return true;
  }
  storesWritable = false;
  return false;
};

const heldFor = (provider: string): Map<string, number> => {
  const existing = heldWithoutStorage.get(provider);
  if (existing) return existing;
  const created = new Map<string, number>();
  heldWithoutStorage.set(provider, created);
  return created;
};

const releaseWithoutStorage = (provider: string, identity: string): void => {
  const held = heldWithoutStorage.get(provider);
  if (!held) return;
  held.delete(identity);
  if (held.size === 0) heldWithoutStorage.delete(provider);
};

// A lookup, not a cleaner: expiry is dropped by the flush that runs before every verdict, so this
// would only ever be a second place for the same rule to live.
const heldWithoutStorageNow = (provider: string, identity: string, now: number): boolean => {
  const expiresAt = heldWithoutStorage.get(provider)?.get(identity);
  return expiresAt !== undefined && expiresAt > now;
};

const recordInStore = async (
  entry: { store: Store; read: StoreRead },
  provider: string,
  identity: string,
  expiresAt: number,
): Promise<boolean> => {
  if (!entry.read.complete) return false;
  const state = entry.read.records;
  const others = (state[provider] ?? []).filter((record) => record.identity !== identity);
  const next: QuarantineState = { ...state, [provider]: [...others, { identity, expiresAt }] };
  // A verdict that does not fit is refused here, never swapped for one still in force.
  if (Object.keys(next).length > maximumProviders) return false;
  if (next[provider]!.length > maximumIdentitiesPerProvider) return false;
  if (!await writeKey(entry.store, entry.store.recordsKey, next)) return false;
  entry.read.records = next;
  return true;
};

// Marking overflow never competes with identities for space: separate key, and a global marker for
// the case where even the per-provider map is full.
const markOverflow = async (
  entry: { store: Store; read: StoreRead },
  provider: string,
  until: number,
): Promise<boolean> => {
  if (!entry.read.complete) return false;
  const current = entry.read.overflow;
  const providers = { ...current.providers, [provider]: until };
  const next: OverflowState = Object.keys(providers).length > maximumProviders
    ? { providers: current.providers, allUntil: Math.max(current.allUntil ?? 0, until) }
    : current.allUntil !== undefined
      ? { providers, allUntil: current.allUntil }
      : { providers };
  if (!await writeKey(entry.store, overflowKey, next)) return false;
  entry.read.overflow = next;
  return true;
};

// The one way a verdict becomes durable, used by a fresh verdict and by a held one alike: record
// the identity if any store can name it, and otherwise say durably that a verdict exists which
// nobody can name. A flush that only tried the first of those left a held verdict in memory
// whenever the stores came back full.
const persistVerdict = async (
  reads: Array<{ store: Store; read: StoreRead }>,
  provider: string,
  identity: string,
  expiresAt: number,
): Promise<"recorded" | "marked" | "none"> => {
  for (const entry of reads) {
    if (await recordInStore(entry, provider, identity, expiresAt)) return "recorded";
  }
  for (const entry of reads) {
    if (await markOverflow(entry, provider, expiresAt)) return "marked";
  }
  return "none";
};

// A verdict that had no durable home when it was made gets one as soon as a store accepts writes
// again, so the window in which it lives only in this worker is as short as storage allows. This
// runs after every read of the stores, not only on the verdict path: a list or an unrelated write
// is just as much a chance to notice that storage came back.
const flushHeldVerdicts = async (
  reads: Array<{ store: Store; read: StoreRead }>,
  now: number,
  // A clear excludes its own target. Flushing it would turn the verdict being retracted into a
  // nameless marker, and the clear would then report success over a conversation that is still
  // refused — the marker outliving the identity it was standing in for.
  exclude?: { provider: string; identity: string },
): Promise<void> => {
  for (const [provider, held] of [...heldWithoutStorage]) {
    for (const [identity, expiresAt] of [...held]) {
      if (exclude && exclude.provider === provider && exclude.identity === identity) continue;
      if (expiresAt <= now) {
        releaseWithoutStorage(provider, identity);
        continue;
      }
      if (await persistVerdict(reads, provider, identity, expiresAt) !== "none") {
        releaseWithoutStorage(provider, identity);
      }
    }
  }
};

const holdsIdentity = (read: StoreRead, provider: string, identity: string): boolean =>
  (read.records[provider] ?? []).some((record) => record.identity === identity);

const overflowInForce = (read: StoreRead, provider: string, now: number): boolean => {
  if (read.overflow.allUntil !== undefined && read.overflow.allUntil > now) return true;
  const until = read.overflow.providers[provider];
  return until !== undefined && until > now;
};

export const conversationQuarantineVerdict = async (
  provider: unknown,
  conversationIdentity: unknown,
  now = Date.now(),
): Promise<QuarantineVerdict> => {
  // A target this authority cannot even name is not a conversation it can call clear.
  if (!validProvider(provider) || !validIdentity(conversationIdentity)) return "unavailable";
  return await queue.enqueueRead(async () => {
    const { complete, reads } = await readEveryStore(now);
    if (heldWithoutStorageNow(provider, conversationIdentity, now)) return "quarantined";
    if (reads.some(({ read }) => holdsIdentity(read, provider, conversationIdentity))) {
      return "quarantined";
    }
    // A verdict that could not be recorded is a verdict about an identity nobody can name any
    // more, so no identity it might have been can be called clear while the marker stands.
    if (reads.some(({ read }) => overflowInForce(read, provider, now))) return "unavailable";
    if (!complete) return "unavailable";
    return await provenWritable(reads) ? "clear" : "unavailable";
  });
};

// Fail closed by construction: anything that is not a read-confirmed clear counts as held.
export const conversationIsQuarantined = async (
  provider: unknown,
  conversationIdentity: unknown,
  now = Date.now(),
): Promise<boolean> =>
  (await conversationQuarantineVerdict(provider, conversationIdentity, now)) !== "clear";

export const quarantineConversation = async (
  provider: unknown,
  conversationIdentity: unknown,
  now = Date.now(),
): Promise<boolean> => {
  if (!validProvider(provider) || !validIdentity(conversationIdentity)) return false;
  const expiresAt = now + quarantineLifetimeMs;
  return await queue.enqueueMutation(async () => {
    const { reads } = await readEveryStore(now);
    const outcome = await persistVerdict(reads, provider, conversationIdentity, expiresAt);
    if (outcome !== "none") {
      releaseWithoutStorage(provider, conversationIdentity);
      // "marked" is durable but nameless: the verdict stands, and the caller is told the identity
      // itself was not written.
      return outcome === "recorded";
    }
    heldFor(provider).set(conversationIdentity, expiresAt);
    return false;
  });
};

export const clearConversationQuarantine = async (
  provider: unknown,
  conversationIdentity: unknown,
  now = Date.now(),
): Promise<boolean> => {
  if (!validProvider(provider) || !validIdentity(conversationIdentity)) return false;
  return await queue.enqueueMutation(async () => {
    const { reads } = await readEveryStore(now, { provider, identity: conversationIdentity });
    // A store nobody can write to cannot be trusted to have let go of anything, and a clear that
    // touched no store would otherwise "succeed" trivially — releasing a verdict this worker is
    // holding precisely because it could not write it down.
    let released = await provenWritable(reads);
    for (const entry of reads) {
      // A store that could not answer may still be holding this verdict.
      if (!entry.read.complete) {
        released = false;
        continue;
      }
      const existing = entry.read.records[provider] ?? [];
      if (!existing.some((record) => record.identity === conversationIdentity)) continue;
      const records = existing.filter((record) => record.identity !== conversationIdentity);
      const next: QuarantineState = { ...entry.read.records };
      if (records.length === 0) delete next[provider];
      else next[provider] = records;
      // Only ever this store's own state goes back into this store.
      if (await writeKey(entry.store, entry.store.recordsKey, next)) entry.read.records = next;
      else released = false;
    }
    // A marker standing over this provider is a verdict nobody can name, so this identity cannot
    // be proven to be the one that was retracted. Reporting success here would be a clear the very
    // next read contradicts.
    if (reads.some(({ read }) => overflowInForce(read, provider, now))) released = false;
    if (released) releaseWithoutStorage(provider, conversationIdentity);
    return released;
  });
};

// Undefined is the unavailable answer: an empty list is a read verdict, not a failure.
export const quarantinedIdentities = async (
  provider: unknown,
  now = Date.now(),
): Promise<string[] | undefined> => {
  if (!validProvider(provider)) return undefined;
  return await queue.enqueueRead(async () => {
    const { complete, reads } = await readEveryStore(now);
    if (!complete) return undefined;
    // An overflow marker means at least one identity is missing from this list, so the list cannot
    // be presented as the whole answer.
    if (reads.some(({ read }) => overflowInForce(read, provider, now))) return undefined;
    if (!await provenWritable(reads)) return undefined;
    // Held verdicts are not unioned in here: reaching this point means every store answered and
    // accepts writes, and the flush above turns any hold into a record or a marker before it does.
    // A marker would already have returned undefined.
    return [...new Set(
      reads.flatMap(({ read }) => (read.records[provider] ?? []).map((r) => r.identity)),
    )];
  });
};

// Only this extension's own content scripts may move the verdict. A page cannot reach
// chrome.runtime.sendMessage without externally_connectable, which this extension does not
// declare, but the sender is still checked rather than assumed.
export const handleQuarantineMessage = async (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true; value?: unknown } | { ok: false; error: string } | undefined> => {
  const type = message.type;
  if (type !== "BACHATA_QUARANTINE_IS"
    && type !== "BACHATA_QUARANTINE_SET"
    && type !== "BACHATA_QUARANTINE_CLEAR"
    && type !== "BACHATA_QUARANTINE_LIST") {
    return undefined;
  }
  if (sender.id !== chrome.runtime.id) {
    return { ok: false, error: "Invalid conversation quarantine sender" };
  }
  const provider = message.provider;
  const identity = message.conversationIdentity;
  const targetNamed = type === "BACHATA_QUARANTINE_LIST"
    ? validProvider(provider)
    : validProvider(provider) && validIdentity(identity);
  // A malformed request and an unreachable store are both refusals, but they are not the same
  // refusal: the caller can fix one and only wait out the other.
  if (!targetNamed) return { ok: false, error: quarantineInvalidTargetError };
  if (type === "BACHATA_QUARANTINE_IS") {
    const verdict = await conversationQuarantineVerdict(provider, identity);
    if (verdict === "unavailable") return { ok: false, error: quarantineUnavailableError };
    return { ok: true, value: verdict === "quarantined" };
  }
  if (type === "BACHATA_QUARANTINE_LIST") {
    const identities = await quarantinedIdentities(provider);
    if (!identities) return { ok: false, error: quarantineUnavailableError };
    return { ok: true, value: identities };
  }
  // Never acknowledge a write that did not land: the client keeps its own positive cache on the
  // strength of that acknowledgement.
  const persisted = type === "BACHATA_QUARANTINE_SET"
    ? await quarantineConversation(provider, identity)
    : await clearConversationQuarantine(provider, identity);
  if (!persisted) return { ok: false, error: quarantineUnavailableError };
  return { ok: true };
};
