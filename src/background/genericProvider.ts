import { profileIdentity } from "./profileIdentity.js";
import { validHttpOrigin, isBuiltInProviderLocation } from "./genericOrigin.js";
export { isBuiltInProviderLocation } from "./genericOrigin.js";
import { isGenericBindingProfile, type GenericBindingProfile } from "../content/generic/types.js";
import { createRevisionQueue, createSnapshotWriteQueue, type RevisionQueue } from "./serializedState.js";

export type GenericRegistration = {
  tabId: number;
  frameId: number;
  origin: string;
  url: string;
  title: string;
  documentRevision: number;
  documentToken: string;
  registeredAt: number;
};

type GenericCommand = Record<string, unknown> & { type: string };

const registrations = new Map<number, GenericRegistration>();
const registrationStorageKey = "bachataGenericRegistrations.v1";
const profileStoragePrefix = "bachata.generic.profile.";
const maximumProfilesPerOrigin = 16;
const managementOrigins = new Set<string>();
const profileMutationQueues = new Map<string, RevisionQueue>();
const registrationWriteQueue = createSnapshotWriteQueue<GenericRegistration[]>(
  (value) => value.map((entry) => ({ ...entry })),
  async (value) => {
    await chrome.storage.session.set({ [registrationStorageKey]: value });
  },
);

type GenericBindingProfileStore = {
  protocol: "bachata-generic-binding-store-v1";
  profiles: GenericBindingProfile[];
};

const senderHttpOrigin = (sender: chrome.runtime.MessageSender): string | undefined => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0) return undefined;
  const rawUrl = sender.url ?? sender.tab?.url;
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

const isProfileForOrigin = (value: unknown, origin: string): value is GenericBindingProfile =>
  isGenericBindingProfile(value, origin);

const profileStorageKey = (origin: string): string => `${profileStoragePrefix}${origin}`;

const genericOriginPattern = (origin: string): string => `${origin}/*`;

const builtInProviderMenuActions = new Set(["selected", "readable"]);

const builtInProviderCommandTypes = new Set([
  "BACHATA_GENERIC_SELECTED_TEXT",
  "BACHATA_GENERIC_READABLE",
  "BACHATA_GENERIC_STATUS",
]);

const builtInProviderRefusal = (subject: string): Error => new Error(
  `Generic browser ${subject} is not available on built-in provider origins. Use the ChatGPT or Claude adapter for this tab.`,
);

export const storedGenericProfileOrigins = async (): Promise<string[]> => {
  const stored = await chrome.storage.local.get(null);
  return Object.keys(stored)
    .filter((key) => key.startsWith(profileStoragePrefix))
    .map((key) => key.slice(profileStoragePrefix.length))
    .map(validHttpOrigin)
    .filter((origin): origin is string => origin !== undefined)
    .sort();
};

export const ensureGenericOriginPermission = async (origin: string): Promise<boolean> => {
  const normalized = validHttpOrigin(origin);
  if (!normalized) return false;
  const permission = { origins: [genericOriginPattern(normalized)] };
  if (await chrome.permissions.contains(permission)) return true;
  return await chrome.permissions.request(permission);
};


const storedProfilesForOrigin = async (origin: string): Promise<GenericBindingProfile[]> => {
  const key = profileStorageKey(origin);
  const stored = await chrome.storage.local.get(key);
  const raw = stored[key];
  if (isProfileForOrigin(raw, origin)) return [raw];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  if (record.protocol !== "bachata-generic-binding-store-v1" || !Array.isArray(record.profiles)) return [];
  return record.profiles.filter((entry) => isProfileForOrigin(entry, origin));
};

const profileMutationQueue = (origin: string): RevisionQueue => {
  const existing = profileMutationQueues.get(origin);
  if (existing) return existing;
  const created = createRevisionQueue();
  profileMutationQueues.set(origin, created);
  return created;
};


export const handleGenericManagementMessage = async (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  isBusy: (tabId: number) => boolean,
): Promise<unknown> => {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined
    || sender.url !== chrome.runtime.getURL("popup/index.html")) {
    throw new Error("Generic management requires the Browser Bridge popup");
  }
  if (message.action === "list") {
    const entries = [];
    const origins = new Set(await storedGenericProfileOrigins());
    const granted = await chrome.permissions.getAll();
    let broaderPermissions = false;
    for (const pattern of granted.origins ?? []) {
      const origin = pattern.endsWith("/*") ? validHttpOrigin(pattern.slice(0, -2)) : undefined;
      if (!origin) { broaderPermissions = true; continue; }
      if (!isBuiltInProviderLocation(origin) && !["http://127.0.0.1", "https://127.0.0.1", "http://localhost", "https://localhost"].includes(origin)) origins.add(origin);
    }
    for (const registration of genericRegistrations()) origins.add(registration.origin);
    for (const origin of [...origins].sort().slice(0, 200)) {
      if (isBuiltInProviderLocation(origin)) continue;
      const profiles = await profileMutationQueue(origin).enqueueRead(() => storedProfilesForOrigin(origin));
      const permitted = await chrome.permissions.contains({ origins: [genericOriginPattern(origin)] });
      if (profiles.length === 0) entries.push({ origin, validated: false, permitted });
      for (const profile of profiles.slice(0, maximumProfilesPerOrigin)) {
        entries.push({ origin, id: await profileIdentity(profile), validated: profile.validated, permitted });
      }
    }
    return { ok: true, entries, truncated: origins.size > 200, broaderPermissions };
  }
  const origin = typeof message.origin === "string" ? validHttpOrigin(message.origin) : undefined;
  if (!origin || isBuiltInProviderLocation(origin)) throw new Error("Choose one exact Generic website origin");
  if (managementOrigins.has(origin)) throw new Error("This site's binding is already being changed");
  if (genericRegistrations().some((registration) => registration.origin === origin && isBusy(registration.tabId))) {
    throw new Error("Finish the active request before changing this site's binding");
  }
  managementOrigins.add(origin);
  try {
    if (message.action === "setup") {
      if (!Number.isSafeInteger(message.tabId) || Number(message.tabId) <= 0) throw new Error("Select a website tab first");
      const tabId = Number(message.tabId);
      let documentId: string | undefined;
      const assertTab = async (): Promise<void> => {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url || new URL(tab.url).origin !== origin || isBusy(tabId)) throw new Error("The selected tab changed or has an active request");
        if (!(await chrome.permissions.contains({ origins: [genericOriginPattern(origin)] }))) {
          throw new Error("Allow access to this exact website before setup");
        }
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
        if (!frame?.documentId || frame.documentLifecycle !== "active" || new URL(frame.url).origin !== origin
          || (documentId !== undefined && documentId !== frame.documentId)) {
          throw new Error("The selected website document changed before setup");
        }
        documentId = frame.documentId;
      };
      await assertTab();
      const setupDocumentId = documentId;
      if (!setupDocumentId) throw new Error("The selected website document is unavailable");
      await ensureGenericContentScript(tabId, setupDocumentId);
      await assertTab();
      const response = await chrome.tabs.sendMessage(tabId, { type: "BACHATA_GENERIC_SETUP" }, { documentId: setupDocumentId });
      if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true) {
        throw new Error("The website could not open its setup controls");
      }
      return { ok: true };
    }
    if (message.action === "remove") {
      if (typeof message.id !== "string" || !/^[a-f0-9]{64}$/.test(message.id)) throw new Error("Invalid saved binding");
      await profileMutationQueue(origin).enqueueMutation(async () => {
        const profiles = await storedProfilesForOrigin(origin);
        const ids = await Promise.all(profiles.map(profileIdentity));
        const index = ids.indexOf(String(message.id));
        if (index < 0) throw new Error("The saved binding changed. Refresh the list before removing it.");
        const remaining = profiles.filter((_, profileIndex) => profileIndex !== index);
        if (remaining.length === 0) await chrome.storage.local.remove(profileStorageKey(origin));
        else await chrome.storage.local.set({ [profileStorageKey(origin)]: { protocol: "bachata-generic-binding-store-v1", profiles: remaining } });
      });
      return { ok: true };
    }
    if (message.action === "revoke") {
      if (message.confirmed !== true) throw new Error("Confirm removal of this site's access first");
      const permission = { origins: [genericOriginPattern(origin)] };
      if (!(await chrome.permissions.remove(permission)) || await chrome.permissions.contains(permission)) {
        throw new Error("Chrome did not revoke this site's access. Its saved bindings were preserved.");
      }
      for (const registration of genericRegistrations()) {
        if (registration.origin === origin) removeGenericRegistration(registration.tabId);
      }
      return { ok: true };
    }
    throw new Error("Unknown Generic management action");
  } finally {
    managementOrigins.delete(origin);
  }
};

const isFingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const upsertProfile = async (
  origin: string,
  profile: GenericBindingProfile,
  expectedTargetHash: unknown,
  expectedSource: unknown,
): Promise<string> => {
  if (expectedTargetHash !== null && !isFingerprint(expectedTargetHash)) {
    throw new Error("Binding version is missing or invalid. Reload setup and try again.");
  }
  return await profileMutationQueue(origin).enqueueMutation(async () => {
    const profiles = await storedProfilesForOrigin(origin);
    const routePattern = profile.routePattern?.trim() || "/*";
    if (expectedSource !== undefined) {
      if (!expectedSource || typeof expectedSource !== "object"
        || !("routePattern" in expectedSource) || typeof expectedSource.routePattern !== "string"
        || !("fingerprint" in expectedSource) || !isFingerprint(expectedSource.fingerprint)) {
        throw new Error("Invalid source binding version");
      }
      const source = profiles.find((entry) => (entry.routePattern?.trim() || "/*") === expectedSource.routePattern);
      if (!source || await profileIdentity(source) !== expectedSource.fingerprint) {
        throw new Error("The saved binding changed or was removed. Reload setup and try again.");
      }
    }
    const current = profiles.find((entry) => (entry.routePattern?.trim() || "/*") === routePattern);
    if ((current ? await profileIdentity(current) : null) !== expectedTargetHash) {
      throw new Error("The saved binding changed or was removed. Reload setup and try again.");
    }
    const nextProfile = { ...profile, routePattern };
    const prior = profiles
      .filter((entry) => (entry.routePattern?.trim() || "/*") !== routePattern)
      .sort((left, right) => (right.lastSuccessfulAt ?? "").localeCompare(left.lastSuccessfulAt ?? ""))
      .slice(0, Math.max(0, maximumProfilesPerOrigin - 1));
    const store: GenericBindingProfileStore = {
      protocol: "bachata-generic-binding-store-v1",
      profiles: [nextProfile, ...prior],
    };
    await chrome.storage.local.set({ [profileStorageKey(origin)]: store });
    return await profileIdentity(nextProfile);
  });
};

export const handleGenericProfileStorageMessage = async (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true; value?: unknown; fingerprints?: string[]; fingerprint?: string } | { ok: false; error: string } | undefined> => {
  if (message.type !== "BACHATA_GENERIC_PROFILE_LIST"
    && message.type !== "BACHATA_GENERIC_PROFILE_UPSERT"
    && message.type !== "BACHATA_GENERIC_PROFILE_CLEAR") {
    return undefined;
  }
  const origin = senderHttpOrigin(sender);
  if (!origin) return { ok: false, error: "Invalid generic binding storage sender" };
  if (message.type === "BACHATA_GENERIC_PROFILE_LIST") {
    return await profileMutationQueue(origin).enqueueRead(async () => {
      const value = await storedProfilesForOrigin(origin);
      return { ok: true as const, value, fingerprints: await Promise.all(value.map(profileIdentity)) };
    });
  }
  if (message.type === "BACHATA_GENERIC_PROFILE_CLEAR") {
    await profileMutationQueue(origin).enqueueMutation(async () => {
      await chrome.storage.local.remove(profileStorageKey(origin));
    });
    await chrome.permissions.remove({ origins: [genericOriginPattern(origin)] }).catch(() => false);
    return { ok: true };
  }
  if (!isProfileForOrigin(message.profile, origin)) {
    return { ok: false, error: "Invalid generic binding profile" };
  }
  if (managementOrigins.has(origin)) return { ok: false, error: "This site's binding is being changed" };
  try {
    const fingerprint = await upsertProfile(origin, message.profile, message.expectedTargetHash, message.expectedSource);
    return { ok: true, fingerprint };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Binding update failed" };
  }
};

const persistGenericRegistrations = async (): Promise<void> => {
  await registrationWriteQueue.enqueue([...registrations.values()]);
};

const parsedRegistration = (value: unknown): GenericRegistration | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.tabId)
    || Number(record.tabId) <= 0
    || !Number.isInteger(record.frameId)
    || Number(record.frameId) < 0
    || typeof record.origin !== "string"
    || typeof record.url !== "string"
    || typeof record.title !== "string"
    || !Number.isInteger(record.documentRevision)
    || Number(record.documentRevision) < 1
    || typeof record.documentToken !== "string"
    || record.documentToken.length < 16
    || record.documentToken.length > 256
    || !Number.isFinite(record.registeredAt)
  ) {
    return undefined;
  }
  try {
    const url = new URL(record.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== record.origin) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    tabId: Number(record.tabId),
    frameId: Number(record.frameId),
    origin: record.origin,
    url: record.url,
    title: record.title,
    documentRevision: Number(record.documentRevision),
    documentToken: record.documentToken as string,
    registeredAt: Number(record.registeredAt),
  };
};

export const restoreGenericRegistrations = async (): Promise<void> => {
  const stored = await chrome.storage.session.get(registrationStorageKey);
  const values = Array.isArray(stored[registrationStorageKey])
    ? stored[registrationStorageKey] as unknown[]
    : [];
  const tabs = await chrome.tabs.query({});
  const tabUrls = new Map<number, string>(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } => Number.isInteger(tab.id) && typeof tab.url === "string")
      .map((tab) => [tab.id, tab.url]),
  );
  for (const value of values) {
    const registration = parsedRegistration(value);
    const currentUrl = registration ? tabUrls.get(registration.tabId) : undefined;
    if (!registration || !currentUrl || registrations.has(registration.tabId)) {
      continue;
    }
    try {
      if (new URL(currentUrl).origin === registration.origin && !isBuiltInProviderLocation(currentUrl)
        && await chrome.permissions.contains({ origins: [genericOriginPattern(registration.origin)] })) {
        registrations.set(registration.tabId, registration);
      }
    } catch {
      // BB-AUD-10. A tab whose current URL will not parse cannot be proved to still be the
      // origin the registration was granted for, so it is left unrestored.
    }
  }
  await persistGenericRegistrations();
};

const menuItems = [
  ["bachata-generic-bind-composer", "Bachata: Bind composer", "composer"],
  ["bachata-generic-bind-conversation", "Bachata: Bind conversation region", "conversationRoot"],
  ["bachata-generic-bind-response", "Bachata: Bind assistant response", "responseMessage"],
  ["bachata-generic-bind-send", "Bachata: Bind send button", "sendButton"],
  ["bachata-generic-bind-stop", "Bachata: Bind stop button", "stopButton"],
  ["bachata-generic-bind-new-conversation", "Bachata: Bind new conversation button", "newConversationButton"],
  ["bachata-generic-validate", "Bachata: Validate browser binding", "validate"],
  ["bachata-generic-auto-heal", "Bachata: Auto-detect browser binding", "autoHeal"],
  ["bachata-generic-selected", "Bachata: Use selected text as response", "selected"],
  ["bachata-generic-readable", "Bachata: Extract readable page", "readable"],
] as const;

const executeGenericScript = async (tabId: number, documentId?: string): Promise<void> => {
  await chrome.scripting.executeScript({
    target: documentId ? { tabId, documentIds: [documentId] } : { tabId, allFrames: false },
    files: ["generic-content.js"],
  });
};

export const ensureGenericContentScript = async (tabId: number, documentId?: string): Promise<void> => {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "BACHATA_GENERIC_STATUS" }, documentId ? { documentId } : {});
    if (result !== undefined) {
      return;
    }
  } catch {
    // BB-AUD-10. No receiver is the expected answer before injection, and it is not
    // distinguishable from any other send failure, so both fall through to injecting.
  }
  await executeGenericScript(tabId, documentId);
};

export const registerGenericContextMenus = async (): Promise<void> => {
  for (const [id] of menuItems) {
    await chrome.contextMenus.remove(id).catch(() => undefined);
  }
  for (const [id, title] of menuItems) {
    chrome.contextMenus.create({
      id,
      title,
      contexts: ["page", "selection", "editable"],
    });
  }
};

export const handleGenericContextMenu = async (
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): Promise<unknown> => {
  if (!tab?.id || typeof info.menuItemId !== "string" || !info.menuItemId.startsWith("bachata-generic-")) {
    return undefined;
  }
  let origin: string;
  try {
    const parsed = new URL(tab.url ?? "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const item = menuItems.find(([id]) => id === info.menuItemId);
  if (!item) {
    return undefined;
  }
  const action = item[2];
  if (isBuiltInProviderLocation(origin) && !builtInProviderMenuActions.has(action)) {
    throw builtInProviderRefusal(`action "${action}"`);
  }
  if (!(await ensureGenericOriginPermission(origin))) {
    throw new Error("Persistent access to the selected generic provider origin was not granted");
  }
  await ensureGenericContentScript(tab.id);
  if (action === "validate") {
    return await chrome.tabs.sendMessage(tab.id, { type: "BACHATA_GENERIC_VALIDATE" });
  }
  if (action === "autoHeal") {
    return await chrome.tabs.sendMessage(tab.id, { type: "BACHATA_GENERIC_AUTO_HEAL" });
  }
  if (action === "selected") {
    return await chrome.tabs.sendMessage(tab.id, { type: "BACHATA_GENERIC_SELECTED_TEXT" });
  }
  if (action === "readable") {
    return await chrome.tabs.sendMessage(tab.id, { type: "BACHATA_GENERIC_READABLE" });
  }
  return await chrome.tabs.sendMessage(tab.id, { type: "BACHATA_GENERIC_BIND", role: action });
};

export const handleGenericContentMessage = async (
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> => {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== "BACHATA_GENERIC_REGISTER" || sender.tab?.id === undefined) {
    return false;
  }
  // Same sender rules as senderHttpOrigin below: this extension only, main frame only, and the
  // frame's own URL rather than the tab's. Injection is allFrames:false so a subframe cannot
  // reach here today, but a registration keyed to the top-level origin while the message came
  // from elsewhere is exactly the confusion worth refusing outright.
  //
  // Residual platform limits, stated rather than papered over: `sender.id` and `sender.frameId`
  // are asserted by the browser, not proven to this worker, and every content script of this
  // extension shares one isolated world per frame. So this check separates frames and other
  // extensions; it does not isolate this extension's own scripts from each other, and it is not
  // a defence against a compromised renderer. The verdict that actually gates unattended runs
  // is held in background session storage for that reason.
  if (sender.id !== chrome.runtime.id || (sender.frameId ?? 0) !== 0) {
    return false;
  }
  let senderUrl: URL;
  try {
    senderUrl = new URL(sender.url ?? sender.tab.url ?? "");
  } catch {
    return false;
  }
  if ((senderUrl.protocol !== "http:" && senderUrl.protocol !== "https:")
    || (typeof record.origin === "string" && record.origin !== senderUrl.origin)
    || isBuiltInProviderLocation(senderUrl.origin)) {
    return false;
  }
  if (managementOrigins.has(senderUrl.origin)
    || !(await chrome.permissions.contains({ origins: [genericOriginPattern(senderUrl.origin)] }))) return false;
  if (managementOrigins.has(senderUrl.origin)) return false;
  let registrationUrl = sender.tab.url ?? "";
  if (typeof record.url === "string") {
    try {
      const candidateUrl = new URL(record.url);
      if (candidateUrl.origin === senderUrl.origin) {
        registrationUrl = candidateUrl.href;
      }
    } catch {
      // BB-AUD-10. The URL the page claims is only ever allowed to refine the one the
      // browser reported. One that will not parse refines nothing, so the sender's own tab
      // URL stands.
    }
  }
  if (typeof record.documentToken !== "string" || record.documentToken.length < 16 || record.documentToken.length > 256) {
    return false;
  }
  const previous = registrations.get(sender.tab.id);
  const documentRevision = Number.isInteger(record.documentRevision) && Number(record.documentRevision) >= 1
    ? Number(record.documentRevision)
    : 1;
  if (previous
    && previous.origin === senderUrl.origin
    && previous.documentToken === record.documentToken
    && documentRevision < previous.documentRevision) {
    return true;
  }
  registrations.set(sender.tab.id, {
    tabId: sender.tab.id,
    frameId: sender.frameId ?? 0,
    origin: senderUrl.origin,
    url: registrationUrl,
    title: typeof record.title === "string" ? record.title : sender.tab.title ?? "",
    documentRevision,
    documentToken: record.documentToken,
    registeredAt: previous?.origin === senderUrl.origin ? previous.registeredAt : Date.now(),
  });
  await persistGenericRegistrations();
  return true;
};

export const removeGenericRegistration = (tabId: number): void => {
  if (registrations.delete(tabId)) {
    void persistGenericRegistrations().catch(() => undefined);
  }
};

export const genericRegistrations = (): GenericRegistration[] =>
  [...registrations.values()].sort((left, right) => right.registeredAt - left.registeredAt);

export type GenericStatus = {
  status: "ready" | "notReady" | "streaming";
  origin: string;
  url: string;
  title: string;
  documentRevision: number;
  documentToken: string;
  capabilities: {
    submission: "verifiedSend" | "syntheticEnter";
    completion: "verifiedLifecycle" | "manualOnly";
    interruption: "confirmed" | "unavailable";
    assets: "textOnly";
    conversationState: "confirmed" | "uncertain";
  };
};

export const genericStatus = async (tabId: number): Promise<GenericStatus> => {
  await ensureGenericContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: "BACHATA_GENERIC_STATUS" });
  if (!response || typeof response !== "object") {
    throw new Error("Generic provider returned no status");
  }
  const record = response as Record<string, unknown>;
  if (record.ok !== true || !record.value || typeof record.value !== "object") {
    throw new Error(typeof record.error === "string" ? record.error : "Generic provider status failed");
  }
  const value = record.value as Record<string, unknown>;
  if ((value.status !== "ready" && value.status !== "notReady" && value.status !== "streaming")
    || typeof value.origin !== "string"
    || typeof value.url !== "string"
    || typeof value.title !== "string"
    || !Number.isInteger(value.documentRevision)
    || typeof value.documentToken !== "string"
    || value.documentToken.length < 16
    || value.documentToken.length > 256
    || !value.capabilities
    || typeof value.capabilities !== "object"
    || Array.isArray(value.capabilities)) {
    throw new Error("Generic provider returned an invalid status");
  }
  const capabilities = value.capabilities as Record<string, unknown>;
  if ((capabilities.submission !== "verifiedSend" && capabilities.submission !== "syntheticEnter")
    || (capabilities.completion !== "verifiedLifecycle" && capabilities.completion !== "manualOnly")
    || (capabilities.interruption !== "confirmed" && capabilities.interruption !== "unavailable")
    || capabilities.assets !== "textOnly"
    || (capabilities.conversationState !== "confirmed" && capabilities.conversationState !== "uncertain")) {
    throw new Error("Generic provider returned invalid capabilities");
  }
  return value as GenericStatus;
};

export const isGenericTab = (tabId: number): boolean => registrations.has(tabId);

const promptFromCommand = (command: GenericCommand): string | undefined => {
  for (const key of ["prompt", "message", "content", "text", "input"]) {
    if (typeof command[key] === "string") {
      return command[key] as string;
    }
  }
  const request = command.request;
  if (request && typeof request === "object") {
    return promptFromCommand({ type: command.type, ...(request as Record<string, unknown>) });
  }
  return undefined;
};

const requestIdFromCommand = (command: GenericCommand): string =>
  String(command.requestId ?? command.id ?? (command.request as Record<string, unknown> | undefined)?.requestId ?? crypto.randomUUID());

export const translateGenericTabCommand = (command: GenericCommand): GenericCommand | undefined => {
  const upper = command.type.toUpperCase();
  if (/CANCEL|INTERRUPT|STOP/.test(upper)) {
    return { type: "BACHATA_GENERIC_CANCEL", requestId: requestIdFromCommand(command) };
  }
  if (/VALIDATE/.test(upper)) {
    return { type: "BACHATA_GENERIC_VALIDATE" };
  }
  if (/READY|PROBE|STATUS/.test(upper)) {
    return { type: "BACHATA_GENERIC_STATUS" };
  }
  if (/SEND|SUBMIT|REQUEST|PROMPT|GENERATE/.test(upper)) {
    const prompt = promptFromCommand(command);
    if (!prompt) {
      return undefined;
    }
    return {
      type: "BACHATA_GENERIC_SEND",
      requestId: requestIdFromCommand(command),
      prompt,
      ...(typeof command.documentToken === "string" ? { documentToken: command.documentToken } : {}),
      ...(Number.isInteger(command.documentRevision) ? { documentRevision: command.documentRevision } : {}),
      ...(typeof command.conversationUrl === "string" ? { conversationUrl: command.conversationUrl } : {}),
      ...(typeof command.conversationIdentity === "string" ? { conversationIdentity: command.conversationIdentity } : {}),
      deadlineAt: Number.isSafeInteger(command.deadlineAt)
        ? Number(command.deadlineAt)
        : Date.now() + 30 * 60_000,
    };
  }
  return undefined;
};

export const sendGenericCommand = async (
  tabId: number,
  command: GenericCommand,
  options: { ensureContent?: boolean } = {},
): Promise<unknown> => {
  let translated = translateGenericTabCommand(command) ?? command;
  const assertManagementIdle = (): void => {
    const registration = registrations.get(tabId);
    if (translated.type === "BACHATA_GENERIC_SEND" && registration && managementOrigins.has(registration.origin)) {
      throw new Error("The Generic binding is being changed. No prompt was sent.");
    }
  };
  assertManagementIdle();
  if (!builtInProviderCommandTypes.has(translated.type)) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.url !== undefined && isBuiltInProviderLocation(tab.url)) {
      throw builtInProviderRefusal(`command "${translated.type}"`);
    }
  }
  if (options.ensureContent !== false) await ensureGenericContentScript(tabId);
  if (translated.type === "BACHATA_GENERIC_SEND"
    && (typeof translated.documentToken !== "string"
      || !Number.isInteger(translated.documentRevision)
      || typeof translated.conversationUrl !== "string"
      || typeof translated.conversationIdentity !== "string")) {
    const status = await genericStatus(tabId);
    const url = new URL(status.url);
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    const conversationUrl = url.toString();
    translated = {
      ...translated,
      documentToken: status.documentToken,
      documentRevision: status.documentRevision,
      conversationUrl,
      conversationIdentity: `generic:${conversationUrl}`,
    };
  }
  if (translated.type === "BACHATA_GENERIC_SEND") {
    const tab = await chrome.tabs.get(tabId);
    const origin = tab.url ? validHttpOrigin(new URL(tab.url).origin) : undefined;
    if (!origin || isBuiltInProviderLocation(origin)
      || !(await chrome.permissions.contains({ origins: [genericOriginPattern(origin)] }))) {
      throw new Error("Website access is unavailable. No prompt was sent.");
    }
    if (managementOrigins.has(origin)) throw new Error("The Generic binding is being changed. No prompt was sent.");
  }
  assertManagementIdle();
  const response = await chrome.tabs.sendMessage(tabId, translated);
  if (!response || typeof response !== "object") {
    return response;
  }
  const record = response as Record<string, unknown>;
  const value = record.value;
  if (translated.type === "BACHATA_GENERIC_SEND" && record.ok === true && value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    const text = typeof result.text === "string"
      ? result.text
      : typeof result.markdown === "string"
        ? result.markdown
        : "";
    const markdown = typeof result.markdown === "string" ? result.markdown : text;
    return {
      ...record,
      requestId: requestIdFromCommand(command),
      text,
      responseText: text,
      markdown,
      content: text,
      segments: result.segments,
      result,
      status: "completed",
    };
  }
  return response;
};

export const bindCurrentGenericTab = async (): Promise<GenericRegistration> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !tab.url?.startsWith("http")) {
    throw new Error("Select a normal HTTP(S) browser-LLM tab first");
  }
  const origin = new URL(tab.url).origin;
  if (isBuiltInProviderLocation(origin)) {
    throw builtInProviderRefusal("binding");
  }
  if (!(await ensureGenericOriginPermission(origin))) {
    throw new Error("Persistent access to the selected generic provider origin was not granted");
  }
  await ensureGenericContentScript(tab.id);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const registration = registrations.get(tab.id);
    if (registration) {
      return registration;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Generic provider content script did not register");
};
