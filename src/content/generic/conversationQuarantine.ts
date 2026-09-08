// The quarantine verdict is owned by the background, in chrome.storage.session, which the
// provider page cannot reach. This module is only a client. It keeps a local cache so a
// synchronous writer can record its intent immediately, but every enforcement read goes to
// the background: a cache the page could influence must never be the authority.

type QuarantineResponse = { ok?: boolean; value?: unknown; error?: string };
export type QuarantineState = "quarantined" | "clear" | "unavailable";

const cache = new Map<string, Set<string>>();
// Positives whose SET the authority never acknowledged. Nothing waits on that acknowledgement:
// SET is sent fire-and-forget, and the caller has already moved on. This set is the only thing that
// observes the answer, and it is realm-local: a reload discards it. What survives that reload is
// whatever the authority managed to keep — a durable record, an overflow marker, or a hold in
// worker memory — and if the message never reached the background at all, nothing did.
//
// So an authority answering "false" for one of these is not proof of a release: the SET may never
// have reached it. Only an acknowledged clear releases what is in here.
const unacknowledged = new Map<string, Set<string>>();

const setFor = (store: Map<string, Set<string>>, provider: string): Set<string> => {
  const existing = store.get(provider);
  if (existing) return existing;
  const created = new Set<string>();
  store.set(provider, created);
  return created;
};

const cachedFor = (provider: string): Set<string> => setFor(cache, provider);

const unacknowledgedFor = (provider: string): Set<string> => setFor(unacknowledged, provider);

const send = async (
  type: string,
  provider: string,
  conversationIdentity?: string,
): Promise<QuarantineResponse | undefined> => {
  try {
    return await chrome.runtime.sendMessage({
      type,
      provider,
      ...(conversationIdentity === undefined ? {} : { conversationIdentity }),
    }) as QuarantineResponse | undefined;
  } catch {
    return undefined;
  }
};

const valid = (provider: unknown, identity: unknown): boolean =>
  typeof provider === "string" && provider.length > 0
  && typeof identity === "string" && identity.length > 0;

/*
 * Three answers, because "the authority could not answer" is not "the authority said clear".
 * Failing closed matters more than availability here: the verdict exists to stop a send the
 * extension could not prove safe. So only a read-confirmed clear deletes a cached positive, and
 * an unavailable authority blocks the send even when this realm's cache is empty — a reload, a
 * fresh conversation identity, or a cleared cache must not be a way around it.
 */
export const conversationQuarantineState = async (
  provider: string,
  conversationIdentity: string,
): Promise<QuarantineState> => {
  if (!valid(provider, conversationIdentity)) return "unavailable";
  const response = await send("BACHATA_QUARANTINE_IS", provider, conversationIdentity);
  if (response?.ok === true && typeof response.value === "boolean") {
    if (response.value) {
      cachedFor(provider).add(conversationIdentity);
      return "quarantined";
    }
    if (unacknowledgedFor(provider).has(conversationIdentity)) return "quarantined";
    cachedFor(provider).delete(conversationIdentity);
    return "clear";
  }
  return "unavailable";
};

export const conversationIsQuarantined = async (
  provider: string,
  conversationIdentity: string,
): Promise<boolean> =>
  (await conversationQuarantineState(provider, conversationIdentity)) !== "clear";

export const quarantineConversation = (
  provider: string,
  conversationIdentity: string,
): void => {
  if (!valid(provider, conversationIdentity)) return;
  cachedFor(provider).add(conversationIdentity);
  unacknowledgedFor(provider).add(conversationIdentity);
  void send("BACHATA_QUARANTINE_SET", provider, conversationIdentity).then((response) => {
    if (response?.ok === true) unacknowledgedFor(provider).delete(conversationIdentity);
  });
};

// Only a clear the authority acknowledged releases the local positive.
export const clearConversationQuarantine = (
  provider: string,
  conversationIdentity: string,
): void => {
  if (!valid(provider, conversationIdentity)) return;
  void send("BACHATA_QUARANTINE_CLEAR", provider, conversationIdentity).then((response) => {
    if (response?.ok !== true) return;
    cachedFor(provider).delete(conversationIdentity);
    unacknowledgedFor(provider).delete(conversationIdentity);
  });
};

export const resetConversationQuarantineCache = (): void => {
  cache.clear();
  unacknowledged.clear();
};
