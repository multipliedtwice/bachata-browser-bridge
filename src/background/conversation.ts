import { BrowserProvider, ConversationBinding, protocolVersion, ServerMessage } from "../protocol/types.js";

export const utf8ByteLength = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

export const providerForUrl = (value: string): BrowserProvider | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return undefined;
    }
    if (url.hostname === "chatgpt.com") {
      return "chatgpt";
    }
    if (url.hostname === "claude.ai") {
      return "claude";
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const canonicalConversationUrl = (
  provider: BrowserProvider,
  value: string,
): string => {
  const url = new URL(value);
  if (provider === "generic") {
    // BB-14, recorded decision: generic conversation identity deliberately keeps `search` and
    // `hash`, unlike the built-in providers which strip both. Some generic browser LLMs carry
    // the conversation in a query parameter or a fragment, so stripping them globally would
    // merge distinct conversations into one identity. Narrowing this per provider needs
    // owner-approved semantics and per-provider tests, not a blanket rule.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Generic browser conversations require an HTTP(S) URL");
    }
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  }
  if (providerForUrl(value) !== provider) {
    throw new Error(`URL does not belong to ${provider}`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
};

export const conversationIdentityFor = (
  provider: BrowserProvider,
  value: string,
): string => `${provider}:${canonicalConversationUrl(provider, value)}`;

export const sessionIdForConversation = (
  provider: BrowserProvider,
  tabId: number,
  documentToken: string,
  conversationIdentity: string,
): string =>
  `${provider}:${String(tabId)}:${documentToken}:${encodeURIComponent(conversationIdentity)}`;

/** Whether this provider may assign a conversation URL from the page a request started on. */
export const isSupportedInitialTransitionStart = (
  provider: BrowserProvider,
  value: string,
): boolean => {
  try {
    const url = new URL(value);
    // `providerForUrl` answers "chatgpt", "claude" or nothing at all, so reaching past this line is
    // proof the page is the named provider's own site — and Generic, which no URL is ever
    // attributed to, is decided entirely here. That leaves exactly two providers below, so a third
    // arm would be a line no input can reach: unreachable code, and an uncovered line under the
    // 100% gate this module is held to.
    if (providerForUrl(value) !== provider) {
      return provider === "generic" && (url.protocol === "http:" || url.protocol === "https:");
    }
    return provider === "chatgpt"
      ? url.pathname === "/"
      : url.pathname === "/" || url.pathname === "/new";
  } catch {
    return false;
  }
};

export const isSupportedInitialTransition = (
  provider: BrowserProvider,
  previousUrl: string,
  nextUrl: string,
): boolean => {
  try {
    const previous = new URL(previousUrl);
    const next = new URL(nextUrl);
    if (
      previous.origin !== next.origin ||
      !isSupportedInitialTransitionStart(provider, previousUrl)
    ) {
      return false;
    }
    if (provider === "chatgpt") {
      return next.pathname.startsWith("/c/");
    }
    if (provider === "claude") {
      return next.pathname.startsWith("/chat/") || next.pathname.startsWith("/chats/");
    }
    return provider === "generic";
  } catch {
    return false;
  }
};

// An ActiveRequest is built with `{ ...message }` from the parsed conversation.send, so it
// carries that message's own `type`, `text` and `attachments` at runtime even though
// ActiveRequest does not declare them. Spreading it into an interrupt payload therefore
// overwrites the interrupt type and re-sends the prompt. Name the binding fields instead:
// the content script routes on `type`, and nothing else here may reach it.
export const interruptPayload = (
  request: ConversationBinding,
): Extract<ServerMessage, { type: "conversation.interrupt" }> => ({
  type: "conversation.interrupt",
  protocolVersion,
  requestId: request.requestId,
  agentId: request.agentId,
  provider: request.provider,
  sessionId: request.sessionId,
  tabId: request.tabId,
  frameId: request.frameId,
  ...(request.documentId === undefined ? {} : { documentId: request.documentId }),
  documentToken: request.documentToken,
  conversationUrl: request.conversationUrl,
  conversationIdentity: request.conversationIdentity,
});
