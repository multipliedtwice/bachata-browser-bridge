export type RecoverableConversation = {
  id: string;
  provider: "chatgpt" | "claude";
  conversationUrl: string;
  conversationIdentity: string;
  createdAt: number;
  updatedAt: number;
};

export const maximumRecoverableConversations = 50;
export const maximumRecoveryUrlLength = 2048;
export const isRecoveryId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);

export const isStableRecoveryIdentity = (
  provider: unknown,
  conversationUrl: unknown,
  conversationIdentity: unknown,
): boolean => {
  if ((provider !== "chatgpt" && provider !== "claude")
    || typeof conversationUrl !== "string" || conversationUrl.length > maximumRecoveryUrlLength
    || conversationIdentity !== `${provider}:${conversationUrl}`) return false;
  const route = provider === "chatgpt"
    ? /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]{1,128}$/u
    : /^https:\/\/claude\.ai\/chats?\/[A-Za-z0-9_-]{1,128}$/u;
  return route.test(conversationUrl);
};

export const isRecoverableConversation = (value: unknown): value is RecoverableConversation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 6
    && Object.keys(entry).every((key) => ["id", "provider", "conversationUrl", "conversationIdentity", "createdAt", "updatedAt"].includes(key))
    && isRecoveryId(entry.id)
    && isStableRecoveryIdentity(entry.provider, entry.conversationUrl, entry.conversationIdentity)
    && typeof entry.createdAt === "number" && Number.isSafeInteger(entry.createdAt) && entry.createdAt > 0
    && typeof entry.updatedAt === "number" && Number.isSafeInteger(entry.updatedAt)
    && entry.updatedAt >= entry.createdAt && entry.updatedAt <= 8_640_000_000_000_000;
};

export const validRecoverableConversations = (value: unknown): value is RecoverableConversation[] =>
  Array.isArray(value) && value.length <= maximumRecoverableConversations
  && value.every(isRecoverableConversation)
  && new Set(value.map((entry) => entry.id)).size === value.length
  && new Set(value.map((entry) => entry.conversationIdentity)).size === value.length;
