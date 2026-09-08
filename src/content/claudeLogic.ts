// Claude's configuration of the shared provider logic. The implementation lives in
// providerLogic.ts, which is injected immediately before this file; only the transition rule
// and the provider's own name ever differed between the two providers.

type BachataClaudeGlobal = typeof globalThis & {
  __pairClaudeLogic?: BachataProviderLogic;
  __pairProviderLogic?: (config: BachataProviderConfig) => BachataProviderLogic;
};

const bachataClaudeGlobal = globalThis as BachataClaudeGlobal;
const createClaudeLogic = bachataClaudeGlobal.__pairProviderLogic;
if (!createClaudeLogic) {
  throw new Error("Bachata provider logic was not initialized before the Claude adapter");
}

bachataClaudeGlobal.__pairClaudeLogic = createClaudeLogic({
  provider: "claude",
  label: "Claude",
  origin: "https://claude.ai",
  freshPathnames: ["/", "/new"],
  conversationPathPrefixes: ["/chat/", "/chats/"],
});
