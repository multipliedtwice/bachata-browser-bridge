import { bindCurrentGenericTab, ensureGenericContentScript, genericRegistrations, genericStatus, handleGenericContentMessage, handleGenericContextMenu, handleGenericProfileStorageMessage, isGenericTab, registerGenericContextMenus, removeGenericRegistration, restoreGenericRegistrations, sendGenericCommand, storedGenericProfileOrigins } from "./genericProvider.js";
import { handleLocalModelPromptMessage, setLocalModelConfig } from "./localModelProxy.js";
import { handleQuarantineMessage } from "./quarantine.js";
import { handleGenericManagementMessage } from "./genericProvider.js";
import { createPopupRecoveryStore } from "./popupRecovery.js";
import {
  BrowserProvider,
  BrowserSession,
  CapturedAsset,
  CapturedSegment,
  ClientMessage,
  ConversationBinding,
  parseServerMessage,
  protocolVersion,
  ServerMessage,
} from "../protocol/types.js";
import {
  canonicalConversationUrl,
  interruptPayload,
  conversationIdentityFor,
  isSupportedInitialTransition,
  providerForUrl,
  sessionIdForConversation,
  utf8ByteLength,
} from "./conversation.js";
import {
  createRevisionQueue,
  createSnapshotWriteQueue,
} from "./serializedState.js";
import { createRequestOrdering } from "./requestOrdering.js";
import { createProvisioningQueue } from "./provisioning.js";
import { normalizeBridgeEndpoint } from "./endpoint.js";
import {
  createNavigationTracker,
  navigationDetailsToEvent,
  type ChromeNavigationEvent,
} from "./navigationEvents.js";
import {
  clearReconnectWakeup,
  nextReconnectMetadata,
  persistedReconnectAttempt,
  reconnectAlarmName,
  scheduleReconnectWakeup,
  shouldRestoreReconnect,
} from "./reconnect.js";
import { abortError, throwIfAborted } from "./cancellation.js";
import {
  projectPopupState,
  projectPopupTabs,
  type PopupState,
  type PopupTab,
  type ProviderTab,
} from "./popupProjection.js";
import {
  assetFetchAckRejected,
  assetOrderAfterRegistration,
  parseAssetChunk,
  parseAssetCompletion,
  parseAssetStart,
} from "./assetTransfer.js";
import { admitAssetFetch } from "./assetAdmission.js";
import {
  genericTabChangeVerdict,
  probedTabSupported,
  providerTabUrlVerdict,
  refreshAfterTabChange,
  tabSupportProbeNeeded,
} from "./tabChange.js";
import {
  awaitGenericSession,
  awaitLoadedProviderTab,
  awaitProviderSession,
  freshGenericVerdict,
  openedSessionRefusal,
  selectGenericSession,
} from "./provisioningWaits.js";
import {
  isIsoDate,
  strictBase64Bytes,
  validCapturedAssets,
  validCapturedSegments,
} from "./capturedPayload.js";
import {
  activeRequestMatchesSender,
  admitInitialTransition,
  bindingIsLiveOnTab,
  bindingMatchesSession,
  contentStatusMatchesBinding,
  genericStatusMatchesAttestation,
  sessionForAttestation,
  interruptMatchesRequest,
  legacyStorageKeys,
  migratedStoredCandidate,
  normalizedHandledTabIds,
  popupStatusReason,
  providerStartUrl,
  sameDocumentBinding,
  senderBinding,
  sessionIdFor,
  storageKey,
  storedStateFrom,
  withHandledTabs,
  withoutHandledTab,
  type ActiveRequest,
  type DocumentBinding,
  type StoredState,
} from "./routerState.js";

type RegisteredAsset = {
  asset: CapturedAsset;
  binding: DocumentBinding;
};

type ActiveAssetTransfer = {
  transferId: string;
  assetId: string;
  binding: DocumentBinding;
  maxBytes: number;
  receivedBytes: number;
  nextSequence: number;
  started: boolean;
  declaredSize?: number | undefined;
};

type ContentStatus = {
  status: string;
  documentToken?: string;
  conversationUrl?: string;
  conversationIdentity?: string;
  conversationState?: "confirmed" | "uncertain";
};

type ContentAck = {
  success: boolean;
  error?: string;
  accepted?: boolean;
  registered?: boolean;
};

type ProvisioningInput = {
  provider: BrowserProvider;
  eventSocket: WebSocket;
  preferredTabId?: number;
  preferredOrigin?: string;
  preferredConversationIdentity?: string;
  fresh?: boolean;
};

type ProvisioningResult = {
  provider: BrowserProvider;
  success: boolean;
  session?: BrowserSession;
  code?: string;
  message?: string;
};

const maximumMessageBytes = 83_886_080;
const maximumRegisteredAssets = 500;
const maximumConcurrentProvisioning = 2;
const maximumProvisioningResults = 128;
const failedProvisioningTabPolicy = "retain" as const;
const providerStatuses = new Set<BrowserSession["status"]>([
  "disconnected",
  "notAuthenticated",
  "notReady",
  "ready",
  "submitting",
  "streaming",
  "failed",
]);

let stored: StoredState = {};
let socket: WebSocket | undefined;
let connected = false;
let connecting = false;
let error: string | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let keepAliveTimer: number | undefined;
let keepAliveDeadlineTimer: number | undefined;
let pendingKeepAliveNonce: string | undefined;
let pairingToken: string | undefined;
let reconnectAttempt = 0;
let retryInMs: number | undefined;
const documentsByTab = new Map<number, DocumentBinding>();
const sessionCreatedAt = new Map<string, string>();
const activeRequests = new Map<string, ActiveRequest>();
const popupRecoveryStore = createPopupRecoveryStore();
const rememberRecovery = popupRecoveryStore.remember;
const activeRequestBySession = new Map<string, string>();
const assetsById = new Map<string, RegisteredAsset>();
const assetOrder: string[] = [];
const activeAssetTransfers = new Map<string, ActiveAssetTransfer>();
const requestOrdering = createRequestOrdering();
const { pendingInterrupts } = requestOrdering;
let providerStatusRevision = 0;
let providerStatusQueue = Promise.resolve();
const popupQueue = createRevisionQueue();
const storageWrites = createSnapshotWriteQueue<StoredState>(
  structuredClone,
  (snapshot) => chrome.storage.local.set({ [storageKey]: snapshot }),
);
const popupMutationTypes = new Set([
  "popup.pair",
  "popup.select",
  "popup.deselect",
  "popup.discover",
  "popup.reconnect",
  "popup.disconnect",
  "popup.recover",
]);

const loadStored = async (): Promise<void> => {
  const value = await chrome.storage.local.get([storageKey, ...legacyStorageKeys]);
  const current = value[storageKey];
  const candidate = migratedStoredCandidate(
    current,
    legacyStorageKeys.map((key) => value[key]),
  );
  const normalized = storedStateFrom(candidate);
  stored = normalized.state;
  if (normalized.invalidEndpoint) {
    error = "The saved bridge endpoint was invalid and has been cleared";
  }
  if (JSON.stringify(current ?? {}) !== JSON.stringify(stored)) {
    await chrome.storage.local.set({ [storageKey]: structuredClone(stored) });
  }
};

const saveStored = (): Promise<void> => storageWrites.enqueue(stored);

const serializeClientMessage = (message: ClientMessage): string => {
  const serialized = JSON.stringify(message);
  if (utf8ByteLength(serialized) > maximumMessageBytes) {
    throw new Error("Browser bridge message exceeds the transport limit");
  }
  return serialized;
};

const sendSocket = (message: ClientMessage): void => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Browser bridge is not connected");
  }
  socket.send(serializeClientMessage(message));
};

const rememberHandledTabs = (tabIds: number[]): void => {
  stored.handledTabIds = withHandledTabs(stored, tabIds);
};

const forgetHandledTab = (tabId: number): void => {
  stored.handledTabIds = withoutHandledTab(stored, tabId);
};

const queryTabs = async (): Promise<ProviderTab[]> => {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://claude.ai/*"],
  });
  const byId = new Map<number, ProviderTab>();
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || typeof tab.url !== "string") {
      continue;
    }
    const provider = providerForUrl(tab.url);
    if (!provider) {
      continue;
    }
    byId.set(tab.id as number, {
      id: tab.id as number,
      provider,
      title: typeof tab.title === "string" ? tab.title : tab.url,
      url: tab.url,
    });
  }
  const genericTabs = await Promise.all(
    genericRegistrations().map(async (registration) => {
      const tab = await chrome.tabs.get(registration.tabId).catch(() => undefined);
      if (!tab || typeof tab.url !== "string" || byId.has(registration.tabId)) {
        return undefined;
      }
      try {
        if (new URL(tab.url).origin !== registration.origin) {
          return undefined;
        }
      } catch {
        return undefined;
      }
      return {
        id: registration.tabId,
        provider: "generic" as const,
        title: typeof tab.title === "string" ? tab.title : registration.title,
        url: tab.url,
      };
    }),
  );
  for (const tab of genericTabs) {
    if (tab) {
      byId.set(tab.id, tab);
    }
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

const contentTarget = (
  binding: DocumentBinding,
): chrome.tabs.MessageSendOptions => ({
  frameId: binding.frameId,
  ...(binding.documentId ? { documentId: binding.documentId } : {}),
});

const sendContentMessage = async <T>(
  binding: DocumentBinding,
  message: unknown,
): Promise<T> =>
  chrome.tabs.sendMessage(binding.tabId, message, contentTarget(binding));

const waitForDocumentRegistration = async (
  tabId: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (documentsByTab.has(tabId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return documentsByTab.has(tabId);
};

const ensureContentScript = async (tabId: number): Promise<void> => {
  const tab = await chrome.tabs.get(tabId);
  const provider = typeof tab.url === "string" ? providerForUrl(tab.url) : undefined;
  if (!provider) {
    throw new Error("The selected tab is not a supported browser provider");
  }
  const existing = documentsByTab.get(tabId);
  if (existing?.provider === provider) {
    try {
      await sendContentMessage(existing, { type: "provider.status" });
      return;
    } catch {
      documentsByTab.delete(tabId);
    }
  }

  try {
    const response = await chrome.tabs.sendMessage<ContentAck>(
      tabId,
      { type: "content.reregister" },
      { frameId: 0 },
    );
    if (response.success && (await waitForDocumentRegistration(tabId, 1_000))) {
      return;
    }
  } catch {
    documentsByTab.delete(tabId);
  }

  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files:
      provider === "chatgpt"
        ? [
            "content/assetLogic.js",
            "content/providerControls.js",
            "content/domHealing.js",
            "content/providerLogic.js",
            "content/chatgptLogic.js",
            "content/chatgpt.js",
          ]
        : [
            "content/assetLogic.js",
            "content/providerControls.js",
            "content/domHealing.js",
            "content/providerLogic.js",
            "content/claudeLogic.js",
            "content/claude.js",
          ],
    world: "ISOLATED",
  });
  if (await waitForDocumentRegistration(tabId, 5_000)) {
    return;
  }
  throw new Error("The browser provider page did not register with Bachata");
};

const contentStatus = async (
  binding: DocumentBinding,
): Promise<ContentStatus> => {
  try {
    return await sendContentMessage<ContentStatus>(binding, {
      type: "provider.status",
    });
  } catch {
    return { status: "notReady" };
  }
};

const buildGenericSessions = async (now: string): Promise<BrowserSession[]> => {
  const registrations = genericRegistrations();
  const statuses = await Promise.allSettled(
    registrations.map((registration) => genericStatus(registration.tabId)),
  );
  const sessions: BrowserSession[] = [];
  registrations.forEach((registration, index) => {
    const result = statuses[index];
    if (!result || result.status !== "fulfilled") {
      return;
    }
    const status = result.value;
    let conversationUrl: string;
    let origin: string;
    try {
      conversationUrl = canonicalConversationUrl("generic", status.url);
      origin = new URL(conversationUrl).origin;
    } catch {
      return;
    }
    if (status.origin !== origin || status.origin !== registration.origin) {
      return;
    }
    const conversationIdentity = conversationIdentityFor("generic", conversationUrl);
    if (status.documentToken !== registration.documentToken) {
      return;
    }
    const documentToken = status.documentToken;
    const id = sessionIdForConversation(
      "generic",
      registration.tabId,
      documentToken,
      conversationIdentity,
    );
    const createdAt = sessionCreatedAt.get(id) ?? now;
    sessionCreatedAt.set(id, createdAt);
    sessions.push({
      id,
      provider: "generic",
      tabId: registration.tabId,
      frameId: registration.frameId,
      documentToken,
      conversationUrl,
      conversationIdentity,
      title: status.title || registration.title,
      capabilities: status.capabilities,
      status: status.status,
      createdAt,
      updatedAt: now,
    });
  });
  return sessions;
};

const buildSessions = async (
  tabs?: ProviderTab[],
): Promise<BrowserSession[]> => {
  const availableTabs = tabs ?? await queryTabs();
  const tabById = new Map(availableTabs.map((tab) => [tab.id, tab]));
  const now = new Date().toISOString();
  const candidates = Array.from(documentsByTab.values())
    .filter((binding) => bindingIsLiveOnTab(binding, tabById.get(binding.tabId)))
    .sort((left, right) => left.tabId - right.tabId);
  const statuses = await Promise.allSettled(candidates.map(contentStatus));
  const sessions: BrowserSession[] = [];
  candidates.forEach((binding, index) => {
    const result = statuses[index];
    if (!result || result.status !== "fulfilled") {
      return;
    }
    const status = result.value;
    if (!contentStatusMatchesBinding(status, binding, providerStatuses)) {
      return;
    }
    const id = sessionIdFor(binding);
    const createdAt = sessionCreatedAt.get(id) ?? now;
    sessionCreatedAt.set(id, createdAt);
    const tab = tabById.get(binding.tabId);
    sessions.push({
      id,
      provider: binding.provider,
      tabId: binding.tabId,
      frameId: binding.frameId,
      ...(binding.documentId ? { documentId: binding.documentId } : {}),
      documentToken: binding.documentToken,
      conversationUrl: binding.conversationUrl,
      conversationIdentity: binding.conversationIdentity,
      ...(tab?.title ? { title: tab.title } : {}),
      capabilities: {
        submission: "native",
        completion: "native",
        interruption: "native",
        assets: "supported",
        conversationState: status.conversationState === "uncertain" ? "uncertain" : "confirmed",
      },
      status: status.status as BrowserSession["status"],
      createdAt,
      updatedAt: now,
    });
  });
  sessions.push(...await buildGenericSessions(now));
  sessions.sort((left, right) => left.tabId - right.tabId);
  const validIds = new Set(sessions.map((session) => session.id));
  Array.from(sessionCreatedAt.keys()).forEach((id) => {
    if (!validIds.has(id)) {
      sessionCreatedAt.delete(id);
    }
  });
  return sessions;
};

const hasActiveInitialTransition = (tabId: number | undefined): boolean =>
  tabId !== undefined &&
  Array.from(activeRequests.values()).some(
    (request) =>
      request.tabId === tabId && request.allowInitialConversationTransition,
  );

const publishProviderStatus = async (revision: number): Promise<void> => {
  if (!connected || revision !== providerStatusRevision) {
    return;
  }
  const sessions = await buildSessions();
  if (!connected || revision !== providerStatusRevision) {
    return;
  }
  const selected = sessions.find(
    (session) => session.id === stored.selectedSessionId,
  );
  if (
    stored.selectedSessionId &&
    !selected &&
    hasActiveInitialTransition(stored.selectedTabId)
  ) {
    return;
  }
  if (stored.selectedSessionId && !selected) {
    stored.selectedSessionId = undefined;
    stored.selectedTabId = undefined;
    await saveStored();
    if (!connected || revision !== providerStatusRevision) {
      return;
    }
  }
  sendSocket({
    type: "provider.status",
    protocolVersion,
    sessions,
    ...(selected ? { selectedSessionId: selected.id } : {}),
  });
};

const sendProviderStatus = (): Promise<void> => {
  const revision = ++providerStatusRevision;
  const operation = providerStatusQueue.then(() =>
    publishProviderStatus(revision),
  );
  providerStatusQueue = operation.catch(() => undefined);
  return operation;
};

const refreshProviderStatus = (): void => {
  void sendProviderStatus().catch((cause) => {
    error = cause instanceof Error ? cause.message : String(cause);
  });
};

const discoverProviderTabs = async (): Promise<void> => {
  const tabs = await queryTabs();
  rememberHandledTabs(tabs.map((tab) => tab.id));
  await saveStored();
  await Promise.allSettled(tabs.map((tab) =>
    tab.provider === "generic" ? ensureGenericContentScript(tab.id) : ensureContentScript(tab.id),
  ));
  await sendProviderStatus();
};

const closeCreatedTab = async (tabId: number): Promise<void> => {
  forgetHandledTab(tabId);
  await Promise.allSettled([chrome.tabs.remove(tabId), saveStored()]);
};

const provisionProviderConversation = async (
  input: ProvisioningInput,
  signal: AbortSignal,
): Promise<ProvisioningResult> => {
  const { provider, preferredTabId, preferredOrigin, preferredConversationIdentity, fresh = false } = input;
  let createdTabId: number | undefined;
  try {
    throwIfAborted(signal);
    if (provider === "generic") {
      const readySessions = (await buildSessions()).filter(
        (session) => session.provider === "generic" && session.status === "ready",
      );
      const selection = selectGenericSession({
        readySessions,
        ...(preferredOrigin === undefined ? {} : { preferredOrigin }),
        ...(preferredTabId === undefined ? {} : { preferredTabId }),
        ...(preferredConversationIdentity === undefined ? {} : { preferredConversationIdentity }),
      });
      const selected = selection.session;
      if (selected === undefined) {
        return { provider, success: false, ...selection.refusal };
      }
      if (!fresh) return { provider, success: true, session: selected };
      throwIfAborted(signal);
      await ensureGenericContentScript(selected.tabId);
      let commandResult: unknown;
      let commandError: unknown;
      try {
        commandResult = await sendGenericCommand(selected.tabId, {
          type: "BACHATA_GENERIC_NEW_CONVERSATION",
        }, { ensureContent: false });
      } catch (error) {
        commandError = error;
      }
      throwIfAborted(signal);
      let session: BrowserSession | undefined;
      try {
        await ensureGenericContentScript(selected.tabId);
        session = await awaitGenericSession({
          readSessions: buildSessions,
          tabId: selected.tabId,
          timeoutMs: 20_000,
          signal,
        });
      } catch (error) {
        commandError ??= error;
      }
      const verdict = freshGenericVerdict({ selected, session, commandResult, commandError });
      if (verdict.session === undefined) {
        return { provider, success: false, ...verdict.refusal };
      }
      return { provider, success: true, session: verdict.session };
    }
    if (fresh && preferredTabId !== undefined) {
      const reusable = await chrome.tabs.get(preferredTabId).catch(() => undefined);
      // BB-A4-F10. The signal is read again here because the lookup is an await: a Disconnect
      // that lands while it is open cancelled the queue, and the resumed operation navigated the
      // person's tab anyway. This one reading is the whole window's guard: nothing below it
      // awaits before either branch acts, so it covers the fallback creation as well as the
      // navigation, and removing it lets both act after cancellation.
      throwIfAborted(signal);
      if (typeof reusable?.url === "string" && providerForUrl(reusable.url) === provider) {
        await chrome.tabs.update(preferredTabId, { url: providerStartUrl(provider), active: false });
        rememberHandledTabs([preferredTabId]);
        await saveStored();
        await awaitLoadedProviderTab({
          read: () => chrome.tabs.get(preferredTabId),
          provider,
          timeoutMs: 20_000,
          signal,
        });
        throwIfAborted(signal);
        await ensureContentScript(preferredTabId);
        const session = await awaitProviderSession({
          readSessions: buildSessions,
          tabId: preferredTabId,
          provider,
          timeoutMs: 20_000,
          signal,
        });
        throwIfAborted(signal);
        await sendProviderStatus();
        const refusal = openedSessionRefusal({
          session,
          recycled: true,
          ...(preferredConversationIdentity === undefined ? {} : { preferredConversationIdentity }),
        });
        if (refusal) {
          return { provider, success: false, ...refusal };
        }
        return { provider, success: true, session };
      }
    }
    const tab = await chrome.tabs.create({
      url: providerStartUrl(provider),
      active: false,
    });
    if (!Number.isInteger(tab.id)) {
      throw new Error("Chrome did not return a tab identifier");
    }
    createdTabId = tab.id as number;
    rememberHandledTabs([createdTabId]);
    await saveStored();
    await awaitLoadedProviderTab({
      read: () => chrome.tabs.get(createdTabId as number),
      provider,
      timeoutMs: 20_000,
      signal,
    });
    throwIfAborted(signal);
    await ensureContentScript(createdTabId);
    const session = await awaitProviderSession({
      readSessions: buildSessions,
      tabId: createdTabId,
      provider,
      timeoutMs: 20_000,
      signal,
    });
    throwIfAborted(signal);
    await sendProviderStatus();
    const openedRefusal = openedSessionRefusal({ session, recycled: false });
    if (openedRefusal) {
      return { provider, success: false, ...openedRefusal };
    }
    return { provider, success: true, session };
  } catch (cause) {
    if (signal.aborted) {
      if (createdTabId !== undefined) {
        await closeCreatedTab(createdTabId);
      }
      throw abortError();
    }
    if (createdTabId !== undefined && failedProvisioningTabPolicy === "retain") {
      rememberHandledTabs([createdTabId]);
      await saveStored();
    }
    return {
      provider,
      success: false,
      code: "OPEN_CONVERSATION_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

const completedProvisioningResults = new Map<string, ProvisioningResult>();
const completedProvisioningOrder: string[] = [];

const rememberProvisioningResult = (
  requestId: string,
  result: ProvisioningResult,
): void => {
  completedProvisioningResults.set(requestId, structuredClone(result));
  completedProvisioningOrder.push(requestId);
  while (completedProvisioningOrder.length > maximumProvisioningResults) {
    const oldest = completedProvisioningOrder.shift();
    if (oldest) {
      completedProvisioningResults.delete(oldest);
    }
  }
};

const sendProvisioningResult = (
  eventSocket: WebSocket,
  requestId: string,
  result: ProvisioningResult,
): void => {
  if (eventSocket !== socket || eventSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  sendSocket({
    type: "provider.openConversation.result",
    protocolVersion,
    requestId,
    ...result,
  });
};

const provisioningQueue = createProvisioningQueue<
  ProvisioningInput,
  ProvisioningResult
>({
  maxConcurrent: maximumConcurrentProvisioning,
  run: (_requestId, input, signal) =>
    provisionProviderConversation(input, signal),
  settle: (requestId, input, outcome) => {
    const result: ProvisioningResult =
      outcome.status === "completed"
        ? outcome.result
        : outcome.status === "cancelled"
          ? {
              provider: input.provider,
              success: false,
              code: "PROVISIONING_CANCELLED",
              message: "Opening the provider conversation was cancelled",
            }
          : {
              provider: input.provider,
              success: false,
              code: "OPEN_CONVERSATION_FAILED",
              message: outcome.error.message,
            };
    rememberProvisioningResult(requestId, result);
    sendProvisioningResult(input.eventSocket, requestId, result);
  },
});

const enqueueProviderProvisioning = (
  requestId: string,
  provider: BrowserProvider,
  eventSocket: WebSocket,
  options: Pick<ProvisioningInput, "preferredTabId" | "preferredOrigin" | "preferredConversationIdentity" | "fresh"> = {},
): void => {
  const completed = completedProvisioningResults.get(requestId);
  if (completed) {
    sendProvisioningResult(eventSocket, requestId, completed);
    return;
  }
  provisioningQueue.enqueue(requestId, { provider, eventSocket, ...options });
};

const reconnectAlarms = (): typeof chrome.alarms | undefined =>
  (chrome as typeof chrome & { alarms?: typeof chrome.alarms }).alarms;

const clearReconnectTimer = (): void => {
  clearReconnectWakeup(reconnectTimer, reconnectAlarms());
  reconnectTimer = undefined;
  retryInMs = undefined;
};

const clearReconnectPersistence = (): void => {
  stored.reconnectAttempt = undefined;
  stored.reconnectAt = undefined;
};

const clearKeepAliveTimer = (): void => {
  if (keepAliveTimer !== undefined) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
  if (keepAliveDeadlineTimer !== undefined) {
    clearTimeout(keepAliveDeadlineTimer);
    keepAliveDeadlineTimer = undefined;
  }
  pendingKeepAliveNonce = undefined;
};

const removeAssetsForTab = (tabId: number): void => {
  for (const [assetId, registered] of assetsById) {
    if (registered.binding.tabId === tabId) {
      assetsById.delete(assetId);
    }
  }
  for (let index = assetOrder.length - 1; index >= 0; index -= 1) {
    const assetId = assetOrder[index];
    if (assetId !== undefined && !assetsById.has(assetId)) {
      assetOrder.splice(index, 1);
    }
  }
  for (const transfer of Array.from(activeAssetTransfers.values())) {
    if (transfer.binding.tabId !== tabId) {
      continue;
    }
    activeAssetTransfers.delete(transfer.transferId);
    sendAssetError(
      transfer.transferId,
      transfer.assetId,
      "ASSET_DOCUMENT_CHANGED",
      "The browser document that produced the asset has changed",
    );
    void sendContentMessage(transfer.binding, {
      type: "asset.cancel",
      transferId: transfer.transferId,
      assetId: transfer.assetId,
    }).catch(() => undefined);
  }
};

const registerAssets = (
  binding: DocumentBinding,
  assets: CapturedAsset[],
): void => {
  for (const asset of assets) {
    assetsById.set(asset.id, { asset, binding: { ...binding } });
  }
  const next = assetOrderAfterRegistration(
    assetOrder,
    assets.map((asset) => asset.id),
    maximumRegisteredAssets,
  );
  assetOrder.splice(0, assetOrder.length, ...next.order);
  for (const assetId of next.evicted) {
    assetsById.delete(assetId);
  }
};

const recoverRegisteredAsset = async (
  assetId: string,
): Promise<RegisteredAsset | undefined> => {
  const existing = assetsById.get(assetId);
  if (existing) {
    return existing;
  }
  const candidates = await Promise.all(
    Array.from(documentsByTab.values()).map(async (binding) => {
      try {
        const result = await sendContentMessage<{
          success?: boolean;
          asset?: CapturedAsset;
        }>(binding, { type: "asset.probe", assetId });
        if (
          result?.success !== true ||
          !result.asset ||
          result.asset.id !== assetId ||
          !validCapturedAssets(binding.provider, [result.asset])
        ) {
          return undefined;
        }
        return { asset: result.asset, binding: { ...binding } };
      } catch {
        return undefined;
      }
    }),
  );
  const matches = candidates.filter(
    (candidate): candidate is RegisteredAsset => Boolean(candidate),
  );
  if (matches.length !== 1) {
    return undefined;
  }
  const match = matches[0];
  if (!match) return undefined;
  registerAssets(match.binding, [match.asset]);
  return match;
};


const sendAssetError = (
  transferId: string,
  assetId: string,
  code: string,
  message: string,
): void => {
  if (!connected) {
    return;
  }
  sendSocket({
    type: "asset.error",
    protocolVersion,
    transferId,
    assetId,
    code,
    message,
  });
};

const cancelAssetTransfer = async (
  transfer: ActiveAssetTransfer,
): Promise<void> => {
  activeAssetTransfers.delete(transfer.transferId);
  await sendContentMessage(transfer.binding, {
    type: "asset.cancel",
    transferId: transfer.transferId,
    assetId: transfer.assetId,
  }).catch(() => undefined);
};

const stopActiveAssetTransfers = async (): Promise<void> => {
  const transfers = Array.from(activeAssetTransfers.values());
  activeAssetTransfers.clear();
  await Promise.allSettled(
    transfers.map((transfer) =>
      sendContentMessage(transfer.binding, {
        type: "asset.cancel",
        transferId: transfer.transferId,
        assetId: transfer.assetId,
      }),
    ),
  );
};

const runScheduledReconnect = (): void => {
  clearReconnectTimer();
  stored.reconnectAt = undefined;
  stored.reconnectAttempt = persistedReconnectAttempt(reconnectAttempt);
  void saveStored().catch((cause) => {
    error = cause instanceof Error ? cause.message : String(cause);
  });
  void connect();
};

const scheduleReconnectAt = (when: number): void => {
  clearReconnectTimer();
  const wakeup = scheduleReconnectWakeup(when, runScheduledReconnect, reconnectAlarms());
  reconnectTimer = wakeup.timer;
  retryInMs = wakeup.retryInMs;
};

const scheduleReconnect = (): void => {
  if (
    !stored.endpoint ||
    !stored.connectionToken ||
    reconnectTimer !== undefined ||
    stored.reconnectAt !== undefined
  ) {
    return;
  }
  const next = nextReconnectMetadata(reconnectAttempt);
  reconnectAttempt = next.reconnectAttempt;
  stored.reconnectAttempt = next.reconnectAttempt;
  stored.reconnectAt = next.reconnectAt;
  void saveStored().catch((cause) => {
    error = cause instanceof Error ? cause.message : String(cause);
  });
  scheduleReconnectAt(next.reconnectAt);
};

const removeActiveRequest = (requestId: string): ActiveRequest | undefined => {
  const request = activeRequests.get(requestId);
  if (!request) {
    return undefined;
  }
  activeRequests.delete(requestId);
  if (activeRequestBySession.get(request.sessionId) === requestId) {
    activeRequestBySession.delete(request.sessionId);
  }
  return request;
};

const acknowledgeInterrupted = (
  request: ActiveRequest,
  preservePending = false,
): void => {
  // BB-A4-N05. The person's Stop won, so an answer held for this request is dropped here and
  // nowhere else. Dropping it before the early returns keeps the rule total.
  requestOrdering.takeCompletion(request.requestId);
  if (!preservePending) {
    pendingInterrupts.delete(request.requestId);
  }
  if (!removeActiveRequest(request.requestId)) {
    return;
  }
  rememberRecovery(request, "stopped");
  if (!connected) {
    return;
  }
  sendSocket({
    type: "conversation.interrupted",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: request.sessionId,
  });
};

const sendConversationError = (
  request: ActiveRequest,
  code: string,
  message: string,
): void => {
  rememberRecovery(request, code === "SESSION_CHANGED" ? "binding"
    : code === "INVALID_RESPONSE" || code === "RESPONSE_TOO_LARGE" ? "capture" : "failure");
  if (!connected) {
    return;
  }
  sendSocket({
    type: "conversation.error",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    code,
    message,
  });
};

/**
 * BB-A4-N05. A Stop that could not be confirmed, said without ending the request.
 *
 * Reporting it as `conversation.error` made the failed Stop the request's terminal outcome, and
 * the controller removed the pending operation on it — so the answer the turn was still about to
 * produce arrived to nothing and was dropped. The turn is still running and still owns its own
 * single terminal frame; this only says the Stop did not take.
 */
const sendInterruptFailed = (request: ActiveRequest, message: string): void => {
  rememberRecovery(request, "stopUnconfirmed");
  if (!connected) {
    return;
  }
  sendSocket({
    type: "conversation.interruptFailed",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    message,
  });
};

const failRequestsForTab = (tabId: number, message: string): void => {
  removeAssetsForTab(tabId);
  Array.from(activeRequests.values())
    .filter((request) => request.tabId === tabId)
    .forEach((request) => {
      sendConversationError(request, "SESSION_CHANGED", message);
      removeActiveRequest(request.requestId);
    });
};

const stopActiveRequests = async (): Promise<void> => {
  const requests = Array.from(activeRequests.values());
  requests.forEach((request) => removeActiveRequest(request.requestId));
  await Promise.allSettled(
    requests.map((request) =>
      request.provider === "generic"
        ? sendGenericCommand(request.tabId, {
            type: "BACHATA_GENERIC_CANCEL",
            requestId: request.requestId,
          })
        : sendContentMessage(request, interruptPayload(request)),
    ),
  );
};

const exactSession = async (
  binding: ConversationBinding,
): Promise<BrowserSession | undefined> => {
  const sessions = await buildSessions();
  return sessions.find(
    (session) =>
      session.id === binding.sessionId &&
      bindingMatchesSession(binding, session),
  );
};

type GenericConversationAttestation = {
  documentToken: string;
  documentRevision: number;
  conversationUrl: string;
  conversationIdentity: string;
};

const genericSessionForAttestation = async (
  tabId: number,
  attestation: GenericConversationAttestation,
  state: "provisional" | "confirmed",
): Promise<BrowserSession> => {
  const status = await genericStatus(tabId);
  const conversationUrl = canonicalConversationUrl("generic", status.url);
  const conversationIdentity = conversationIdentityFor("generic", conversationUrl);
  if (!genericStatusMatchesAttestation(status, conversationUrl, conversationIdentity, attestation)) {
    throw new Error("The generic browser document or conversation changed after response capture");
  }
  const session = sessionForAttestation(await buildSessions(), tabId, attestation, state);
  if (!session) {
    throw new Error(state === "confirmed"
      ? "The generic browser conversation did not become reusable after final attestation"
      : "The generic browser response was not followed by a provisionally quarantined conversation state");
  }
  return session;
};

const confirmGenericConversationReuse = async (
  requestId: string,
  tabId: number,
  attestation: GenericConversationAttestation,
): Promise<BrowserSession> => {
  const result = await sendGenericCommand(tabId, {
    type: "BACHATA_GENERIC_CONFIRM_REUSE",
    requestId,
    ...attestation,
  }, { ensureContent: false });
  const record = result && typeof result === "object"
    ? result as Record<string, unknown>
    : undefined;
  const value = record?.value && typeof record.value === "object"
    ? record.value as Record<string, unknown>
    : undefined;
  if (record?.ok !== true || value?.reuseConfirmed !== true) {
    throw new Error(typeof record?.error === "string"
      ? record.error
      : "The generic browser conversation reuse attestation was not confirmed");
  }
  return genericSessionForAttestation(tabId, attestation, "confirmed");
};

/**
 * BB-A4-N05. What a completed Generic turn does with its answer, apart from when it decides to.
 *
 * A final answer that arrived while a Stop was pending returned without retaining the result and
 * without removing the request; the Stop's own failure path then cleared the pending flag and left
 * both registries populated, so the answer was gone and the session stayed occupied for the life
 * of the connection. Holding the finalization as a closure lets whichever way the Stop settles own
 * it, and every path still ends in exactly one `removeActiveRequest`.
 */
const finalizeGenericTurn = async (
  request: ActiveRequest,
  session: BrowserSession,
  startedAt: string,
  minimumDocumentRevision: number,
  genericResult: unknown,
): Promise<void> => {
    if (!genericResult || typeof genericResult !== "object") {
      throw new Error("Generic browser provider returned no response");
    }
    const response = genericResult as Record<string, unknown>;
    if (response.ok !== true || typeof response.text !== "string") {
      throw new Error(
        typeof response.error === "string"
          ? response.error
          : "Generic browser provider returned an invalid response",
      );
    }
    const attestationValue = response.result;
    if (!attestationValue || typeof attestationValue !== "object" || Array.isArray(attestationValue)) {
      throw new Error("Generic browser provider returned no final conversation attestation");
    }
    const finalRecord = attestationValue as Record<string, unknown>;
    if (typeof finalRecord.documentToken !== "string"
      || !Number.isInteger(finalRecord.documentRevision)
      || Number(finalRecord.documentRevision) < minimumDocumentRevision
      || typeof finalRecord.conversationUrl !== "string"
      || typeof finalRecord.conversationIdentity !== "string"
      || typeof finalRecord.providerIdleConfirmed !== "boolean"
      || (finalRecord.completionSource !== "verifiedLifecycle" && finalRecord.completionSource !== "manualSelection")
      || (finalRecord.completionSource === "verifiedLifecycle" && finalRecord.providerIdleConfirmed !== true)) {
      throw new Error("Generic browser provider returned an invalid final conversation attestation");
    }
    let attestedConversationUrl: string;
    let originalOrigin: string;
    let attestedOrigin: string;
    try {
      attestedConversationUrl = canonicalConversationUrl("generic", finalRecord.conversationUrl);
      originalOrigin = new URL(session.conversationUrl).origin;
      attestedOrigin = new URL(attestedConversationUrl).origin;
    } catch {
      throw new Error("Generic browser provider returned an invalid final conversation URL");
    }
    const attestedConversationIdentity = conversationIdentityFor("generic", attestedConversationUrl);
    if (finalRecord.documentToken !== session.documentToken
      || finalRecord.conversationUrl !== attestedConversationUrl
      || finalRecord.conversationIdentity !== attestedConversationIdentity
      || attestedOrigin !== originalOrigin) {
      throw new Error("Generic browser final conversation attestation does not match the active request");
    }
    const finalAttestation: GenericConversationAttestation = {
      documentToken: finalRecord.documentToken,
      documentRevision: Number(finalRecord.documentRevision),
      conversationUrl: attestedConversationUrl,
      conversationIdentity: attestedConversationIdentity,
    };
    const providerIdleConfirmed = finalRecord.providerIdleConfirmed === true;
    let finalSession = await genericSessionForAttestation(session.tabId, finalAttestation, "provisional");
    if (!activeRequests.has(request.requestId)) {
      return;
    }
    if (providerIdleConfirmed) {
      finalSession = await confirmGenericConversationReuse(request.requestId, session.tabId, finalAttestation);
      if (!activeRequests.has(request.requestId)) return;
    }
    if (
      stored.selectedSessionId === request.sessionId ||
      stored.selectedTabId === finalSession.tabId
    ) {
      stored.selectedTabId = finalSession.tabId;
      stored.selectedSessionId = finalSession.id;
      await saveStored();
    }
    if (!activeRequests.has(request.requestId)) {
      return;
    }
    const text = response.text;
    const segments = response.segments;
    if (!validCapturedSegments(text, segments)) {
      throw new Error("Generic browser provider returned invalid structured response segments");
    }
    sendSocket({
      type: "conversation.response",
      protocolVersion,
      requestId: request.requestId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      provider: "generic",
      text,
      segments: segments as CapturedSegment[],
      assets: [],
      captureFormat: "renderedText",
      fidelity: "bestEffort",
      finalConversationUrl: finalSession.conversationUrl,
      finalConversationIdentity: finalSession.conversationIdentity,
      finalSessionId: finalSession.id,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  popupRecoveryStore.clear(request.tabId, request.requestId);
  removeActiveRequest(request.requestId);
  await sendProviderStatus();
};

const failGenericTurn = (request: ActiveRequest, cause: unknown): void => {
  if (!activeRequests.has(request.requestId)) {
    return;
  }
  if (pendingInterrupts.has(request.requestId)) {
    return;
  }
  removeActiveRequest(request.requestId);
  sendConversationError(
    request,
    "SUBMISSION_FAILED",
    cause instanceof Error ? cause.message : String(cause),
  );
  refreshProviderStatus();
};

const settleGenericTurn = async (
  request: ActiveRequest,
  session: BrowserSession,
  startedAt: string,
  minimumDocumentRevision: number,
  genericResult: unknown,
): Promise<void> => {
  try {
    await finalizeGenericTurn(request, session, startedAt, minimumDocumentRevision, genericResult);
  } catch (cause) {
    failGenericTurn(request, cause);
  }
};

const runGenericConversation = async (
  request: ActiveRequest,
  session: BrowserSession,
  prompt: string,
): Promise<void> => {
  const startedAt = new Date().toISOString();
  try {
    if (!activeRequests.has(request.requestId)) return;
    if (pendingInterrupts.has(request.requestId)) {
      acknowledgeInterrupted(request, true);
      return;
    }
    const status = await genericStatus(session.tabId);
    if (!activeRequests.has(request.requestId)) return;
    if (pendingInterrupts.has(request.requestId)) {
      acknowledgeInterrupted(request, true);
      return;
    }
    const currentConversationUrl = canonicalConversationUrl("generic", status.url);
    const currentConversationIdentity = conversationIdentityFor("generic", currentConversationUrl);
    if (status.documentToken !== session.documentToken
      || currentConversationUrl !== session.conversationUrl
      || currentConversationIdentity !== session.conversationIdentity) {
      throw new Error("The selected generic browser document changed before submission");
    }
    if (!activeRequests.has(request.requestId)) return;
    if (pendingInterrupts.has(request.requestId)) {
      acknowledgeInterrupted(request, true);
      return;
    }
    request.submissionAttempted = true;
    const genericResult = await sendGenericCommand(session.tabId, {
      type: "BACHATA_GENERIC_SEND",
      requestId: request.requestId,
      prompt,
      documentToken: session.documentToken,
      documentRevision: status.documentRevision,
      conversationUrl: session.conversationUrl,
      conversationIdentity: session.conversationIdentity,
      deadlineAt: request.deadlineAt,
    }, { ensureContent: false });
    if (!activeRequests.has(request.requestId)) {
      return;
    }
    if (pendingInterrupts.has(request.requestId)) {
      // BB-A4-N05. The answer outlives the Stop decision rather than being dropped by it.
      requestOrdering.retainCompletion(request.requestId, () =>
        settleGenericTurn(request, session, startedAt, status.documentRevision, genericResult));
      return;
    }
    await finalizeGenericTurn(request, session, startedAt, status.documentRevision, genericResult);
  } catch (cause) {
    failGenericTurn(request, cause);
  }
};

const handleServerMessage = async (
  message: ServerMessage,
  eventSocket: WebSocket,
): Promise<void> => {
  if (eventSocket !== socket) {
    return;
  }
  if (message.type === "bridge.paired") {
    stored.connectionToken = message.connectionToken;
    pairingToken = undefined;
    await saveStored();
    return;
  }
  if (message.type === "localModel.config") {
    setLocalModelConfig({
      enabled: message.enabled,
      backend: message.backend,
      ...(message.endpoint ? { endpoint: message.endpoint } : {}),
      model: message.model,
      timeoutMs: message.timeoutMs,
    });
    return;
  }
  if (message.type === "bridge.connected") {
    connected = true;
    connecting = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearReconnectPersistence();
    await saveStored();
    error = undefined;
    await sendProviderStatus();
    clearKeepAliveTimer();
    keepAliveTimer = setInterval(() => {
      if (eventSocket !== socket || eventSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (pendingKeepAliveNonce) {
        error = "The Bachata VS Code extension stopped responding";
        eventSocket.close();
        return;
      }
      const nonce = crypto.randomUUID();
      pendingKeepAliveNonce = nonce;
      try {
        sendSocket({
          type: "bridge.ping",
          protocolVersion,
          nonce,
        });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        eventSocket.close();
        return;
      }
      keepAliveDeadlineTimer = setTimeout(() => {
        keepAliveDeadlineTimer = undefined;
        if (
          eventSocket === socket &&
          pendingKeepAliveNonce === nonce
        ) {
          error = "The Bachata VS Code extension stopped responding";
          eventSocket.close();
        }
      }, 10_000) as unknown as number;
    }, 20_000) as unknown as number;
    return;
  }
  if (message.type === "bridge.pong") {
    if (message.nonce === pendingKeepAliveNonce) {
      pendingKeepAliveNonce = undefined;
      if (keepAliveDeadlineTimer !== undefined) {
        clearTimeout(keepAliveDeadlineTimer);
        keepAliveDeadlineTimer = undefined;
      }
    }
    return;
  }
  if (message.type === "provider.discover") {
    await discoverProviderTabs();
    return;
  }
  if (message.type === "provider.openConversation") {
    enqueueProviderProvisioning(message.requestId, message.provider, eventSocket, {
      ...(message.preferredTabId !== undefined ? { preferredTabId: message.preferredTabId } : {}),
      ...(message.preferredOrigin !== undefined ? { preferredOrigin: message.preferredOrigin } : {}),
      ...(message.preferredConversationIdentity !== undefined
        ? { preferredConversationIdentity: message.preferredConversationIdentity }
        : {}),
      ...(message.fresh !== undefined ? { fresh: message.fresh } : {}),
    });
    return;
  }
  if (message.type === "provider.cancelOpenConversation") {
    provisioningQueue.cancel(message.requestId);
    return;
  }
  if (message.type === "conversation.send") {
    requestOrdering.beginSend(message.requestId);
    let registered = false;
    // Scoped to this one request, so a provider-classified refusal cannot leak into another.
    let submissionFailureCode: string | undefined;
    const request: ActiveRequest = {
      ...message,
      deadlineAt: message.deadlineAt ?? Date.now() + 30 * 60_000,
      conversationUrl: canonicalConversationUrl(message.provider, message.conversationUrl),
      transitionUsed: false,
      initialConversationUrl: canonicalConversationUrl(
        message.provider,
        message.conversationUrl,
      ),
    };
    try {
      if (
        activeRequests.has(request.requestId) ||
        activeRequestBySession.has(request.sessionId)
      ) {
        throw new Error(
          "The selected browser conversation already has an active request",
        );
      }
      activeRequests.set(request.requestId, request);
      popupRecoveryStore.clear(request.tabId);
      activeRequestBySession.set(request.sessionId, request.requestId);
      registered = true;
      if (pendingInterrupts.has(request.requestId)) {
        acknowledgeInterrupted(request, true);
        return;
      }
      const session = await exactSession(request);
      if (!session || session.status !== "ready") {
        throw new Error(
          "The selected browser document no longer matches the requested session",
        );
      }
      if (pendingInterrupts.has(request.requestId)) {
        acknowledgeInterrupted(request, true);
        return;
      }
      const tab = await chrome.tabs.get(session.tabId);
      if (
        typeof tab.url !== "string" ||
        canonicalConversationUrl(session.provider, tab.url) !== session.conversationUrl
      ) {
        throw new Error("The selected browser tab navigated to another conversation");
      }
      if (pendingInterrupts.has(request.requestId)) {
        acknowledgeInterrupted(request, true);
        return;
      }
      if (session.provider === "generic") {
        if (message.attachments.length > 0) {
          throw new Error("Generic browser providers do not support image attachments");
        }
        void runGenericConversation(request, session, message.text);
        return;
      }
      request.submissionAttempted = true;
      const result = await sendContentMessage<{
        submitted?: boolean;
        error?: string;
        code?: string;
      }>(session, message);
      if (!activeRequests.has(request.requestId)) return;
      if (!result?.submitted) {
        // A provider-classified refusal keeps its own code; anything else stays the generic
        // submission failure rather than being dressed up as one.
        if (typeof result?.code === "string" && result.code.length > 0) {
          submissionFailureCode = result.code;
        }
        throw new Error(result?.error ?? "The browser prompt was not submitted");
      }
      if (!activeRequests.has(request.requestId)) return;
      request.submissionCommitted = true;
      sendSocket({
        type: "conversation.submitted",
        protocolVersion,
        requestId: message.requestId,
        agentId: message.agentId,
        sessionId: message.sessionId,
      });
    } catch (cause) {
      const cancelled = pendingInterrupts.has(request.requestId);
      if (cancelled && registered) {
        acknowledgeInterrupted(request, true);
      } else if (!registered || activeRequests.has(request.requestId)) {
        // BR-G6-11. Only the request this handler actually registered may be forgotten by it. A
        // duplicate send carrying an id that is already running is refused before registering
        // anything, and that id in the registry is the incumbent's — removing it leaves the turn
        // running in the browser while the worker can no longer route its completion or match
        // its Stop. The refusal is still answered; it just answers for itself.
        //
        // BB-A4-N06. Answering is owed to whatever was refused, and a send for an occupied
        // session is refused under its own id, which was never registered. Making the answer
        // conditional on finding that id in the registry left it with no reply at all — only the
        // cleanup above may depend on registry ownership. A registered request that some other
        // path already removed is still not answered twice.
        if (registered) {
          removeActiveRequest(request.requestId);
          rememberRecovery(request, "failure");
        }
        sendSocket({
          type: "conversation.error",
          protocolVersion,
          requestId: message.requestId,
          agentId: message.agentId,
          sessionId: message.sessionId,
          code: submissionFailureCode ?? "SUBMISSION_FAILED",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return;
  }
  if (message.type === "conversation.interrupt") {
    const request = activeRequests.get(message.requestId);
    if (!request && pendingInterrupts.delete(message.requestId)) {
      return;
    }
    if (!request || !interruptMatchesRequest(message, request)) {
      sendSocket({
        type: "conversation.error",
        protocolVersion,
        requestId: message.requestId,
        agentId: message.agentId,
        sessionId: message.sessionId,
        code: "INTERRUPT_MISMATCH",
        message: "The browser request is no longer active",
      });
      return;
    }
    try {
      if (request.provider === "generic") {
        const result = await sendGenericCommand(request.tabId, {
          type: "BACHATA_GENERIC_CANCEL",
          requestId: request.requestId,
        });
        if (!result || typeof result !== "object") {
          throw new Error("Generic browser interruption was not confirmed");
        }
        const record = result as Record<string, unknown>;
        const value = record.value && typeof record.value === "object"
          ? record.value as Record<string, unknown>
          : undefined;
        const stopConfirmed = value?.stopConfirmed === true;
        const submissionPrevented = value?.submissionPrevented === true && request.submissionCommitted !== true;
        if (record.ok !== true
          || value?.interrupted !== true
          || (!stopConfirmed && !submissionPrevented)) {
          throw new Error(typeof record.error === "string" ? record.error : "Generic browser interruption was not confirmed");
        }
        if (stopConfirmed
          && typeof value?.documentToken === "string"
          && Number.isInteger(value.documentRevision)
          && typeof value.conversationUrl === "string"
          && typeof value.conversationIdentity === "string") {
          const interruptedDocumentToken = value.documentToken;
          const interruptedDocumentRevision = Number(value.documentRevision);
          const interruptedConversationUrl = value.conversationUrl;
          const interruptedConversationIdentity = value.conversationIdentity;
          await (async () => {
            const conversationUrl = canonicalConversationUrl("generic", interruptedConversationUrl);
            const conversationIdentity = conversationIdentityFor("generic", conversationUrl);
            const requestOrigin = new URL(request.conversationUrl).origin;
            const attestedOrigin = new URL(conversationUrl).origin;
            if (interruptedDocumentToken !== request.documentToken
              || interruptedConversationUrl !== conversationUrl
              || interruptedConversationIdentity !== conversationIdentity
              || requestOrigin !== attestedOrigin) return;
            const attestation: GenericConversationAttestation = {
              documentToken: interruptedDocumentToken,
              documentRevision: interruptedDocumentRevision,
              conversationUrl,
              conversationIdentity,
            };
            await genericSessionForAttestation(request.tabId, attestation, "provisional");
            await confirmGenericConversationReuse(request.requestId, request.tabId, attestation);
          })().catch(() => undefined);
        }
      } else {
        const result = await sendContentMessage<{
          interrupted?: boolean;
          error?: string;
        }>(request, interruptPayload(request));
        if (!result?.interrupted) {
          throw new Error(result?.error ?? "Browser interruption was not confirmed");
        }
      }
      acknowledgeInterrupted(request);
      refreshProviderStatus();
    } catch (cause) {
      pendingInterrupts.delete(request.requestId);
      // BB-A4-N05. A Stop that could not be confirmed does not also lose the answer that raced
      // it. The held completion runs after the cancel round-trip has settled, and it is the one
      // thing that releases the request; only a Stop with nothing held reports the failure.
      const retained = requestOrdering.takeCompletion(request.requestId);
      if (retained) {
        await retained();
      } else if (activeRequests.has(request.requestId)) {
        // The turn is still running, so it still owes the controller exactly one terminal frame.
        // Saying the Stop failed must not be that frame, or the answer still coming is lost.
        sendInterruptFailed(request, cause instanceof Error ? cause.message : String(cause));
      }
    }
    return;
  }
  if (message.type === "asset.fetch") {
    const registered = await recoverRegisteredAsset(message.assetId);
    // BB-AUD-09. Whether this transfer may open at all is decided in `assetAdmission.ts`; what
    // stays here is recovering the asset, and acting on the verdict.
    const admission = admitAssetFetch({
      request: {
        transferId: message.transferId,
        assetId: message.assetId,
        maxBytes: message.maxBytes,
      },
      ...(registered ? { registered } : {}),
      ...(registered
        ? { currentDocument: documentsByTab.get(registered.binding.tabId) }
        : {}),
      transferIdInUse: activeAssetTransfers.has(message.transferId),
    });
    if (admission.verdict !== "admitted") {
      if (admission.forgetAsset) assetsById.delete(message.assetId);
      sendAssetError(message.transferId, message.assetId, admission.code, admission.message);
      return;
    }
    const transfer: ActiveAssetTransfer = admission.transfer;
    activeAssetTransfers.set(message.transferId, transfer);
    void sendContentMessage<{ success?: boolean; accepted?: boolean; error?: string }>(
      transfer.binding,
      {
        type: "asset.fetch",
        transferId: transfer.transferId,
        assetId: transfer.assetId,
        maxBytes: transfer.maxBytes,
      },
    ).then(
      (result) => {
        if (
          assetFetchAckRejected(
            result,
            activeAssetTransfers.has(transfer.transferId),
          )
        ) {
          activeAssetTransfers.delete(transfer.transferId);
          sendAssetError(
            transfer.transferId,
            transfer.assetId,
            "ASSET_FETCH_FAILED",
            result?.error ?? "The browser asset transfer was rejected",
          );
        }
      },
      (cause) => {
        if (!activeAssetTransfers.delete(transfer.transferId)) {
          return;
        }
        sendAssetError(
          transfer.transferId,
          transfer.assetId,
          "ASSET_FETCH_FAILED",
          cause instanceof Error ? cause.message : String(cause),
        );
      },
    );
    return;
  }
  if (message.type === "asset.cancel") {
    const transfer = activeAssetTransfers.get(message.transferId);
    if (transfer && transfer.assetId === message.assetId) {
      await cancelAssetTransfer(transfer);
    }
    return;
  }
  if (message.type === "asset.reveal") {
    const registered = await recoverRegisteredAsset(message.assetId);
    if (!registered) {
      sendSocket({
        type: "asset.reveal.result",
        protocolVersion,
        requestId: message.requestId,
        assetId: message.assetId,
        success: false,
        message: "The provider asset is no longer available",
      });
      return;
    }
    const current = documentsByTab.get(registered.binding.tabId);
    if (!current || !sameDocumentBinding(current, registered.binding)) {
      assetsById.delete(message.assetId);
      sendSocket({
        type: "asset.reveal.result",
        protocolVersion,
        requestId: message.requestId,
        assetId: message.assetId,
        success: false,
        message: "The browser document that produced the asset has changed",
      });
      return;
    }
    try {
      const tab = await chrome.tabs.update(registered.binding.tabId, {
        active: true,
      });
      const windowId = tab?.windowId;
      if (typeof windowId === "number" && Number.isInteger(windowId)) {
        await chrome.windows.update(windowId, { focused: true });
      }
      const result = await sendContentMessage<{
        success?: boolean;
        error?: string;
      }>(registered.binding, {
        type: "asset.reveal",
        assetId: message.assetId,
      });
      if (!result?.success) {
        throw new Error(result?.error ?? "The provider asset could not be located");
      }
      sendSocket({
        type: "asset.reveal.result",
        protocolVersion,
        requestId: message.requestId,
        assetId: message.assetId,
        success: true,
      });
    } catch (cause) {
      sendSocket({
        type: "asset.reveal.result",
        protocolVersion,
        requestId: message.requestId,
        assetId: message.assetId,
        success: false,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return;
  }
  error = `${message.code}: ${message.message}`;
  connecting = false;
  if (!connected) {
    eventSocket.close();
  }
};

const connect = async (): Promise<void> => {
  if (!stored.endpoint || connecting || socket?.readyState === WebSocket.OPEN) {
    return;
  }
  clearReconnectTimer();
  if (stored.reconnectAt !== undefined) {
    stored.reconnectAt = undefined;
    stored.reconnectAttempt = persistedReconnectAttempt(reconnectAttempt);
    void saveStored().catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
  }
  connecting = true;
  error = undefined;
  let nextSocket: WebSocket;
  try {
    const endpoint = normalizeBridgeEndpoint(stored.endpoint);
    stored.endpoint = endpoint;
    nextSocket = new WebSocket(endpoint);
  } catch (cause) {
    connecting = false;
    connected = false;
    error = cause instanceof Error ? cause.message : String(cause);
    return;
  }
  let serverMessageQueue = Promise.resolve();
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (nextSocket !== socket) {
      return;
    }
    try {
      if (pairingToken) {
        sendSocket({ type: "bridge.pair", protocolVersion, token: pairingToken });
      } else if (stored.connectionToken) {
        sendSocket({
          type: "bridge.authenticate",
          protocolVersion,
          connectionToken: stored.connectionToken,
        });
      } else {
        error = "A pairing token is required";
        nextSocket.close();
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      nextSocket.close();
    }
  });
  nextSocket.addEventListener("message", (event) => {
    if (nextSocket !== socket) {
      return;
    }
    let message: ServerMessage;
    try {
      const raw = String(event.data);
      if (utf8ByteLength(raw) > maximumMessageBytes) {
        throw new Error("Bridge message exceeds the transport limit");
      }
      message = parseServerMessage(JSON.parse(raw));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      nextSocket.close();
      return;
    }
    if (message.type === "conversation.send") {
      requestOrdering.recordSend(message.requestId);
    } else if (message.type === "conversation.interrupt") {
      requestOrdering.recordInterrupt(message.requestId);
      const active = activeRequests.get(message.requestId);
      if (active && interruptMatchesRequest(message, active)) {
        pendingInterrupts.add(message.requestId);
        void handleServerMessage(message, nextSocket).catch((cause) => {
          if (nextSocket === socket) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        });
        return;
      }
    }
    if (
      message.type === "provider.openConversation" ||
      message.type === "provider.cancelOpenConversation" ||
      message.type === "bridge.pong"
    ) {
      void handleServerMessage(message, nextSocket).catch((cause) => {
        if (nextSocket === socket) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      });
      return;
    }
    const operation = serverMessageQueue.then(() =>
      handleServerMessage(message, nextSocket),
    );
    serverMessageQueue = operation.catch(() => undefined);
    void operation.catch((cause) => {
      if (nextSocket === socket) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    });
  });
  nextSocket.addEventListener("close", () => {
    if (nextSocket !== socket) {
      return;
    }
    socket = undefined;
    connected = false;
    connecting = false;
    clearKeepAliveTimer();
    requestOrdering.clear();
    provisioningQueue.cancelAll();
    providerStatusRevision += 1;
    void stopActiveRequests();
    void stopActiveAssetTransfers();
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    if (nextSocket === socket) {
      error = "Could not connect to the Bachata VS Code extension";
    }
  });
};

const initialize = async (): Promise<void> => {
  await loadStored();
  await restoreGenericRegistrations().catch(() => undefined);
  reconnectAttempt = stored.reconnectAttempt ?? 0;
  const handled = new Set(normalizedHandledTabIds(stored));
  if (stored.selectedTabId) {
    handled.add(stored.selectedTabId);
  }
  const tabs = await queryTabs();
  await Promise.allSettled(
    tabs.filter((tab) => handled.has(tab.id)).map((tab) =>
      tab.provider === "generic" ? ensureGenericContentScript(tab.id) : ensureContentScript(tab.id),
    ),
  );
  const genericOrigins = new Set(await storedGenericProfileOrigins());
  const restoredTabs = await chrome.tabs.query({});
  await Promise.allSettled(
    restoredTabs.map(async (tab) => {
      if (!Number.isInteger(tab.id) || typeof tab.url !== "string" || providerForUrl(tab.url)) return;
      let origin: string;
      try {
        const url = new URL(tab.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        origin = url.origin;
      } catch {
        return;
      }
      if (!genericOrigins.has(origin)) return;
      const permitted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (!permitted) return;
      await ensureGenericContentScript(tab.id as number);
    }),
  );
  if (shouldRestoreReconnect(
    stored.endpoint,
    stored.connectionToken,
    stored.reconnectAt,
  )) {
    scheduleReconnectAt(stored.reconnectAt);
    return;
  }
  if (stored.reconnectAt !== undefined) {
    stored.reconnectAt = undefined;
    await saveStored();
  }
  await connect();
};

const initializationPromise = initialize().catch((cause) => {
  connected = false;
  connecting = false;
  clearReconnectTimer();
  clearKeepAliveTimer();
  error = cause instanceof Error ? cause.message : String(cause);
});

reconnectAlarms()?.onAlarm.addListener((alarm) => {
  if (alarm.name !== reconnectAlarmName) {
    return;
  }
  void initializationPromise.then(() => {
    if (!stored.endpoint || !stored.connectionToken || stored.reconnectAt === undefined) {
      clearReconnectTimer();
      return;
    }
    runScheduledReconnect();
  });
});

const buildPopupTabs = async (): Promise<PopupTab[]> => {
  const tabs = await queryTabs();
  const sessions = await buildSessions(tabs);
  return projectPopupTabs(tabs, sessions, stored.selectedTabId).map((tab) => {
    const recovery = popupRecoveryStore.get(tab.id, sessions.find((session) => session.tabId === tab.id));
    const manualSelectionAvailable = tab.provider === "generic"
      && tab.capabilities?.completion === "manualOnly"
      && [...activeRequests.values()].some((request) => request.tabId === tab.id && request.sessionId === tab.sessionId);
    return { ...tab, ...(recovery ? { recovery } : {}), ...(manualSelectionAvailable ? { manualSelectionAvailable } : {}) };
  });
};

const popupState = async (): Promise<PopupState> =>
  projectPopupState({
    endpoint: stored.endpoint,
    selectedTabId: stored.selectedTabId,
    revision: popupQueue.revision(),
    connected,
    connecting,
    retryInMs,
    error,
    tabs: await buildPopupTabs(),
  });

const validActiveSender = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): ActiveRequest | undefined => {
  const request = activeRequests.get(String(message.requestId));
  const binding = senderBinding(sender, message.documentToken);
  if (!request || !binding || !activeRequestMatchesSender(request, binding, message)) {
    return undefined;
  }
  return request;
};

const applyTransition = async (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<ContentAck> => {
  const request = activeRequests.get(String(message.requestId));
  // BB-AUD-09. Whether the move is allowed is decided in `routerState.ts`; what stays here is
  // reading the sender and writing what the decision authorised.
  const admission = admitInitialTransition({
    ...(request ? { request } : {}),
    ...(() => {
      const binding = senderBinding(sender, message.documentToken);
      return binding ? { binding } : {};
    })(),
    message,
    supportedTransition: isSupportedInitialTransition,
  });
  if (!admission.admitted) {
    return { success: false, accepted: false, error: "Transition rejected" };
  }
  if (request) {
    request.conversationUrl = admission.conversationUrl;
    request.conversationIdentity = admission.conversationIdentity;
    request.transitionUsed = true;
    // BR-G6-03. The content script only claims a transition once its Send has committed, and
    // the admission above refused the claim otherwise, so this request is committed.
    request.submissionCommitted = true;
  }
  documentsByTab.set(admission.binding.tabId, admission.binding);
  return { success: true, accepted: true };
};

const validAssetSender = (
  input: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): ActiveAssetTransfer | undefined => {
  const transfer = activeAssetTransfers.get(String(input.transferId));
  const binding = senderBinding(sender, input.documentToken);
  if (
    !transfer ||
    transfer.assetId !== input.assetId ||
    !binding ||
    !sameDocumentBinding(transfer.binding, binding)
  ) {
    return undefined;
  }
  return transfer;
};

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => {
    const messageType =
      message && typeof message === "object" && !Array.isArray(message)
        ? String((message as Record<string, unknown>).type)
        : "";
    if (messageType === "BACHATA_LOCAL_MODEL_PROMPT" || messageType === "BACHATA_LOCAL_MODEL_CANCEL" || messageType.startsWith("BACHATA_GENERIC_") || messageType.startsWith("BACHATA_QUARANTINE_")) {
      return false;
    }
    const run = async (): Promise<unknown> => {
      await initializationPromise;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error("Invalid browser message");
      }
      const input = message as Record<string, unknown>;
      if (input.type === "content.register") {
        const binding = senderBinding(sender, input.documentToken);
        if (
          !binding ||
          canonicalConversationUrl(binding.provider, String(input.conversationUrl)) !==
            binding.conversationUrl ||
          input.provider !== binding.provider ||
          input.conversationIdentity !== binding.conversationIdentity
        ) {
          throw new Error("Invalid browser document registration");
        }
        const previous = documentsByTab.get(binding.tabId);
        const activeTransition = Array.from(activeRequests.values()).some(
          (request) =>
            request.provider === binding.provider &&
            request.tabId === binding.tabId &&
            request.documentToken === binding.documentToken &&
            request.conversationIdentity === binding.conversationIdentity,
        );
        if (
          previous &&
          !activeTransition &&
          (previous.documentToken !== binding.documentToken ||
            previous.conversationIdentity !== binding.conversationIdentity)
        ) {
          failRequestsForTab(
            binding.tabId,
            "The selected browser document changed",
          );
          if (stored.selectedTabId === binding.tabId) {
            stored.selectedTabId = undefined;
            stored.selectedSessionId = undefined;
            await saveStored();
          }
        }
        documentsByTab.set(binding.tabId, binding);
        if (!activeTransition) {
          refreshProviderStatus();
        }
        return { success: true, registered: true } satisfies ContentAck;
      }
      if (input.type === "content.transition") {
        return applyTransition(input, sender);
      }
      if (input.type === "popup.getState") {
        return popupState();
      }
      if (input.type === "popup.recover") {
        if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url !== chrome.runtime.getURL("popup/index.html")) {
          throw new Error("Recovery requires the Browser Bridge popup");
        }
        const tabId = Number(input.tabId);
        const tab = (await buildPopupTabs()).find((entry) => entry.id === tabId);
        if (!tab) throw new Error("The provider tab is no longer available");
        if (input.action === "open") {
          await chrome.tabs.update(tabId, { active: true });
        } else if (input.action === "selected" && tab.manualSelectionAvailable) {
          const request = [...activeRequests.values()].find((entry) => entry.tabId === tabId && entry.sessionId === tab.sessionId);
          if (!request || !(await exactSession(request))) throw new Error("The active conversation changed");
          const result = await sendGenericCommand(tabId, { type: "BACHATA_GENERIC_SELECTED_TEXT" });
          if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true
            || !("value" in result) || typeof result.value !== "string" || result.value.trim() === "") {
            throw new Error("Select the completed answer on the website, then use selected response");
          }
        } else throw new Error("This recovery action is unavailable");
        return popupState();
      }
      if (input.type === "popup.pair") {
        let endpoint: string;
        try {
          endpoint = normalizeBridgeEndpoint(input.endpoint);
        } catch {
          throw new Error(
            "Enter the loopback endpoint and pairing token shown by Bachata",
          );
        }
        const token = typeof input.token === "string" ? input.token.trim() : "";
        if (!token) {
          throw new Error(
            "Enter the loopback endpoint and pairing token shown by Bachata",
          );
        }
        stored.endpoint = endpoint;
        stored.connectionToken = undefined;
        pairingToken = token;
        reconnectAttempt = 0;
        clearReconnectTimer();
        clearReconnectPersistence();
        await saveStored();
        // BR-G6-10. Re-pairing abandons the socket a provisioning would answer on, and the close
        // listener that cancels the queue is skipped here because `socket` is cleared before the
        // close event arrives. Left running, a provisioning keeps opening and navigating a tab
        // for a request the new server never made, and answers it on whatever socket is current
        // by the time its awaited navigation settles.
        provisioningQueue.cancelAll();
        await stopActiveRequests();
        await stopActiveAssetTransfers();
        const previousSocket = socket;
        socket = undefined;
        previousSocket?.close();
        connected = false;
        connecting = false;
        clearReconnectTimer();
        clearKeepAliveTimer();
        await connect();
        return popupState();
      }
      if (input.type === "popup.select") {
        const tabId = Number(input.tabId);
        if (!Number.isInteger(tabId) || tabId <= 0) {
          throw new Error("Select a valid browser tab");
        }
        if (isGenericTab(tabId)) {
          await ensureGenericContentScript(tabId);
        } else {
          await ensureContentScript(tabId);
        }
        const sessions = await buildSessions();
        const selected = sessions.find((session) => session.tabId === tabId);
        if (!selected) {
          throw new Error("The selected provider tab did not register. Reload it, then refresh tabs.");
        }
        if (selected.status !== "ready") {
          throw new Error(popupStatusReason(selected.status));
        }
        stored.selectedTabId = tabId;
        stored.selectedSessionId = selected.id;
        rememberHandledTabs([tabId]);
        await saveStored();
        await sendProviderStatus();
        return popupState();
      }
      if (input.type === "popup.deselect") {
        stored.selectedTabId = undefined;
        stored.selectedSessionId = undefined;
        await saveStored();
        await sendProviderStatus();
        return popupState();
      }
      if (input.type === "popup.discover") {
        await discoverProviderTabs();
        return popupState();
      }
      if (input.type === "popup.reconnect") {
        reconnectAttempt = 0;
        clearReconnectTimer();
        clearReconnectPersistence();
        await saveStored();
        await connect();
        return popupState();
      }
      if (input.type === "popup.disconnect") {
        // BR-G6-10. As above: the close listener's cancellation cannot run for a socket this
        // handler has already dropped, so the queue is cancelled here.
        provisioningQueue.cancelAll();
        await stopActiveRequests();
        await stopActiveAssetTransfers();
        const previousSocket = socket;
        socket = undefined;
        previousSocket?.close();
        connected = false;
        connecting = false;
        clearReconnectTimer();
        clearReconnectPersistence();
        clearKeepAliveTimer();
        stored = {};
        pairingToken = undefined;
        await saveStored();
        return popupState();
      }
      if (input.type === "content.stream") {
        const request = validActiveSender(input, sender);
        if (!request || !connected) {
          return { success: false, error: "Stale or disconnected stream" };
        }
        if (
          (input.mode !== "append" && input.mode !== "replace") ||
          typeof input.text !== "string"
        ) {
          sendConversationError(
            request,
            "INVALID_STREAM",
            "Browser stream update is invalid",
          );
          removeActiveRequest(request.requestId);
          return { success: false, error: "Invalid stream update" };
        }
        sendSocket({
          type: "conversation.stream",
          protocolVersion,
          requestId: request.requestId,
          agentId: request.agentId,
          sessionId: request.sessionId,
          mode: input.mode,
          text: input.text,
        });
        return { success: true } satisfies ContentAck;
      }
      if (input.type === "content.response") {
        const response = input.response;
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          return { success: false, error: "Invalid response" };
        }
        const responseRecord = response as Record<string, unknown>;
        const request = validActiveSender(
          { ...responseRecord, documentToken: input.documentToken },
          sender,
        );
        if (!request || !connected) {
          return { success: false, error: "Stale or disconnected response" };
        }
        if (
          responseRecord.provider !== request.provider ||
          typeof responseRecord.text !== "string" ||
          !validCapturedSegments(responseRecord.text, responseRecord.segments) ||
          !validCapturedAssets(request.provider, responseRecord.assets) ||
          responseRecord.captureFormat !== "renderedText" ||
          responseRecord.fidelity !== "bestEffort" ||
          typeof responseRecord.finalConversationUrl !== "string" ||
          !isIsoDate(responseRecord.startedAt) ||
          !isIsoDate(responseRecord.completedAt)
        ) {
          sendConversationError(
            request,
            "INVALID_RESPONSE",
            "Browser response is invalid",
          );
          removeActiveRequest(request.requestId);
          return { success: false, error: "Invalid browser response" };
        }
        const binding = documentsByTab.get(request.tabId);
        if (
          !binding ||
          binding.documentToken !== request.documentToken ||
          binding.conversationUrl !== request.conversationUrl ||
          binding.conversationIdentity !== request.conversationIdentity ||
          (request.transitionUsed &&
            !isSupportedInitialTransition(
              request.provider,
              request.initialConversationUrl,
              binding.conversationUrl,
            ))
        ) {
          sendConversationError(
            request,
            "SESSION_CHANGED",
            "The browser conversation changed before completion",
          );
          removeActiveRequest(request.requestId);
          return { success: false, error: "Session changed" };
        }
        const finalSessionId = sessionIdFor(binding);
        if (
          stored.selectedSessionId === request.sessionId ||
          stored.selectedTabId === binding.tabId
        ) {
          stored.selectedTabId = binding.tabId;
          stored.selectedSessionId = finalSessionId;
          await saveStored();
        }
        try {
          sendSocket({
            type: "conversation.response",
            protocolVersion,
            requestId: request.requestId,
            agentId: request.agentId,
            sessionId: request.sessionId,
            provider: request.provider,
            text: responseRecord.text,
            segments: responseRecord.segments as CapturedSegment[],
            assets: responseRecord.assets as CapturedAsset[],
            captureFormat: "renderedText",
            fidelity: "bestEffort",
            finalConversationUrl: binding.conversationUrl,
            finalConversationIdentity: binding.conversationIdentity,
            finalSessionId,
            startedAt: responseRecord.startedAt,
            completedAt: responseRecord.completedAt,
          });
        } catch (cause) {
          sendConversationError(
            request,
            "RESPONSE_TOO_LARGE",
            cause instanceof Error ? cause.message : String(cause),
          );
          removeActiveRequest(request.requestId);
          return { success: false, error: "Browser response exceeds the transport limit" };
        }
        registerAssets(binding, responseRecord.assets as CapturedAsset[]);
        popupRecoveryStore.clear(request.tabId, request.requestId);
        removeActiveRequest(request.requestId);
        await sendProviderStatus();
        return { success: true } satisfies ContentAck;
      }
      if (input.type === "content.asset.start") {
        const transfer = validAssetSender(input, sender);
        const start = transfer && connected ? parseAssetStart(transfer, input) : undefined;
        if (!transfer || !start) {
          return { success: false, error: "Invalid asset transfer start" };
        }
        transfer.started = true;
        transfer.declaredSize = start.size;
        sendSocket({
          type: "asset.start",
          protocolVersion,
          transferId: transfer.transferId,
          assetId: transfer.assetId,
          name: start.name,
          ...(start.mimeType === undefined ? {} : { mimeType: start.mimeType }),
          ...(start.size === undefined ? {} : { size: start.size }),
        });
        return { success: true } satisfies ContentAck;
      }
      if (input.type === "content.asset.chunk") {
        const transfer = validAssetSender(input, sender);
        const bytes = strictBase64Bytes(input.dataBase64);
        const chunk = transfer && connected
          ? parseAssetChunk(transfer, input, bytes)
          : undefined;
        if (!transfer || !chunk) {
          if (transfer) {
            await cancelAssetTransfer(transfer);
            sendAssetError(
              transfer.transferId,
              transfer.assetId,
              "INVALID_ASSET_CHUNK",
              "The browser asset transfer sent an invalid chunk",
            );
          }
          return { success: false, error: "Invalid asset transfer chunk" };
        }
        transfer.nextSequence += 1;
        transfer.receivedBytes += chunk.byteLength;
        sendSocket({
          type: "asset.chunk",
          protocolVersion,
          transferId: transfer.transferId,
          assetId: transfer.assetId,
          sequence: chunk.sequence,
          dataBase64: input.dataBase64 as string,
        });
        return { success: true } satisfies ContentAck;
      }
      if (input.type === "content.asset.complete") {
        const transfer = validAssetSender(input, sender);
        const completion = transfer && connected
          ? parseAssetCompletion(transfer, input)
          : undefined;
        if (!transfer || !completion) {
          if (transfer) {
            await cancelAssetTransfer(transfer);
            sendAssetError(
              transfer.transferId,
              transfer.assetId,
              "INVALID_ASSET_COMPLETION",
              "The browser asset transfer completion is invalid",
            );
          }
          return { success: false, error: "Invalid asset transfer completion" };
        }
        activeAssetTransfers.delete(transfer.transferId);
        sendSocket({
          type: "asset.complete",
          protocolVersion,
          transferId: transfer.transferId,
          assetId: transfer.assetId,
          size: completion.size,
          sha256: completion.sha256,
        });
        return { success: true } satisfies ContentAck;
      }
      if (input.type === "content.asset.error") {
        const transfer = validAssetSender(input, sender);
        if (!transfer || !connected) {
          return { success: false, error: "Stale asset transfer error" };
        }
        activeAssetTransfers.delete(transfer.transferId);
        sendAssetError(
          transfer.transferId,
          transfer.assetId,
          typeof input.code === "string" && input.code
            ? input.code
            : "ASSET_FETCH_FAILED",
          typeof input.message === "string" && input.message
            ? input.message
            : "The browser asset transfer failed",
        );
        return { success: true } satisfies ContentAck;
      }
      if (input.type === "content.error") {
        const request = validActiveSender(input, sender);
        if (!request || !connected) {
          return { success: false, error: "Stale or disconnected error" };
        }
        sendConversationError(
          request,
          String(input.code),
          String(input.message),
        );
        removeActiveRequest(request.requestId);
        refreshProviderStatus();
        return { success: true } satisfies ContentAck;
      }
      return undefined;
    };
    const operation = popupMutationTypes.has(messageType)
      ? popupQueue.enqueueMutation(run)
      : messageType === "popup.getState"
        ? popupQueue.enqueueRead(run)
        : run();
    void operation.then(
      respond,
      (cause) =>
        respond({
          success: false,
          revision: popupQueue.revision(),
          error: cause instanceof Error ? cause.message : String(cause),
        }),
    );
    return true;
  },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  popupRecoveryStore.clear(tabId);
  void initializationPromise.then(async () => {
    // N1. A closed tab keeps no navigation state. Chrome reuses tab ids, and a state left
    // behind would have the next tab's first navigation judged against a dead predecessor —
    // deduplicated away, or refused as a stale document.
    navigationTracker.forgetTab(tabId);
    documentsByTab.delete(tabId);
    forgetHandledTab(tabId);
    failRequestsForTab(tabId, "The selected browser tab was closed");
    popupRecoveryStore.clear(tabId);
    if (tabId === stored.selectedTabId) {
      stored.selectedTabId = undefined;
      stored.selectedSessionId = undefined;
    }
    await saveStored();
    refreshProviderStatus();
  }).catch((cause) => {
    error = cause instanceof Error ? cause.message : String(cause);
  });
});

/**
 * Everything one tab change does, whichever Chrome event reported it.
 *
 * `tabs.onUpdated` and the three `webNavigation` events describe the same thing in
 * different words, and acting on them differently is how a route change comes to mean one
 * thing when Chrome commits it and another when the page pushes it. They are translated
 * into the same change record and carried out here, once.
 */
const applyTabChange = async (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  document: { documentId?: string | undefined } = {},
): Promise<void> => {
  const genericRegistration = isGenericTab(tabId)
    ? genericRegistrations().find((registration) => registration.tabId === tabId)
    : undefined;
  // BB-AUD-09. What the change means is decided in `tabChange.ts`; carrying it out — dropping a
  // binding, failing requests, persisting, asking Chrome and re-injecting — stays here.
  const clearSelectionFor = (id: number): void => {
    if (stored.selectedTabId !== id) return;
    stored.selectedTabId = undefined;
    stored.selectedSessionId = undefined;
  };
  /**
   * BB-A4-N04. The document is gone; the tab is not.
   *
   * A reload replaces the bound document, and the commit event that says so cannot reinject —
   * the replacement is still loading. Reinjection happens on the later `status: "complete"`
   * update, and that update only probes a tab it still considers tracked. Forgetting the
   * selection and the handled-tab record here meant that by the time the page was ready nothing
   * said it was ours, so a reload cost the person a manual rediscovery. The binding and every
   * request that depended on it still go, which is what stops the replaced document acting.
   */
  const dropDocument = async (id: number, failure: string): Promise<void> => {
    documentsByTab.delete(id);
    failRequestsForTab(id, failure);
    await saveStored();
  };
  const dropTab = async (id: number, failure: string): Promise<void> => {
    forgetHandledTab(id);
    clearSelectionFor(id);
    await dropDocument(id, failure);
  };
  if (genericRegistration) {
    const generic = genericTabChangeVerdict({
      ...(typeof changeInfo.url === "string" ? { url: changeInfo.url } : {}),
      ...(changeInfo.status === undefined ? {} : { status: changeInfo.status }),
      registeredOrigin: genericRegistration.origin,
    });
    if (generic.leftOrigin) {
      removeGenericRegistration(tabId);
      failRequestsForTab(tabId, "The generic browser tab navigated to another origin");
      if (stored.selectedTabId === tabId) {
        clearSelectionFor(tabId);
        await saveStored();
      }
      refreshProviderStatus();
      return;
    }
    if (generic.refreshStatus) refreshProviderStatus();
    return;
  }
  const wasTracked = documentsByTab.has(tabId);
  const urlVerdict = providerTabUrlVerdict({
    ...(typeof changeInfo.url === "string" ? { url: changeInfo.url } : {}),
    ...(changeInfo.status === undefined ? {} : { status: changeInfo.status }),
    ...(() => {
      const binding = documentsByTab.get(tabId);
      return binding ? { binding } : {};
    })(),
    ...(() => {
      const active = Array.from(activeRequests.values()).find(
        (request) => request.tabId === tabId,
      );
      return active ? { activeRequest: active } : {};
    })(),
    ...(document.documentId === undefined ? {} : { documentId: document.documentId }),
  });
  if (urlVerdict.verdict === "left-supported-sites") {
    await dropTab(tabId, urlVerdict.failure);
    refreshProviderStatus();
    return;
  }
  if (urlVerdict.verdict === "left-its-conversation" || urlVerdict.verdict === "document-replaced") {
    // BB-A4-N04. Still the person's tab, and still a provider page: only the document it was
    // bound to has gone, so the tracking that lets the replacement be reinjected stays.
    await dropDocument(tabId, urlVerdict.failure);
  }
  const suppressRefresh = urlVerdict.verdict === "kept" ? urlVerdict.suppressRefresh : false;
  const tracked =
    wasTracked ||
    tabId === stored.selectedTabId ||
    normalizedHandledTabIds(stored).includes(tabId);
  if (
    tabSupportProbeNeeded({
      suppressRefresh,
      ...(changeInfo.status === undefined ? {} : { status: changeInfo.status }),
      tracked,
    })
  ) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (probedTabSupported(tab?.url)) {
      await ensureContentScript(tabId).catch(() => undefined);
    } else {
      await dropTab(tabId, "The selected browser tab navigated to an unsupported site");
    }
  }
  if (
    refreshAfterTabChange({
      suppressRefresh,
      ...(typeof changeInfo.url === "string" ? { url: changeInfo.url } : {}),
      ...(changeInfo.status === undefined ? {} : { status: changeInfo.status }),
    })
  ) {
    refreshProviderStatus();
  }
};

/**
 * Run one tab change after initialization, recording rather than throwing what it could not
 * finish. A listener that rejects takes nothing with it: the service worker keeps running and
 * the next event still has to be judged.
 */
const queueTabChange = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
  void initializationPromise
    .then(() => applyTabChange(tabId, changeInfo))
    .catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
};

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  queueTabChange(tabId, changeInfo);
});

// N1. Chrome's own navigation events, read through the normalizer and deduplicated to
// effective transitions. `tabs.onUpdated` stays subscribed: it is what reports load
// completion, and completion is when a content script may be injected. What these three add
// is the thing a poll cannot tell apart — a same-document route change inside the bound
// conversation, distinguished from a subframe, a prerender and a replaced document.
const navigationTracker = createNavigationTracker();

/** The Generic origins the bridge currently holds a registration for. */
const registeredGenericOrigins = (): ReadonlySet<string> =>
  new Set(genericRegistrations().map((registration) => registration.origin));

/**
 * A Generic origin the user has taken back is not a route change to act on: it is consent
 * withdrawn, and the registration goes with it. The permission is read at the moment the
 * navigation is handled, because a grant checked at registration time proves nothing about
 * now.
 */
const genericOriginStillPermitted = async (origin: string): Promise<boolean> => {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
};

const handleNavigationEvent = (event: ChromeNavigationEvent): void => {
  void initializationPromise
    .then(async () => {
      const verdict = navigationTracker.accept(event, registeredGenericOrigins());
      if (verdict.refusal !== undefined) {
        return;
      }
      const { navigation, sequence } = verdict;
      if (navigation.provider === "generic") {
        const origin = new URL(navigation.url).origin;
        const permitted = await genericOriginStillPermitted(origin);
        // Reading the permission takes a round trip, and Chrome does not wait. A newer
        // navigation, a tab replacement or a tab closing during that read all make this event
        // history: acting on it now would move the tab back to a route it has already left.
        // N1. The guard belongs immediately after the await, and only after an await: nothing
        // else on this path yields, so this is the one place a newer event can have overtaken
        // this one. A second copy further down could never be false and could never be tested.
        if (!navigationTracker.isCurrent(navigation.tabId, sequence)) {
          return;
        }
        if (!permitted) {
          navigationTracker.forgetTab(navigation.tabId);
          removeGenericRegistration(navigation.tabId);
          failRequestsForTab(
            navigation.tabId,
            "The generic browser tab is no longer permitted",
          );
          if (stored.selectedTabId === navigation.tabId) {
            stored.selectedTabId = undefined;
            stored.selectedSessionId = undefined;
            await saveStored();
          }
          refreshProviderStatus();
          return;
        }
      }
      // BR-G6-09. The navigation already knows whether this is a new document, and a same-URL
      // replacement is exactly the case a URL comparison cannot see. Carrying the document
      // identity is what lets the tab change notice that the page it was bound to is gone.
      await applyTabChange(
        navigation.tabId,
        { url: navigation.url },
        navigation.newDocument && navigation.documentId !== undefined
          ? { documentId: navigation.documentId }
          : {},
      );
    })
    .catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
};

chrome.webNavigation.onCommitted.addListener((details) => {
  handleNavigationEvent(navigationDetailsToEvent("onCommitted", details));
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  handleNavigationEvent(navigationDetailsToEvent("onHistoryStateUpdated", details));
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  handleNavigationEvent(navigationDetailsToEvent("onReferenceFragmentUpdated", details));
});

/**
 * Chrome swapped a prerendered or instant-loaded tab in for the one the bridge was watching.
 * This is not a `webNavigation` event and carries no url, frame or document, so the surviving
 * tab is read before anything is decided. The replaced tab's work fails rather than being
 * moved: nothing proves the new document is the same conversation.
 */
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void initializationPromise
    .then(async () => {
      navigationTracker.replaceTab(addedTabId, removedTabId);
      documentsByTab.delete(removedTabId);
      forgetHandledTab(removedTabId);
      failRequestsForTab(removedTabId, "The selected browser tab was replaced");
      popupRecoveryStore.clear(removedTabId);
      if (stored.selectedTabId === removedTabId) {
        stored.selectedTabId = undefined;
        stored.selectedSessionId = undefined;
        await saveStored();
      }
      const tab = await chrome.tabs.get(addedTabId).catch(() => undefined);
      if (typeof tab?.url !== "string") {
        refreshProviderStatus();
        return;
      }
      handleNavigationEvent({
        kind: "onTabReplaced",
        tabId: addedTabId,
        replacedTabId: removedTabId,
        frameId: 0,
        documentLifecycle: "active",
        url: tab.url,
      });
      refreshProviderStatus();
    })
    .catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) =>
  handleLocalModelPromptMessage(message, sender, sendResponse)
);

void registerGenericContextMenus().catch(() => undefined);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleGenericContextMenu(info, tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  removeGenericRegistration(tabId);
  refreshProviderStatus();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (record.type === "BACHATA_GENERIC_MANAGE") {
    void initializationPromise.then(() => handleGenericManagementMessage(
      record, sender, (tabId) => [...activeRequests.values()].some((request) => request.tabId === tabId),
    )).then(
      (value) => { sendResponse(value); refreshProviderStatus(); },
      (cause) => sendResponse({ ok: false, error: cause instanceof Error ? cause.message : "Generic management failed" }),
    );
    return true;
  }
  if (typeof record.type === "string" && record.type.startsWith("BACHATA_QUARANTINE_")) {
    void handleQuarantineMessage(record, sender).then(
      (value) => sendResponse(value ?? { ok: false, error: "Unsupported conversation quarantine request" }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (record.type === "BACHATA_GENERIC_PROFILE_LIST"
    || record.type === "BACHATA_GENERIC_PROFILE_UPSERT"
    || record.type === "BACHATA_GENERIC_PROFILE_CLEAR") {
    void handleGenericProfileStorageMessage(record, sender).then(
      (value) => sendResponse(value ?? { ok: false, error: "Unsupported generic binding storage request" }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (record.type === "BACHATA_GENERIC_BIND_CURRENT_TAB") {
    void bindCurrentGenericTab().then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (record.type === "BACHATA_GENERIC_LIST_SESSIONS") {
    sendResponse({ ok: true, value: genericRegistrations() });
    return false;
  }
  if (record.type === "BACHATA_GENERIC_TAB_COMMAND" && typeof record.tabId === "number" && record.command && typeof record.command === "object") {
    void sendGenericCommand(record.tabId, record.command as Record<string, unknown> & { type: string }).then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  return false;
});

const handleGenericSubmissionCommitted = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): boolean => {
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  const request = activeRequests.get(requestId);
  if (!request || request.provider !== "generic" || request.submissionCommitted) return false;
  if (sender.id !== chrome.runtime.id
    || sender.tab?.id !== request.tabId
    || (sender.frameId ?? 0) !== request.frameId
    || message.documentToken !== request.documentToken
    || message.conversationUrl !== request.conversationUrl
    || message.conversationIdentity !== request.conversationIdentity) {
    return false;
  }
  request.submissionCommitted = true;
  sendSocket({
    type: "conversation.submitted",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: request.sessionId,
  });
  return true;
};

const handleGenericStreamUpdate = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): boolean => {
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  const request = activeRequests.get(requestId);
  if (!request || request.provider !== "generic") return false;
  if (sender.id !== chrome.runtime.id
    || sender.tab?.id !== request.tabId
    || (sender.frameId ?? 0) !== request.frameId
    || message.documentToken !== request.documentToken
    || typeof message.text !== "string") {
    return false;
  }
  sendSocket({
    type: "conversation.stream",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    mode: "replace",
    text: message.text,
  });
  return true;
};

const BACHATA_GENERIC_REGISTER_HANDLER_INSTALLED = true;
void BACHATA_GENERIC_REGISTER_HANDLER_INSTALLED;
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type === "BACHATA_GENERIC_SUBMITTED") {
    sendResponse({ ok: handleGenericSubmissionCommitted(record, sender) });
    return false;
  }
  if (record.type === "BACHATA_GENERIC_STREAM") {
    sendResponse({ ok: handleGenericStreamUpdate(record, sender) });
    return false;
  }
  if (record.type !== "BACHATA_GENERIC_REGISTER") return false;
  void handleGenericContentMessage(message, sender).then(
    (handled) => {
      sendResponse({ ok: handled });
      if (handled) refreshProviderStatus();
    },
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
