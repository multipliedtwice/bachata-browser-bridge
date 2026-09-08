export const protocolVersion = 9 as const;

export type BrowserProvider = "chatgpt" | "claude" | "generic";

export type BrowserLocalModelConfig = {
  enabled: boolean;
  backend: "auto" | "lmstudio" | "ollama";
  endpoint?: string;
  model: string;
  timeoutMs: number;
};

export type BrowserAttachment = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  dataBase64: string;
};

export type CapturedSegment = {
  type: "text" | "codeBlock" | "quote";
  text: string;
  start: number;
  end: number;
  language?: string;
};

export type BrowserAssetKind =
  | "generatedFile"
  | "artifact"
  | "canvas"
  | "image"
  | "codeArtifact";

export type BrowserAssetSourceElement = "assistantMessage" | "artifactPane";

export type CapturedAsset = {
  id: string;
  provider: BrowserProvider;
  kind: BrowserAssetKind;
  name: string;
  mimeType?: string;
  size?: number;
  sourceElement: BrowserAssetSourceElement;
  providerAssetId?: string;
  downloadAvailable: boolean;
  previewText?: string;
  sourceOrigin?: string;
};


export type BrowserSessionCapabilities = {
  submission: "verifiedSend" | "syntheticEnter" | "native";
  completion: "verifiedLifecycle" | "manualOnly" | "native";
  interruption: "confirmed" | "unavailable" | "native";
  assets: "supported" | "textOnly";
  conversationState: "confirmed" | "uncertain";
};

export type BrowserSession = {
  id: string;
  provider: BrowserProvider;
  tabId: number;
  frameId: number;
  documentId?: string;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
  title?: string;
  capabilities?: BrowserSessionCapabilities;
  status:
    | "disconnected"
    | "notAuthenticated"
    | "notReady"
    | "ready"
    | "submitting"
    | "streaming"
    | "failed";
  createdAt: string;
  updatedAt: string;
};

export type ConversationBinding = {
  requestId: string;
  agentId: string;
  provider: BrowserProvider;
  sessionId: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
};

export type ServerMessage =
  | {
      type: "bridge.paired";
      protocolVersion: 9;
      connectionToken: string;
    }
  | { type: "bridge.connected"; protocolVersion: 9 }
  | { type: "bridge.pong"; protocolVersion: 9; nonce: string }
  | ({ type: "localModel.config"; protocolVersion: 9 } & BrowserLocalModelConfig)
  | { type: "provider.discover"; protocolVersion: 9 }
  | {
      type: "provider.openConversation";
      protocolVersion: 9;
      requestId: string;
      provider: BrowserProvider;
      preferredTabId?: number;
      preferredOrigin?: string;
      preferredConversationIdentity?: string;
      fresh?: boolean;
    }
  | {
      type: "provider.cancelOpenConversation";
      protocolVersion: 9;
      requestId: string;
    }
  | ({
      type: "conversation.send";
      protocolVersion: 9;
      text: string;
      attachments: BrowserAttachment[];
      allowInitialConversationTransition: boolean;
      deadlineAt?: number;
    } & ConversationBinding)
  | ({
      type: "conversation.interrupt";
      protocolVersion: 9;
    } & ConversationBinding)
  | {
      type: "asset.fetch";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      maxBytes: number;
    }
  | {
      type: "asset.cancel";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
    }
  | {
      type: "asset.reveal";
      protocolVersion: 9;
      requestId: string;
      assetId: string;
    }
  | {
      type: "bridge.error";
      protocolVersion: 9;
      code: string;
      message: string;
    };

export type ClientMessage =
  | { type: "bridge.pair"; protocolVersion: 9; token: string }
  | {
      type: "bridge.authenticate";
      protocolVersion: 9;
      connectionToken: string;
    }
  | { type: "bridge.ping"; protocolVersion: 9; nonce: string }
  | {
      type: "provider.status";
      protocolVersion: 9;
      sessions: BrowserSession[];
      selectedSessionId?: string;
    }
  | {
      type: "provider.openConversation.result";
      protocolVersion: 9;
      requestId: string;
      provider: BrowserProvider;
      success: boolean;
      session?: BrowserSession;
      code?: string;
      message?: string;
    }
  | {
      type: "conversation.submitted";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
    }
  | {
      type: "conversation.stream";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
      mode: "append" | "replace";
      text: string;
    }
  | {
      type: "conversation.response";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
      provider: BrowserProvider;
      text: string;
      segments: CapturedSegment[];
      assets: CapturedAsset[];
      captureFormat: "renderedText";
      fidelity: "bestEffort";
      finalConversationUrl: string;
      finalConversationIdentity: string;
      finalSessionId: string;
      startedAt: string;
      completedAt: string;
    }
  | {
      type: "conversation.interrupted";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
    }
  | {
      /**
       * BB-A4-N05. The person's Stop could not be confirmed, and the turn it was aimed at is
       * still running. Nonterminal on purpose: the request keeps exactly one terminal outcome —
       * whatever the turn itself settles as — so a Stop that failed can never consume the answer
       * that was still coming.
       */
      type: "conversation.interruptFailed";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
      message: string;
    }
  | {
      type: "conversation.error";
      protocolVersion: 9;
      requestId: string;
      agentId?: string;
      sessionId?: string;
      code: string;
      message: string;
    }
  | {
      type: "asset.start";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      name: string;
      mimeType?: string;
      size?: number;
    }
  | {
      type: "asset.chunk";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      sequence: number;
      dataBase64: string;
    }
  | {
      type: "asset.complete";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      size: number;
      sha256: string;
    }
  | {
      type: "asset.error";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      code: string;
      message: string;
    }
  | {
      type: "asset.reveal.result";
      protocolVersion: 9;
      requestId: string;
      assetId: string;
      success: boolean;
      message?: string;
    }
  | { type: "bridge.disconnect"; protocolVersion: 9 };

type JsonRecord = Record<string, unknown>;

const providers = new Set<BrowserProvider>(["chatgpt", "claude", "generic"]);
const attachmentTypes = new Set<BrowserAttachment["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const hasOnlyKeys = (
  value: JsonRecord,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const validBinding = (value: JsonRecord): boolean =>
  isNonEmptyString(value.requestId) &&
  isNonEmptyString(value.agentId) &&
  providers.has(value.provider as BrowserProvider) &&
  isNonEmptyString(value.sessionId) &&
  Number.isInteger(value.tabId) &&
  Number.isInteger(value.frameId) &&
  (value.documentId === undefined || isNonEmptyString(value.documentId)) &&
  isNonEmptyString(value.documentToken) &&
  isNonEmptyString(value.conversationUrl) &&
  isNonEmptyString(value.conversationIdentity);

const validAttachment = (value: unknown): value is BrowserAttachment =>
  isRecord(value) &&
  hasOnlyKeys(value, ["name", "mimeType", "size", "dataBase64"]) &&
  isNonEmptyString(value.name) &&
  attachmentTypes.has(value.mimeType as BrowserAttachment["mimeType"]) &&
  isPositiveInteger(value.size) &&
  isNonEmptyString(value.dataBase64);

const validAssetTransferIdentity = (value: JsonRecord): boolean =>
  isNonEmptyString(value.transferId) && isNonEmptyString(value.assetId);

export const isHttpOrigin = (value: unknown): boolean => {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin === value
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
};

export const parseServerMessage = (value: unknown): ServerMessage => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.type) ||
    value.protocolVersion !== protocolVersion
  ) {
    throw new Error("Invalid Bachata Browser Bridge message");
  }

  if (value.type === "bridge.paired") {
    if (
      !hasOnlyKeys(value, ["type", "protocolVersion", "connectionToken"]) ||
      !isNonEmptyString(value.connectionToken)
    ) {
      throw new Error("Invalid bridge.paired message");
    }
    return value as ServerMessage;
  }

  if (value.type === "bridge.connected" || value.type === "provider.discover") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion"])) {
      throw new Error(`Invalid ${value.type} message`);
    }
    return value as ServerMessage;
  }

  if (value.type === "bridge.pong") {
    if (
      !hasOnlyKeys(value, ["type", "protocolVersion", "nonce"]) ||
      !isNonEmptyString(value.nonce)
    ) {
      throw new Error("Invalid bridge.pong message");
    }
    return value as ServerMessage;
  }

  if (value.type === "localModel.config") {
    if (
      !hasOnlyKeys(value, ["type", "protocolVersion", "enabled", "backend", "endpoint", "model", "timeoutMs"]) ||
      typeof value.enabled !== "boolean" ||
      (value.backend !== "auto" && value.backend !== "lmstudio" && value.backend !== "ollama") ||
      (value.endpoint !== undefined && typeof value.endpoint !== "string") ||
      !isNonEmptyString(value.model) ||
      !isPositiveInteger(value.timeoutMs)
    ) {
      throw new Error("Invalid localModel.config message");
    }
    return value as ServerMessage;
  }

  if (value.type === "provider.openConversation") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "provider",
        "preferredTabId",
        "preferredOrigin",
        "preferredConversationIdentity",
        "fresh",
      ]) ||
      !isNonEmptyString(value.requestId) ||
      !providers.has(value.provider as BrowserProvider) ||
      (value.preferredTabId !== undefined
        && (!Number.isInteger(value.preferredTabId) || Number(value.preferredTabId) <= 0)) ||
      (value.preferredOrigin !== undefined && !isHttpOrigin(value.preferredOrigin)) ||
      (value.preferredConversationIdentity !== undefined
        && (!isNonEmptyString(value.preferredConversationIdentity) || value.preferredConversationIdentity.length > 16_384)) ||
      (value.fresh !== undefined && typeof value.fresh !== "boolean")
    ) {
      throw new Error("Invalid provider.openConversation message");
    }
    return value as ServerMessage;
  }

  if (value.type === "provider.cancelOpenConversation") {
    if (
      !hasOnlyKeys(value, ["type", "protocolVersion", "requestId"]) ||
      !isNonEmptyString(value.requestId)
    ) {
      throw new Error("Invalid provider.cancelOpenConversation message");
    }
    return value as ServerMessage;
  }

  if (value.type === "conversation.send") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "agentId",
        "provider",
        "sessionId",
        "tabId",
        "frameId",
        "documentId",
        "documentToken",
        "conversationUrl",
        "conversationIdentity",
        "text",
        "attachments",
        "allowInitialConversationTransition",
        "deadlineAt",
      ]) ||
      !validBinding(value) ||
      typeof value.text !== "string" ||
      !Array.isArray(value.attachments) ||
      value.attachments.some((attachment) => !validAttachment(attachment)) ||
      typeof value.allowInitialConversationTransition !== "boolean" ||
      (value.deadlineAt !== undefined
        && (!Number.isSafeInteger(value.deadlineAt) || Number(value.deadlineAt) <= 0))
    ) {
      throw new Error("Invalid conversation.send message");
    }
    return value as ServerMessage;
  }

  if (value.type === "conversation.interrupt") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "agentId",
        "provider",
        "sessionId",
        "tabId",
        "frameId",
        "documentId",
        "documentToken",
        "conversationUrl",
        "conversationIdentity",
      ]) ||
      !validBinding(value)
    ) {
      throw new Error("Invalid conversation.interrupt message");
    }
    return value as ServerMessage;
  }

  if (value.type === "asset.fetch") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "transferId",
        "assetId",
        "maxBytes",
      ]) ||
      !validAssetTransferIdentity(value) ||
      !isPositiveInteger(value.maxBytes)
    ) {
      throw new Error("Invalid asset.fetch message");
    }
    return value as ServerMessage;
  }

  if (value.type === "asset.cancel") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "transferId",
        "assetId",
      ]) ||
      !validAssetTransferIdentity(value)
    ) {
      throw new Error("Invalid asset.cancel message");
    }
    return value as ServerMessage;
  }

  if (value.type === "asset.reveal") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "assetId",
      ]) ||
      !isNonEmptyString(value.requestId) ||
      !isNonEmptyString(value.assetId)
    ) {
      throw new Error("Invalid asset.reveal message");
    }
    return value as ServerMessage;
  }

  if (value.type === "bridge.error") {
    if (
      !hasOnlyKeys(value, ["type", "protocolVersion", "code", "message"]) ||
      !isNonEmptyString(value.code) ||
      !isNonEmptyString(value.message)
    ) {
      throw new Error("Invalid bridge.error message");
    }
    return value as ServerMessage;
  }

  throw new Error(`Unsupported bridge message type: ${value.type}`);
};
