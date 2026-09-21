import { isRecoverableConversation, maximumRecoverableConversations, type RecoverableConversation } from "../protocol/recovery.js";
import type { BrowserSession } from "../protocol/types.js";
import type { ActiveRequest, DocumentBinding } from "./routerState.js";

export type ConversationRegistry = { version: 1; records: RecoverableConversation[] };
export const maximumRegistryInputEntries = 1000;
export const maximumProvisionalCreations = 16;
export const provisionalCreationLifetimeMs = 30 * 60_000;

export const normalizeConversationRegistry = (value: unknown): ConversationRegistry => {
  const empty: ConversationRegistry = { version: 1, records: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const registry = value as Record<string, unknown>;
  if (registry.version !== 1 || Object.keys(registry).some((key) => key !== "version" && key !== "records")
    || !Array.isArray(registry.records) || registry.records.length > maximumRegistryInputEntries) return empty;
  const entries = registry.records.filter(isRecoverableConversation);
  const ids = new Map<string, number>();
  const identities = new Map<string, number>();
  for (const entry of entries) {
    ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1);
    identities.set(entry.conversationIdentity, (identities.get(entry.conversationIdentity) ?? 0) + 1);
  }
  const records = entries.filter((entry) => ids.get(entry.id) === 1 && identities.get(entry.conversationIdentity) === 1)
    .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, maximumRecoverableConversations)
    .map((entry) => ({ ...entry }));
  return { version: 1, records };
};
export type ProvisionalCreation = {
  id: string;
  provider: "chatgpt" | "claude";
  tabId: number;
  createdAt: number;
  binding?: DocumentBinding;
};

export const bindProvisionalCreation = (
  marker: ProvisionalCreation,
  session: BrowserSession,
): ProvisionalCreation | undefined => {
  if (marker.provider !== session.provider || marker.tabId !== session.tabId || session.frameId !== 0
    || session.status !== "ready" || !session.documentToken
    || (marker.provider === "chatgpt" ? session.conversationUrl !== "https://chatgpt.com/"
      : session.conversationUrl !== "https://claude.ai/new")) return undefined;
  return { ...marker, binding: {
    provider: session.provider, tabId: session.tabId, frameId: session.frameId,
    documentId: session.documentId, documentToken: session.documentToken,
    conversationUrl: session.conversationUrl, conversationIdentity: session.conversationIdentity,
  } };
};

export const promoteCreatedConversation = (input: {
  registry: unknown;
  marker: ProvisionalCreation | undefined;
  request: ActiveRequest;
  binding: DocumentBinding;
  now: number;
}): ConversationRegistry | undefined => {
  const { marker, request, binding, now } = input;
  const initial = marker?.binding;
  if (!marker || !initial || now < marker.createdAt || now - marker.createdAt > provisionalCreationLifetimeMs
    || initial.provider !== request.provider || initial.tabId !== request.tabId
    || initial.frameId !== request.frameId || initial.documentId !== request.documentId
    || initial.documentToken !== request.documentToken || initial.conversationUrl !== request.initialConversationUrl
    || initial.provider !== binding.provider || initial.tabId !== binding.tabId
    || initial.frameId !== binding.frameId || initial.documentId !== binding.documentId
    || initial.documentToken !== binding.documentToken || !request.transitionUsed || !request.submissionCommitted
    || request.conversationUrl !== binding.conversationUrl || request.conversationIdentity !== binding.conversationIdentity) return undefined;
  const record: RecoverableConversation = {
    id: marker.id, provider: marker.provider,
    conversationUrl: binding.conversationUrl, conversationIdentity: binding.conversationIdentity,
    createdAt: marker.createdAt, updatedAt: now,
  };
  if (!isRecoverableConversation(record)) return undefined;
  const registry = normalizeConversationRegistry(input.registry);
  if (registry.records.some((entry) => entry.id === record.id || entry.conversationIdentity === record.conversationIdentity)) return undefined;
  return normalizeConversationRegistry({ version: 1, records: [...registry.records, record] });
};
