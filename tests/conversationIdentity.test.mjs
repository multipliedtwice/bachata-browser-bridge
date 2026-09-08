import assert from "node:assert/strict";
import test from "node:test";

import { protocolVersion } from "../dist/protocol/types.js";
import {
  canonicalConversationUrl,
  conversationIdentityFor,
  interruptPayload,
  isSupportedInitialTransition,
  isSupportedInitialTransitionStart,
  providerForUrl,
  sessionIdForConversation,
  utf8ByteLength,
} from "../dist/background/conversation.js";

test("a provider is recognised only over https on its own host", () => {
  assert.equal(providerForUrl("https://chatgpt.com/c/abc"), "chatgpt");
  assert.equal(providerForUrl("https://claude.ai/chat/abc"), "claude");
  assert.equal(providerForUrl("http://chatgpt.com/c/abc"), undefined, "plain http was accepted");
  assert.equal(providerForUrl("https://chatgpt.com.evil.test/c/abc"), undefined, "a lookalike host was accepted");
  assert.equal(providerForUrl("not a url"), undefined);
  assert.equal(providerForUrl("javascript:alert(1)"), undefined);
});

test("conversation identity is canonical, so one conversation has one identity", () => {
  const identities = [
    "https://chatgpt.com/c/abc",
    "https://chatgpt.com/c/abc/",
    "https://chatgpt.com/c/abc?utm=1",
    "https://chatgpt.com/c/abc#section",
  ].map((url) => conversationIdentityFor("chatgpt", url));
  assert.equal(new Set(identities).size, 1, "one conversation produced several identities");
  assert.equal(identities[0], "chatgpt:https://chatgpt.com/c/abc");
});

test("a URL belonging to another provider is refused", () => {
  assert.throws(
    () => canonicalConversationUrl("claude", "https://chatgpt.com/c/abc"),
    /does not belong to claude/u,
  );
  assert.throws(
    () => canonicalConversationUrl("chatgpt", "https://claude.ai/chat/abc"),
    /does not belong to chatgpt/u,
  );
});

test("a generic conversation requires http or https and keeps its own query", () => {
  assert.equal(
    canonicalConversationUrl("generic", "https://llm.internal.test/chat/7/"),
    "https://llm.internal.test/chat/7",
  );
  assert.throws(
    () => canonicalConversationUrl("generic", "file:///etc/passwd"),
    /require an HTTP\(S\) URL/u,
  );
  assert.throws(() => canonicalConversationUrl("generic", "ftp://host/x"), /HTTP\(S\)/u);
});

test("a session is bound to tab, document and conversation together", () => {
  const base = sessionIdForConversation("chatgpt", 7, "doc-1", "chatgpt:https://chatgpt.com/c/abc");
  assert.equal(
    sessionIdForConversation("chatgpt", 7, "doc-1", "chatgpt:https://chatgpt.com/c/abc"),
    base,
    "the same binding produced two session ids",
  );
  // A refreshed document, a different tab, or a different conversation is a different session.
  assert.notEqual(sessionIdForConversation("chatgpt", 7, "doc-2", "chatgpt:https://chatgpt.com/c/abc"), base);
  assert.notEqual(sessionIdForConversation("chatgpt", 8, "doc-1", "chatgpt:https://chatgpt.com/c/abc"), base);
  assert.notEqual(sessionIdForConversation("chatgpt", 7, "doc-1", "chatgpt:https://chatgpt.com/c/xyz"), base);
  assert.notEqual(sessionIdForConversation("claude", 7, "doc-1", "chatgpt:https://chatgpt.com/c/abc"), base);
});

test("a conversation identity with separators cannot forge another session id", () => {
  const forged = sessionIdForConversation("chatgpt", 7, "doc-1", "a:b:c");
  assert.ok(forged.endsWith(encodeURIComponent("a:b:c")), "the identity was not escaped into the session id");
  assert.notEqual(forged, "chatgpt:7:doc-1:a:b:c");
});

test("only a real new-conversation transition is accepted", () => {
  assert.equal(
    isSupportedInitialTransition("chatgpt", "https://chatgpt.com/", "https://chatgpt.com/c/abc"),
    true,
  );
  assert.equal(
    isSupportedInitialTransition("claude", "https://claude.ai/new", "https://claude.ai/chat/abc"),
    true,
  );
  assert.equal(
    isSupportedInitialTransition("claude", "https://claude.ai/", "https://claude.ai/chats/abc"),
    true,
  );
  // Navigating between two existing conversations is not a first transition.
  assert.equal(
    isSupportedInitialTransition("chatgpt", "https://chatgpt.com/c/one", "https://chatgpt.com/c/two"),
    false,
    "a conversation switch was treated as a new conversation",
  );
  // Crossing origins is never a continuation of the same conversation.
  assert.equal(
    isSupportedInitialTransition("chatgpt", "https://chatgpt.com/", "https://evil.test/c/abc"),
    false,
    "a cross-origin navigation was accepted",
  );
  assert.equal(isSupportedInitialTransition("chatgpt", "not a url", "https://chatgpt.com/c/abc"), false);
});

test("a provider-specific rule never leaks onto another provider", () => {
  // ChatGPT's "/" -> "/c/" rule must not admit Claude's paths, and vice versa.
  assert.equal(
    isSupportedInitialTransition("chatgpt", "https://chatgpt.com/new", "https://chatgpt.com/c/abc"),
    false,
    "Claude's /new rule leaked into ChatGPT",
  );
  assert.equal(
    isSupportedInitialTransition("claude", "https://claude.ai/", "https://claude.ai/c/abc"),
    false,
    "ChatGPT's /c/ rule leaked into Claude",
  );
  // Generic accepts any same-origin transition, and that permissiveness stays generic.
  assert.equal(
    isSupportedInitialTransition("generic", "https://llm.test/a", "https://llm.test/b"),
    true,
  );
  assert.equal(
    isSupportedInitialTransition("generic", "https://llm.test/a", "https://other.test/b"),
    false,
  );
});

test("only a provider's own new-conversation page is a first-turn starting point", () => {
  // The start rule is asked on its own now: `tabChange.ts` reads it directly to decide whether a
  // bound request is still waiting for its one permitted navigation, without a destination URL to
  // judge. What it answers there has to be the same thing it answers inside a full transition.
  assert.equal(isSupportedInitialTransitionStart("chatgpt", "https://chatgpt.com/"), true);
  assert.equal(isSupportedInitialTransitionStart("chatgpt", "https://chatgpt.com/?ref=x"), true);
  assert.equal(isSupportedInitialTransitionStart("chatgpt", "https://chatgpt.com/new"), false);
  assert.equal(isSupportedInitialTransitionStart("chatgpt", "https://chatgpt.com/c/one"), false);
  assert.equal(isSupportedInitialTransitionStart("claude", "https://claude.ai/"), true);
  assert.equal(isSupportedInitialTransitionStart("claude", "https://claude.ai/new"), true);
  assert.equal(isSupportedInitialTransitionStart("claude", "https://claude.ai/chat/one"), false);
  assert.equal(isSupportedInitialTransitionStart("chatgpt", "not a url"), false);
});

test("a page that is not the provider's own is never that provider's starting point", () => {
  // The origin equality inside `isSupportedInitialTransition` compares the two URLs of one
  // navigation to each other and says nothing about whose site they are on, so a page that merely
  // imitated a provider's paths satisfied it: root to `/c/...` on any origin at all read as
  // ChatGPT opening a conversation. Whether the starting page belongs to the provider is a
  // separate question, and it is asked here.
  for (const provider of ["chatgpt", "claude"]) {
    assert.equal(isSupportedInitialTransitionStart(provider, "https://evil.test/"), false, provider);
    assert.equal(isSupportedInitialTransitionStart(provider, "http://chatgpt.com/"), false, provider);
  }
  assert.equal(
    isSupportedInitialTransition("chatgpt", "https://evil.test/", "https://evil.test/c/abc"),
    false,
    "a lookalike origin was accepted as ChatGPT's first transition",
  );
  assert.equal(
    isSupportedInitialTransition("claude", "https://evil.test/new", "https://evil.test/chat/abc"),
    false,
    "a lookalike origin was accepted as Claude's first transition",
  );
  assert.equal(
    isSupportedInitialTransition("chatgpt", "https://claude.ai/", "https://claude.ai/c/abc"),
    false,
    "one provider's site was accepted as another provider's first transition",
  );
});

test("a Generic conversation starts anywhere it is allowed to be, and only over HTTP(S)", () => {
  assert.equal(isSupportedInitialTransitionStart("generic", "https://llm.test/a"), true);
  assert.equal(isSupportedInitialTransitionStart("generic", "http://localhost:8080/chat"), true);
  assert.equal(isSupportedInitialTransitionStart("generic", "file:///tmp/page.html"), false);
  assert.equal(isSupportedInitialTransitionStart("generic", "chrome://settings"), false);
});

test("byte length is measured in UTF-8, not code units", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("😀"), 4);
});

// BB-15. The background builds an ActiveRequest with `{ ...message }` from the parsed
// conversation.send, so the runtime object carries that message's `type`, `text` and
// `attachments` even though ActiveRequest never declares them. Start from that real shape:
// a fixture that only holds binding fields cannot fail the way production did.
test("an interrupt built from a live send request never carries the send back to the page", () => {
  const sendMessage = {
    type: "conversation.send",
    protocolVersion,
    requestId: "request-1",
    agentId: "agent-1",
    provider: "chatgpt",
    sessionId: "session-1",
    tabId: 7,
    frameId: 0,
    documentToken: "document-1",
    conversationUrl: "https://chatgpt.com/c/abc",
    conversationIdentity: "chatgpt:https://chatgpt.com/c/abc",
    text: "PROMPT BODY",
    attachments: [],
    allowInitialConversationTransition: false,
    deadlineAt: Date.now() + 60_000,
  };
  const activeRequest = {
    ...sendMessage,
    deadlineAt: sendMessage.deadlineAt,
    transitionUsed: false,
    initialConversationUrl: sendMessage.conversationUrl,
  };
  assert.equal(activeRequest.type, "conversation.send", "precondition: the runtime shape carries the send type");

  const payload = interruptPayload(activeRequest);

  assert.equal(payload.type, "conversation.interrupt");
  assert.equal("text" in payload, false, "the interrupt still carries the prompt body");
  assert.equal("attachments" in payload, false, "the interrupt still carries attachments");
  assert.equal("deadlineAt" in payload, false, "the interrupt still carries a future deadline");
  assert.equal("allowInitialConversationTransition" in payload, false);
  assert.equal(payload.requestId, "request-1");
  assert.equal(payload.conversationIdentity, "chatgpt:https://chatgpt.com/c/abc");
});

test("an interrupt omits documentId entirely when the binding has none", () => {
  const withId = interruptPayload({
    requestId: "r", agentId: "a", provider: "claude", sessionId: "s",
    tabId: 1, frameId: 0, documentId: "doc-9", documentToken: "t",
    conversationUrl: "https://claude.ai/chat/x", conversationIdentity: "claude:https://claude.ai/chat/x",
  });
  assert.equal(withId.documentId, "doc-9");
  const withoutId = interruptPayload({
    requestId: "r", agentId: "a", provider: "claude", sessionId: "s",
    tabId: 1, frameId: 0, documentToken: "t",
    conversationUrl: "https://claude.ai/chat/x", conversationIdentity: "claude:https://claude.ai/chat/x",
  });
  assert.equal("documentId" in withoutId, false, "an absent documentId must not appear as undefined");
});
