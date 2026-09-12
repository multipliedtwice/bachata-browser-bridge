import { create } from "./dom.js";
import { installGenericManagement } from "./genericManagement.js";
import { normalizeBridgeEndpoint } from "../background/endpoint.js";
import { POPUP_LIMITS, isPopupCapabilities, popupCapabilityDescription } from "../background/popupProjection.js";
import type { BrowserSessionCapabilities } from "../protocol/types.js";
import { isPopupRecovery, popupRecoveryDescription, type PopupRecovery } from "../background/popupRecovery.js";

type Provider = "chatgpt" | "claude" | "generic";
type SessionStatus =
  | "unregistered"
  | "disconnected"
  | "notAuthenticated"
  | "notReady"
  | "ready"
  | "submitting"
  | "streaming"
  | "failed";

type PopupTab = {
  id: number;
  provider: Provider;
  title: string;
  url: string;
  status: SessionStatus;
  ready: boolean;
  reason: string;
  sessionId?: string;
  conversationUrl?: string;
  conversationIdentity?: string;
  capabilities?: BrowserSessionCapabilities;
  recovery?: PopupRecovery;
  manualSelectionAvailable?: boolean;
};

type State = {
  revision: number;
  endpoint?: string;
  selectedTabId?: number;
  connected: boolean;
  connecting: boolean;
  retryInMs?: number;
  error?: string;
  tabs: PopupTab[];
};

type ErrorResponse = {
  success: false;
  revision?: number;
  error: string;
};

type ErrorScope = "connection" | "pairing" | "binding";

type Row = {
  root: HTMLLIElement;
  avatar: HTMLSpanElement;
  favicon: HTMLImageElement;
  monogram: HTMLSpanElement;
  title: HTMLSpanElement;
  meta: HTMLSpanElement;
  tabInfo: HTMLSpanElement;
  identity: HTMLSpanElement;
  badge: HTMLSpanElement;
  reason: HTMLParagraphElement;
  capabilities: HTMLParagraphElement;
  capabilityDetails: HTMLParagraphElement;
  recovery: HTMLParagraphElement;
  recover: HTMLButtonElement;
  bind: HTMLButtonElement;
  unbind: HTMLButtonElement;
  chip: HTMLSpanElement;
  actions: HTMLDivElement;
};

const root = document.getElementById("root") as HTMLElement | null;
const bindingStatus = document.getElementById("binding-status") as HTMLElement | null;
if (!root || !bindingStatus) {
  throw new Error("Missing popup root elements");
}

let state: State = {
  revision: 0,
  connected: false,
  connecting: false,
  tabs: [],
};
// The port is a setting with a default, so the endpoint is canonical unless the reader changed
// it. Prefilling it is what lets pairing be one paste: the reader carries only the secret, and a
// clipboard a hostile process can write cannot redirect the Bridge to a port of its choosing.
const canonicalEndpoint = "ws://127.0.0.1:43127/bachata-browser-bridge-v9";
// `randomBytes(32).toString("base64url")` on the VS Code side: 43 unpadded base64url characters.
const pairingTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
let endpointDraft = "";
let endpointInitialized = false;
let endpointDirty = false;
let tokenDraft = "";
let tokenVisible = false;
let tokenError = "";
let pasting = false;
let editingConnection = false;
let connectionOpen = false;
let choosingConversation = false;
let errorScope: ErrorScope = "connection";
let errorOccurrence = 0;
let dismissedErrorOccurrence = -1;
let pending = false;
let refreshing = false;
let lastBindingKey = "none";
let tokenEditRevision = 0;
// BB-R26-03. Revision of the whole pairing intent (not just the token): any endpoint/token edit or
// competing pair/cancel/disconnect advances it, so a deferred Paste & Pair that captured an older
// value refuses to pair.
let pairingIntentRevision = 0;
const invalidatePairingIntent = (): void => {
  pairingIntentRevision += 1;
};

const isSessionStatus = (value: unknown): value is SessionStatus =>
  value === "unregistered" ||
  value === "disconnected" ||
  value === "notAuthenticated" ||
  value === "notReady" ||
  value === "ready" ||
  value === "submitting" ||
  value === "streaming" ||
  value === "failed";

// BR-G6-15. One set of numbers, held where the projection is built and enforced here. Two
// copies is how the popup came to reject a whole state for a value the worker was happy to send.
const maximumPopupTabs = POPUP_LIMITS.tabs;
const textLimits = POPUP_LIMITS;

const hasOnlyKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isBoundedString = (value: unknown, maximum: number): boolean =>
  typeof value === "string" && value.length <= maximum;

const isOptionalBoundedString = (value: unknown, maximum: number): boolean =>
  value === undefined || isBoundedString(value, maximum);

const isPopupTab = (value: unknown): value is PopupTab => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, [
    "id",
    "provider",
    "title",
    "url",
    "status",
    "ready",
    "reason",
    "sessionId",
    "conversationUrl",
    "conversationIdentity",
    "capabilities",
    "recovery",
    "manualSelectionAvailable",
  ])) {
    return false;
  }
  const candidate = value as Partial<PopupTab>;
  return (
    Number.isInteger(candidate.id) &&
    (candidate.id as number) > 0 &&
    (candidate.provider === "chatgpt" || candidate.provider === "claude" || candidate.provider === "generic") &&
    isBoundedString(candidate.title, textLimits.title) &&
    isBoundedString(candidate.url, textLimits.url) &&
    isSessionStatus(candidate.status) &&
    typeof candidate.ready === "boolean" &&
    isBoundedString(candidate.reason, textLimits.reason) &&
    isOptionalBoundedString(candidate.sessionId, textLimits.sessionId) &&
    isOptionalBoundedString(candidate.conversationUrl, textLimits.conversationUrl) &&
    isOptionalBoundedString(candidate.conversationIdentity, textLimits.conversationIdentity) &&
    (candidate.capabilities === undefined || isPopupCapabilities(candidate.capabilities)) &&
    (candidate.recovery === undefined || isPopupRecovery(candidate.recovery)) &&
    (candidate.manualSelectionAvailable === undefined || typeof candidate.manualSelectionAvailable === "boolean")
  );
};

const isState = (value: unknown): value is State => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, [
    "revision",
    "endpoint",
    "selectedTabId",
    "connected",
    "connecting",
    "retryInMs",
    "error",
    "tabs",
  ])) {
    return false;
  }
  const candidate = value as Partial<State>;
  if (
    !Number.isInteger(candidate.revision) ||
    (candidate.revision as number) < 0 ||
    typeof candidate.connected !== "boolean" ||
    typeof candidate.connecting !== "boolean" ||
    !isOptionalBoundedString(candidate.endpoint, textLimits.endpoint) ||
    !isOptionalBoundedString(candidate.error, textLimits.error)
  ) {
    return false;
  }
  if (
    candidate.retryInMs !== undefined &&
    (typeof candidate.retryInMs !== "number" ||
      !Number.isFinite(candidate.retryInMs) ||
      candidate.retryInMs < 0)
  ) {
    return false;
  }
  if (
    candidate.selectedTabId !== undefined &&
    (!Number.isInteger(candidate.selectedTabId) || candidate.selectedTabId <= 0)
  ) {
    return false;
  }
  if (
    !Array.isArray(candidate.tabs) ||
    candidate.tabs.length > maximumPopupTabs ||
    !candidate.tabs.every(isPopupTab)
  ) {
    return false;
  }
  const ids = new Set(candidate.tabs.map((tab) => tab.id));
  return ids.size === candidate.tabs.length;
};

const isErrorResponse = (value: unknown): value is ErrorResponse => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["success", "revision", "error"])) {
    return false;
  }
  const candidate = value as Partial<ErrorResponse>;
  if (
    candidate.revision !== undefined &&
    (!Number.isInteger(candidate.revision) || candidate.revision < 0)
  ) {
    return false;
  }
  return candidate.success === false && isBoundedString(candidate.error, textLimits.error);
};

const call = async (message: unknown): Promise<unknown> =>
  chrome.runtime.sendMessage(message);

const setText = (element: HTMLElement, value: string): void => {
  if (element.textContent !== value) {
    element.textContent = value;
  }
};

const setHidden = (element: HTMLElement, hidden: boolean): void => {
  if (element.hidden !== hidden) {
    element.hidden = hidden;
  }
};

const setDisabled = (element: HTMLButtonElement | HTMLInputElement, disabled: boolean): void => {
  if (element.disabled !== disabled) {
    element.disabled = disabled;
  }
};

const setClassName = (element: HTMLElement, value: string): void => {
  if (element.className !== value) {
    element.className = value;
  }
};

const setTitle = (element: HTMLElement, value: string): void => {
  if (element.title !== value) {
    element.title = value;
  }
};

const providerName = (provider: Provider): string =>
  provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "Generic";

const statusLabel = (status: SessionStatus): string => {
  if (status === "notAuthenticated") return "Sign-in required";
  if (status === "notReady") return "Not ready";
  if (status === "unregistered") return "Not inspected";
  return status.charAt(0).toUpperCase() + status.slice(1);
};

const canonicalHost = (provider: Provider): string =>
  provider === "chatgpt" ? "chatgpt.com" : provider === "claude" ? "claude.ai" : "";

const hostOf = (value: string): string => {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};

const displayUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return value;
  }
};

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Clipboard read timed out"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const faviconUrl = (tab: PopupTab): string =>
  tab.url ? chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`) : "";

const metaHost = (tab: PopupTab): string => {
  const host = hostOf(tab.url);
  return host === canonicalHost(tab.provider) ? "" : host;
};

const quietStatus = (status: SessionStatus): boolean =>
  status === "ready" || status === "streaming" || status === "submitting";

const tabTitle = (tab: PopupTab): string =>
  tab.title.trim() || displayUrl(tab.url) || "Untitled conversation";

const avatarLetter = (tab: PopupTab): string => {
  if (tab.provider === "chatgpt") return "G";
  if (tab.provider === "claude") return "C";
  return hostOf(tab.url).charAt(0).toUpperCase() || "?";
};

const endpointProblem = (value: string): string => {
  if (!value.trim()) {
    return "";
  }
  try {
    normalizeBridgeEndpoint(value);
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};

const boundTab = (): PopupTab | undefined =>
  state.tabs.find((tab) => tab.id === state.selectedTabId);

const scopeFor = (type: string | undefined): ErrorScope => {
  if (type === "popup.pair") return "pairing";
  if (type === "popup.select" || type === "popup.deselect" || type === "popup.discover" || type === "popup.recover") return "binding";
  return "connection";
};

const messageType = (message: unknown): string | undefined => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  return typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : undefined;
};

const buildDom = () => {
  const heading = create("h1", { text: "Bachata" });
  const brandLabel = create("p", { className: "brand-label", text: "Browser Bridge" });
  const brandName = create("div", { className: "brand-name" });
  brandName.append(heading, brandLabel);
  const brandIcon = create("img", { className: "brand-icon" });
  brandIcon.src = "../icon.png";
  brandIcon.alt = "";
  const subtitle = create("p", { id: "subtitle", className: "subtitle", text: "Connect your browser chats to workflows in VS Code." });
  const connectionPill = create("button", { id: "connection", className: "pill disconnected" });
  connectionPill.type = "button";
  connectionPill.setAttribute("aria-controls", "connection-section");
  connectionPill.title = "Connection settings";
  const connectionState = create("span", { id: "connection-state", className: "sr-only" });
  connectionState.setAttribute("role", "status");
  connectionState.setAttribute("aria-live", "polite");
  const brand = create("div", { className: "brand" });
  brand.append(brandIcon, brandName, connectionPill, connectionState);
  const header = create("header");
  header.append(brand, subtitle);

  const connectionNoticeText = create("span", { id: "connection-error", className: "grow" });
  const connectionDismiss = create("button", { id: "connection-dismiss", className: "ghost small", text: "Dismiss" });
  const connectionNotice = create("div", { id: "connection-notice", className: "notice" });
  connectionNotice.setAttribute("role", "alert");
  connectionNotice.append(connectionNoticeText, connectionDismiss);

  const endpointSummary = create("code", { id: "endpoint-summary" });
  const editConnection = create("button", { id: "edit-connection", className: "ghost small", text: "Edit" });
  const disconnect = create("button", { id: "disconnect", className: "ghost small", text: "Disconnect" });
  const summary = create("div", { id: "connection-summary", className: "connection-summary" });
  summary.append(endpointSummary, editConnection, disconnect);

  const endpointLabel = create("label", { text: "Local connection address" });
  endpointLabel.setAttribute("for", "endpoint");
  const endpointInput = create("input", { id: "endpoint" });
  endpointInput.placeholder = canonicalEndpoint;
  endpointInput.autocomplete = "off";
  endpointInput.spellcheck = false;
  const endpointError = create("p", { id: "endpoint-error", className: "field-error" });
  endpointInput.setAttribute("aria-describedby", "endpoint-hint endpoint-error");
  const endpointHint = create("p", { id: "endpoint-hint", className: "hint", text: "Change this only if Bachata in VS Code uses a different local address." });
  const advanced = create("details", { id: "connection-advanced" });
  advanced.open = false;
  advanced.append(create("summary", { text: "Connection settings" }), endpointLabel, endpointInput, endpointError, endpointHint);

  const tokenLabel = create("label", { text: "Pairing token" });
  tokenLabel.setAttribute("for", "token");
  const tokenInput = create("input", { id: "token" });
  tokenInput.type = "password";
  tokenInput.placeholder = "Paste from VS Code";
  tokenInput.autocomplete = "off";
  tokenInput.spellcheck = false;
  const tokenPaste = create("button", { id: "token-paste", className: "ghost small", text: "Paste" });
  tokenPaste.type = "button";
  const tokenPastePair = create("button", { id: "token-paste-pair", className: "primary grow", text: "Paste & connect" });
  tokenPastePair.type = "button";
  const tokenReveal = create("button", { id: "token-reveal", className: "ghost small", text: "Show" });
  tokenReveal.type = "button";
  const tokenActions = create("div", { className: "token-actions" });
  tokenActions.append(tokenPaste, tokenReveal);
  const tokenHeading = create("div", { className: "field-heading" });
  tokenHeading.append(tokenLabel, tokenActions);
  const tokenField = create("div", { className: "token-field" });
  tokenField.append(tokenHeading, tokenInput);
  const tokenErrorText = create("p", { id: "token-error", className: "field-error" });
  tokenErrorText.setAttribute("role", "alert");
  const tokenHint = create("p", { id: "token-hint", className: "hint", text: "Copy the pairing token from Bachata’s Browser Bridge settings in VS Code." });

  tokenInput.setAttribute("aria-describedby", "token-hint token-error");
  tokenReveal.setAttribute("aria-controls", "token");
  const pair = create("button", { id: "pair", className: "primary grow", text: "Connect to VS Code" });
  pair.type = "submit";
  const cancelConnect = create("button", { id: "cancel-connect", className: "ghost", text: "Cancel" });
  cancelConnect.type = "button";
  const cancelEdit = create("button", { id: "cancel-edit", className: "ghost", text: "Keep current" });
  cancelEdit.type = "button";
  const formActions = create("div", { className: "row form-actions" });
  formActions.append(tokenPastePair, pair, cancelConnect, cancelEdit);

  const form = create("form", { id: "pairing-form" });
  form.append(tokenHint, tokenField, tokenErrorText, formActions, advanced);

  const retryText = create("span", { id: "retry-text" });
  const reconnect = create("button", { id: "reconnect", className: "small", text: "Reconnect now" });
  reconnect.type = "button";
  const retry = create("div", { id: "retry", className: "retry" });
  retry.append(retryText, reconnect);

  const connectionSection = create("section", { id: "connection-section" });
  connectionSection.append(connectionNotice, summary, form, retry);

  const conversationsHeading = create("h2", { id: "conversations-heading", text: "Conversations" });
  const refresh = create("button", { id: "refresh", className: "ghost small", text: "Refresh tabs" });
  const changeConversation = create("button", { id: "change-conversation", className: "ghost small", text: "Change conversation" });
  changeConversation.type = "button";
  const doneChoosing = create("button", { id: "done-choosing", className: "ghost small", text: "Done" });
  doneChoosing.type = "button";
  refresh.type = "button";
  const conversationsHead = create("div", { className: "section-heading" });
  conversationsHead.append(conversationsHeading, doneChoosing, refresh, changeConversation);

  const bindingNoticeText = create("span", { id: "binding-error", className: "grow" });
  const bindingDismiss = create("button", { id: "binding-dismiss", className: "ghost small", text: "Dismiss" });
  const bindingNotice = create("div", { id: "binding-notice", className: "notice" });
  bindingNotice.setAttribute("role", "alert");
  bindingNotice.append(bindingNoticeText, bindingDismiss);

  const selectionHint = create("p", { id: "selection-hint", className: "hint", text: "Connect to VS Code above to use one of these chats." });
  const empty = create("p", { id: "tabs-empty", className: "hint" });
  const list = create("ul", { id: "tab-list", className: "tab-list" });
  list.setAttribute("aria-labelledby", "conversations-heading");

  const conversationsSection = create("section", { id: "conversations-section" });
  conversationsSection.append(conversationsHead, bindingNotice, selectionHint, empty, list);

  const main = create("main");
  main.append(header, connectionSection, conversationsSection);
  root.replaceChildren(main);

  return {
    connectionPill,
    connectionState,
    connectionSection,
    subtitle,
    connectionNotice,
    connectionNoticeText,
    connectionDismiss,
    summary,
    endpointSummary,
    editConnection,
    disconnect,
    form,
    endpointInput,
    advanced,
    endpointError,
    tokenInput,
    tokenPaste,
    tokenPastePair,
    tokenReveal,
    tokenErrorText,
    pair,
    cancelConnect,
    cancelEdit,
    retry,
    retryText,
    reconnect,
    conversationsSection,
    conversationsHeading,
    refresh,
    changeConversation,
    doneChoosing,
    bindingNotice,
    bindingNoticeText,
    bindingDismiss,
    empty,
    selectionHint,
    list,
  };
};

const dom = buildDom();
const rows = new Map<number, Row>();
installGenericManagement(dom.conversationsSection);

const createRow = (tabId: number): Row => {
  const avatar = create("span", { className: "avatar" });
  const monogram = create("span", { className: "monogram" });
  const favicon = create("img", { id: `favicon-${String(tabId)}`, className: "favicon" });
  favicon.alt = "";
  favicon.addEventListener("error", () => {
    setHidden(favicon, true);
  });
  avatar.append(monogram, favicon);
  const title = create("span", { className: "tab-title" });
  const meta = create("span", { className: "tab-meta" });
  const tabInfo = create("span", { className: "tab-meta", text: `tab ${String(tabId)}` });
  const identity = create("span", { className: "tab-identity" });
  title.setAttribute("dir", "auto");
  identity.setAttribute("dir", "auto");
  const badge = create("span", { className: "badge" });
  const head = create("div", { className: "tab-head" });
  head.append(avatar, title, badge);

  const reason = create("p", { className: "tab-reason" });
  const chip = create("span", { className: "badge bound-chip", text: "Selected" });
  const bind = create("button", { id: `bind-${String(tabId)}`, className: "small", text: "Use this chat" });
  bind.type = "button";
  const unbind = create("button", { id: `unbind-${String(tabId)}`, className: "ghost small", text: "Stop using" });
  unbind.type = "button";
  const actions = create("div", { className: "tab-actions" });
  actions.append(chip, unbind, bind);

  const rowRoot = create("li", { className: "tab-row" });
  const capabilities = create("p", { id: `capabilities-${String(tabId)}`, className: "hint" });
  const capabilityDetails = create("p", { id: `capability-details-${String(tabId)}`, className: "hint" });
  const recovery = create("p", { id: `recovery-${String(tabId)}`, className: "hint" });
  const recover = create("button", { id: `recover-${String(tabId)}`, className: "primary small", text: "Open conversation" });
  recover.type = "button";
  recover.addEventListener("click", () => {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    void apply({ type: "popup.recover", tabId, action: tab.manualSelectionAvailable ? "selected" : "open" });
  });
  const disclosure = create("details");
  disclosure.append(create("summary", { text: "Details" }), capabilityDetails, tabInfo, identity);
  rowRoot.append(head, meta, capabilities, reason, recovery, recover, actions, disclosure);

  bind.addEventListener("click", () => {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab?.ready || !state.connected || tabId === state.selectedTabId) {
      return;
    }
    void apply({ type: "popup.select", tabId });
  });
  unbind.addEventListener("click", () => {
    void apply({ type: "popup.deselect" });
  });

  return { root: rowRoot, avatar, favicon, monogram, title, meta, tabInfo, identity, badge, reason, capabilities, capabilityDetails, recovery, recover, bind, unbind, chip, actions };
};

const renderRow = (row: Row, tab: PopupTab, showList: boolean): void => {
  const bound = tab.id === state.selectedTabId;
  const identity = tab.conversationIdentity ?? tab.conversationUrl ?? "";
  setClassName(row.root, bound ? "tab-row bound" : "tab-row");
  setClassName(row.avatar, `avatar ${tab.provider}`);
  setText(row.monogram, avatarLetter(tab));
  const icon = faviconUrl(tab);
  if (icon === "") {
    row.favicon.removeAttribute("src");
    setHidden(row.favicon, true);
  } else if (row.favicon.getAttribute("src") !== icon) {
    row.favicon.setAttribute("src", icon);
    setHidden(row.favicon, false);
  }
  const label = tabTitle(tab);
  setText(row.title, label);
  setTitle(row.title, label);
  setText(
    row.meta,
    [providerName(tab.provider), metaHost(tab)].filter(Boolean).join(" · "),
  );
  setTitle(row.meta, displayUrl(tab.url));
  setText(row.identity, identity);
  setTitle(row.identity, identity);
  setHidden(row.identity, identity === "");
  setClassName(row.badge, `badge status-${tab.status}`);
  setText(row.badge, statusLabel(tab.status));
  setText(row.reason, tab.reason);
  setTitle(row.reason, tab.reason);
  setHidden(row.reason, quietStatus(tab.status));
  const description = popupCapabilityDescription(tab.capabilities);
  setText(row.capabilities, description.summary);
  setText(row.capabilityDetails, description.details);
  const recoveryText = tab.recovery ? popupRecoveryDescription(tab.recovery) : "";
  const manualText = tab.manualSelectionAvailable ? "Select the completed answer on the website, then use it here. This may stop generation and completes the existing request without replaying its prompt." : "";
  setText(row.recovery, [recoveryText, manualText].filter(Boolean).join(" "));
  setHidden(row.recovery, !tab.recovery && !tab.manualSelectionAvailable);
  setHidden(row.recover, !tab.recovery && !tab.manualSelectionAvailable);
  setText(row.recover, tab.manualSelectionAvailable ? "Use selected response" : "Open conversation");
  setDisabled(row.recover, pending);
  const bindable = !bound && state.connected && tab.ready;
  setClassName(row.bind, tab.recovery || tab.manualSelectionAvailable ? "ghost small" : "small");
  setHidden(row.chip, !bound || !showList);
  setHidden(row.unbind, !bound);
  setHidden(row.bind, !bindable);
  setHidden(row.actions, !bound && !bindable);
  setDisabled(row.bind, pending);
  setDisabled(row.unbind, pending);
  row.bind.setAttribute("aria-label", `Use ${label} on tab ${String(tab.id)}`);
  row.unbind.setAttribute("aria-label", `Stop using ${label} on tab ${String(tab.id)}`);
};

const focusFallback = (): void => {
  if (document.activeElement !== null && document.activeElement !== document.body) {
    return;
  }
  for (const candidate of [dom.changeConversation, dom.doneChoosing, dom.refresh, dom.connectionPill]) {
    if (!candidate.hidden && !candidate.disabled) {
      candidate.focus();
      return;
    }
  }
};

const restoreFocus = (activeId: string): void => {
  if (!activeId) {
    return;
  }
  for (const row of rows.values()) {
    if (row.bind.id === activeId || row.unbind.id === activeId) {
      const unreachable = (button: HTMLButtonElement): boolean =>
        row.root.hidden || button.hidden || button.disabled;
      const preferred = row.bind.id === activeId ? row.bind : row.unbind;
      const fallback = row.bind.id === activeId ? row.unbind : row.bind;
      const target = unreachable(preferred) ? fallback : preferred;
      if (unreachable(target)) {
        focusFallback();
        return;
      }
      if (document.activeElement !== target) {
        target.focus();
      }
      return;
    }
  }
  if ((activeId === dom.pair.id && dom.pair.hidden)
    || (activeId === dom.tokenPastePair.id && dom.tokenPastePair.hidden)) {
    if (!dom.form.hidden && !dom.connectionSection.hidden) {
      const target = dom.pair.hidden ? dom.tokenPastePair : dom.pair;
      if (!target.disabled) target.focus();
      else dom.tokenInput.focus();
      return;
    }
  }
  const element = document.getElementById(activeId);
  if (!element || element.hidden) {
    focusFallback();
    return;
  }
  if (document.activeElement !== element) {
    element.focus();
  }
};

const renderRows = (showList: boolean): void => {
  for (const [tabId, row] of rows) {
    if (!state.tabs.some((tab) => tab.id === tabId)) {
      row.root.remove();
      rows.delete(tabId);
    }
  }
  state.tabs.forEach((tab, index) => {
    const existing = rows.get(tab.id) ?? createRow(tab.id);
    rows.set(tab.id, existing);
    renderRow(existing, tab, showList);
    setHidden(existing.root, !showList && tab.id !== state.selectedTabId);
    if (dom.list.children[index] !== existing.root) {
      dom.list.insertBefore(existing.root, dom.list.children[index] ?? null);
    }
  });
};

const announceBindingChange = (): void => {
  const tab = boundTab();
  const key = tab
    ? `${tab.id}:${tab.provider}:${tab.conversationIdentity ?? tab.conversationUrl ?? tab.url}`
    : "none";
  if (key === lastBindingKey) {
    return;
  }
  lastBindingKey = key;
  bindingStatus.textContent = tab
    ? `Bound to ${providerName(tab.provider)} conversation ${tabTitle(tab)}.`
    : "Provider conversation unbound.";
};

const visibleError = (): string =>
  state.error !== undefined && dismissedErrorOccurrence !== errorOccurrence ? state.error : "";

const renderNotices = (): void => {
  const visible = visibleError();
  const inBinding = visible !== "" && errorScope === "binding";
  setText(dom.connectionNoticeText, inBinding ? "" : visible);
  setHidden(dom.connectionNotice, visible === "" || inBinding);
  setText(dom.bindingNoticeText, inBinding ? visible : "");
  setHidden(dom.bindingNotice, !inBinding);
};

const render = (): void => {
  const activeId = document.activeElement?.id ?? "";
  const connectionLabel = state.connected
    ? "Connected"
    : state.connecting
      ? "Connecting"
      : "Disconnected";
  const connectionClass = state.connected ? "connected" : state.connecting ? "connecting" : "disconnected";
  setClassName(dom.connectionPill, `pill ${connectionClass}`);
  setText(dom.connectionPill, connectionLabel);
  setText(dom.connectionState, `Bridge ${connectionLabel.toLowerCase()}.`);
  const showConnection = connectionOpen
    || !state.connected
    || (visibleError() !== "" && errorScope !== "binding");
  setHidden(dom.connectionSection, !showConnection);
  dom.connectionPill.setAttribute("aria-expanded", showConnection ? "true" : "false");

  const collapsed = state.connected && !editingConnection;
  setHidden(dom.summary, !collapsed);
  setHidden(dom.form, collapsed);
  const activeEndpoint = state.endpoint ?? endpointDraft;
  setText(dom.endpointSummary, hostOf(activeEndpoint));
  setTitle(dom.endpointSummary, activeEndpoint);
  setHidden(dom.subtitle, state.connected);
  setDisabled(dom.editConnection, pending);
  setDisabled(dom.disconnect, pending);

  if (dom.endpointInput !== document.activeElement && dom.endpointInput.value !== endpointDraft) {
    dom.endpointInput.value = endpointDraft;
  }
  const problem = endpointProblem(endpointDraft);
  setText(dom.endpointError, problem);
  setHidden(dom.endpointError, problem === "");
  dom.endpointInput.classList.toggle("invalid", problem !== "");
  dom.endpointInput.setAttribute("aria-invalid", problem !== "" ? "true" : "false");
  if (problem !== "") dom.advanced.open = true;
  setDisabled(dom.endpointInput, pending);
  setDisabled(dom.tokenInput, pending);
  setDisabled(dom.tokenPaste, pending || pasting);
  setDisabled(dom.tokenPastePair, pending || pasting || !endpointDraft.trim() || problem !== "");
  setDisabled(dom.tokenReveal, pending || tokenDraft === "");
  setText(dom.tokenErrorText, tokenError);
  setHidden(dom.tokenErrorText, tokenError === "");
  setText(dom.tokenReveal, tokenVisible ? "Hide" : "Show");
  dom.tokenReveal.setAttribute("aria-label", tokenVisible ? "Hide pairing token" : "Show pairing token");
  dom.tokenReveal.setAttribute("aria-pressed", tokenVisible ? "true" : "false");
  dom.tokenInput.setAttribute("aria-invalid", tokenError !== "" ? "true" : "false");
  setHidden(dom.tokenPastePair, tokenDraft.trim() !== "");
  setHidden(dom.pair, tokenDraft.trim() === "");
  setText(dom.tokenPastePair, pasting ? "Reading clipboard…" : pending ? "Please wait…" : "Paste & connect");
  setText(dom.pair, pending ? "Please wait…" : "Connect to VS Code");
  if (dom.tokenInput.type !== (tokenVisible ? "text" : "password")) {
    dom.tokenInput.type = tokenVisible ? "text" : "password";
  }
  setDisabled(dom.pair, pending || !endpointDraft.trim() || !tokenDraft.trim() || problem !== "");
  setHidden(dom.cancelConnect, !state.connecting);
  setDisabled(dom.cancelConnect, pending);
  setHidden(dom.cancelEdit, !(state.connected && editingConnection));
  setDisabled(dom.cancelEdit, pending);

  const retrying = typeof state.retryInMs === "number" && state.retryInMs > 0;
  setHidden(dom.retry, !retrying);
  setText(dom.retryText, retrying ? `Retrying in ${String(Math.ceil((state.retryInMs ?? 0) / 1000))}s` : "");
  setDisabled(dom.reconnect, pending);

  const bound = boundTab();
  const showList = bound === undefined || choosingConversation;
  setText(dom.conversationsHeading, showList ? "Choose a chat" : "Selected chat");
  setDisabled(dom.refresh, pending);
  setHidden(dom.refresh, !showList);
  setHidden(dom.changeConversation, showList);
  setDisabled(dom.changeConversation, pending);
  setHidden(dom.doneChoosing, !(showList && bound !== undefined));
  setDisabled(dom.doneChoosing, pending);
  setClassName(dom.conversationsSection, showList && showConnection ? "" : "roomy");
  const empty = state.tabs.length === 0;
  setHidden(dom.selectionHint, state.connected || empty);
  setText(dom.empty, empty ? "Open a ChatGPT or Claude conversation and sign in, then refresh tabs. For another website, use the setup below." : "");
  setHidden(dom.empty, !empty || !showList);

  renderNotices();
  renderRows(showList);
  restoreFocus(activeId);
  announceBindingChange();
};

const replaceState = (nextState: State): boolean => {
  if (!endpointInitialized) {
    endpointInitialized = true;
    if (!endpointDirty) {
      endpointDraft = nextState.endpoint ?? canonicalEndpoint;
    }
  } else if (!endpointDirty && dom.endpointInput !== document.activeElement) {
    endpointDraft = nextState.endpoint ?? canonicalEndpoint;
  }
  if (JSON.stringify(nextState) === JSON.stringify(state)) {
    return false;
  }
  if (nextState.error !== state.error) {
    errorOccurrence += 1;
  }
  state = nextState;
  return true;
};

const mergeState = (response: unknown): boolean => {
  if (isState(response)) {
    if (response.revision >= state.revision) {
      return replaceState(response);
    }
    return false;
  }
  if (isErrorResponse(response)) {
    if (response.revision === undefined || response.revision >= state.revision) {
      return replaceState({
        ...state,
        revision: Math.max(state.revision, response.revision ?? state.revision),
        error: response.error,
      });
    }
    return false;
  }
  errorScope = "connection";
  return replaceState({
    ...state,
    error: "The browser bridge returned an invalid response",
  });
};

const refreshState = async (): Promise<void> => {
  if (pending || refreshing) {
    return;
  }
  refreshing = true;
  try {
    if (mergeState(await call({ type: "popup.getState" }))) {
      render();
    }
  } catch (cause) {
    errorScope = "connection";
    if (
      replaceState({
        ...state,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    ) {
      render();
    }
  } finally {
    refreshing = false;
  }
};

const apply = async (message: unknown): Promise<void> => {
  if (pending) {
    return;
  }
  const type = messageType(message);
  errorScope = scopeFor(type);
  dismissedErrorOccurrence = -1;
  pending = true;
  render();
  try {
    const response = await call(message);
    const success = isState(response) && response.revision >= state.revision;
    if (success && type === "popup.pair") {
      endpointDirty = false;
      endpointInitialized = false;
      tokenDraft = "";
      tokenEditRevision += 1;
      invalidatePairingIntent();
      tokenVisible = false;
      editingConnection = false;
      connectionOpen = false;
      dom.tokenInput.value = "";
    }
    if (success && type === "popup.select") {
      choosingConversation = false;
    }
    mergeState(response);
  } catch (cause) {
    errorScope = "connection";
    replaceState({
      ...state,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    pending = false;
    render();
  }
};

dom.endpointInput.addEventListener("input", () => {
  endpointDraft = dom.endpointInput.value;
  endpointDirty = true;
  invalidatePairingIntent();
  render();
});
dom.tokenInput.addEventListener("input", () => {
  tokenDraft = dom.tokenInput.value;
  tokenEditRevision += 1;
  invalidatePairingIntent();
  tokenError = "";
  render();
});
dom.tokenPaste.addEventListener("click", () => {
  if (pasting) {
    return;
  }
  pasting = true;
  const editRevision = tokenEditRevision;
  render();
  void (async () => {
    try {
      const pasted = (await withTimeout(navigator.clipboard.readText(), 3_000)).trim();
      if (editRevision !== tokenEditRevision) {
        return;
      }
      if (pasted === "") {
        tokenError = "The clipboard is empty. Copy the token in VS Code.";
      } else {
        tokenDraft = pasted;
        tokenEditRevision += 1;
        dom.tokenInput.value = pasted;
        tokenError = "";
      }
    } catch {
      if (editRevision === tokenEditRevision) {
        tokenError = "Clipboard unavailable. Paste into the token field with ⌘V or Ctrl+V.";
      }
    } finally {
      pasting = false;
      render();
      dom.tokenInput.focus();
    }
  })();
});
/**
 * Paste & Pair.
 *
 * One control for the whole first run: read the token the reader copied in VS Code, check it has
 * the shape a pairing token has, and hand it straight to the pairing the Pair button already runs.
 * The endpoint is never taken from the clipboard — it is the canonical one, or whatever the reader
 * typed into the field — so a clipboard written by a hostile process cannot point the Bridge at a
 * port it controls. It can, at worst, spend a token that is already short-lived and single-use.
 */
dom.tokenPastePair.addEventListener("click", () => {
  if (pending || pasting) {
    return;
  }
  const endpoint = endpointDraft.trim();
  if (endpoint === "" || endpointProblem(endpoint) !== "") {
    tokenError = "Check the endpoint before pairing.";
    render();
    return;
  }
  pasting = true;
  const editRevision = tokenEditRevision;
  const intentRevision = pairingIntentRevision;
  render();
  void (async () => {
    let token = "";
    try {
      token = (await withTimeout(navigator.clipboard.readText(), 3_000)).trim();
    } catch {
      if (editRevision === tokenEditRevision && intentRevision === pairingIntentRevision) {
        tokenError = "Clipboard unavailable. Paste into the token field with ⌘V or Ctrl+V, then Connect.";
      }
      pasting = false;
      render();
      return;
    }
    // BB-R26-03. Refuse the deferred pairing if the endpoint, token or connection intent moved
    // while the clipboard was being read.
    if (editRevision !== tokenEditRevision || intentRevision !== pairingIntentRevision) {
      pasting = false;
      render();
      return;
    }
    if (endpointDraft.trim() !== endpoint || endpointProblem(endpoint) !== "") {
      pasting = false;
      render();
      return;
    }
    if (!pairingTokenPattern.test(token)) {
      tokenError = token === ""
        ? "The clipboard is empty. Copy the token in VS Code."
        : "That is not a pairing token. Copy the token in VS Code.";
      pasting = false;
      render();
      dom.tokenInput.focus();
      return;
    }
    tokenDraft = token;
    tokenEditRevision += 1;
    dom.tokenInput.value = token;
    tokenError = "";
    pasting = false;
    render();
    await apply({ type: "popup.pair", endpoint, token });
  })();
});
dom.tokenReveal.addEventListener("click", () => {
  tokenVisible = !tokenVisible;
  render();
  dom.tokenInput.focus();
});
dom.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pending || !endpointDraft.trim() || !tokenDraft.trim() || endpointProblem(endpointDraft) !== "") {
    return;
  }
  invalidatePairingIntent();
  void apply({ type: "popup.pair", endpoint: endpointDraft, token: tokenDraft });
});
dom.editConnection.addEventListener("click", () => {
  editingConnection = true;
  dom.advanced.open = true;
  render();
  dom.endpointInput.focus();
});
dom.cancelEdit.addEventListener("click", () => {
  editingConnection = false;
  endpointDirty = false;
  endpointDraft = state.endpoint ?? "";
  tokenDraft = "";
  tokenEditRevision += 1;
  invalidatePairingIntent();
  tokenVisible = false;
  dom.endpointInput.value = endpointDraft;
  dom.tokenInput.value = "";
  render();
});
dom.disconnect.addEventListener("click", () => {
  invalidatePairingIntent();
  void apply({ type: "popup.disconnect" });
});
dom.cancelConnect.addEventListener("click", () => {
  invalidatePairingIntent();
  void apply({ type: "popup.disconnect" });
});
dom.reconnect.addEventListener("click", () => {
  invalidatePairingIntent();
  void apply({ type: "popup.reconnect" });
});
dom.refresh.addEventListener("click", () => {
  void apply({ type: "popup.discover" });
});
dom.connectionPill.addEventListener("click", () => {
  connectionOpen = !connectionOpen;
  render();
});
dom.changeConversation.addEventListener("click", () => {
  choosingConversation = true;
  render();
});
dom.doneChoosing.addEventListener("click", () => {
  choosingConversation = false;
  render();
});
dom.connectionDismiss.addEventListener("click", () => {
  dismissedErrorOccurrence = errorOccurrence;
  render();
});
dom.bindingDismiss.addEventListener("click", () => {
  dismissedErrorOccurrence = errorOccurrence;
  render();
});

render();
void refreshState();
setInterval(() => {
  void refreshState();
}, 1_000);
