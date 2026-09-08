import { isBuiltInProviderLocation, validHttpOrigin } from "../background/genericOrigin.js";
import { create } from "./dom.js";

type SavedBinding = { origin: string; id?: string; validated: boolean; permitted: boolean };

const isSavedBinding = (value: unknown): value is SavedBinding =>
  Boolean(value && typeof value === "object" && !Array.isArray(value)
    && "origin" in value && typeof value.origin === "string" && validHttpOrigin(value.origin)
    && (!("id" in value) || typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id))
    && "validated" in value && typeof value.validated === "boolean"
    && "permitted" in value && typeof value.permitted === "boolean");

const request = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const response: unknown = await chrome.runtime.sendMessage({ type: "BACHATA_GENERIC_MANAGE", ...input });
  if (!response || typeof response !== "object" || Array.isArray(response) || !("ok" in response) || response.ok !== true) {
    throw new Error(response && typeof response === "object" && "error" in response && typeof response.error === "string"
      ? response.error : "Browser Bridge returned an invalid management response");
  }
  return response;
};

export const installGenericManagement = (parent: HTMLElement): void => {
  const section = create("details", { id: "generic-management" });
  const heading = create("summary", { text: "Other websites and saved bindings" });
  const note = create("p", { className: "hint", text: "Generic support is configurable and has limitations. Each site needs your permission. One VS Code host owns the connection; model selection stays on the website." });
  const status = create("p", { id: "generic-status", className: "hint" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const setup = create("button", { id: "generic-setup", className: "small", text: "Set up current website" });
  const saved = create("button", { id: "generic-saved", className: "ghost small", text: "Saved bindings" });
  const permission = create("button", { id: "generic-allow", className: "primary small" });
  permission.hidden = true;
  const list = create("ul", { id: "generic-bindings", className: "tab-list" });
  const confirmation = create("div", { id: "generic-confirmation" });
  confirmation.hidden = true;
  const confirmationText = create("p");
  const confirm = create("button", { id: "generic-confirm", className: "danger small", text: "Confirm" });
  const cancel = create("button", { id: "generic-cancel", className: "ghost small", text: "Cancel" });
  confirmation.append(confirmationText, confirm, cancel);
  for (const control of [setup, saved, permission, confirm, cancel]) control.type = "button";
  section.append(heading, note, setup, saved, permission, status, confirmation, list);
  parent.append(section);
  let pending = false;
  let selected: { tabId: number; origin: string } | undefined;
  let confirmedAction: (() => Promise<void>) | undefined;
  let confirmationInvoker: HTMLButtonElement | undefined;
  let nextFocus: HTMLElement | undefined;

  const run = (action: () => Promise<void>): void => {
    if (pending) return;
    pending = true;
    section.querySelectorAll("button").forEach((control) => { control.disabled = true; });
    void action().catch((cause: unknown) => {
      status.textContent = cause instanceof Error ? cause.message : "The operation failed.";
    }).finally(() => {
      pending = false;
      section.querySelectorAll("button").forEach((control) => { control.disabled = false; });
      nextFocus?.focus();
      nextFocus = undefined;
    });
  };

  const selectCurrent = async (requiredOrigin?: string): Promise<void> => {
    selected = undefined;
    permission.hidden = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error("Select an HTTP(S) website tab first.");
    const origin = new URL(tab.url).origin;
    if (!validHttpOrigin(origin) || isBuiltInProviderLocation(origin)) {
      throw new Error("Use the built-in ChatGPT or Claude binding for those sites. Generic setup needs another HTTP(S) website.");
    }
    if (requiredOrigin && requiredOrigin !== origin) throw new Error(`Open a tab on ${requiredOrigin}, then choose Set up current website.`);
    selected = { tabId: tab.id, origin };
    permission.textContent = `Allow and set up ${origin}`;
    permission.hidden = false;
    status.textContent = "Setup opens on the selected page. It sends no prompt.";
    nextFocus = permission;
  };

  const ask = (text: string, invoker: HTMLButtonElement, action: () => Promise<void>): void => {
    if (pending) return;
    confirmedAction = action;
    confirmationInvoker = invoker;
    confirmationText.textContent = text;
    confirmation.hidden = false;
    cancel.focus();
  };

  const showSaved = async (): Promise<void> => {
    const response = await request({ action: "list" });
    if (!Array.isArray(response.entries) || response.entries.length > 3200 || !response.entries.every(isSavedBinding)) {
      throw new Error("The saved-binding list is invalid. No bindings were changed.");
    }
    list.replaceChildren();
    confirmedAction = undefined;
    confirmation.hidden = true;
    status.textContent = [response.entries.length === 0 ? "No saved Generic bindings or optional site access." : "Saved validation describes the last check. Revalidate on the current page before use.",
      ...(response.truncated === true ? ["Showing the first 200 sites."] : []),
      ...(response.broaderPermissions === true ? ["Chrome also holds broader host permissions. Review those in Chrome's extension site-access settings."] : []),
    ].join(" ");
    for (const entry of response.entries) {
      const row = create("li", { className: "tab-row" });
      const bindingId = entry.id;
      const description = create("p", { text: `${entry.origin} · ${bindingId ? `Binding ${bindingId.slice(0, 8)} · ${entry.validated ? "Previously validated" : "Needs validation"}` : "No saved binding"} · ${entry.permitted ? "Access allowed" : "Access not allowed"}` });
      const repair = create("button", { className: "small", text: "Repair or revalidate" });
      const remove = create("button", { className: "ghost small", text: "Remove binding" });
      const revoke = create("button", { className: "danger small", text: "Revoke site access" });
      for (const control of [repair, remove, revoke]) control.type = "button";
      revoke.hidden = !entry.permitted;
      remove.hidden = bindingId === undefined;
      repair.addEventListener("click", () => { run(() => selectCurrent(entry.origin)); });
      remove.addEventListener("click", () => {
        if (!bindingId) return;
        ask(`Remove binding ${bindingId.slice(0, 8)} for ${entry.origin}? Site permission stays.`, remove, async () => {
          await request({ action: "remove", origin: entry.origin, id: bindingId });
          await showSaved();
          nextFocus = saved;
        });
      });
      revoke.addEventListener("click", () => {
        ask(`Revoke Browser Bridge access to ${entry.origin}? Its active binding becomes unavailable. Saved profiles stay for later setup.`, revoke, async () => {
          await request({ action: "revoke", origin: entry.origin, confirmed: true });
          await showSaved();
          nextFocus = saved;
        });
      });
      row.append(description, repair, remove, revoke);
      list.append(row);
    }
  };
  setup.addEventListener("click", () => { run(() => selectCurrent()); });
  saved.addEventListener("click", () => { run(showSaved); });
  permission.addEventListener("click", () => {
    if (pending || !selected) return;
    const target = selected;
    run(async () => {
      if (!(await chrome.permissions.request({ origins: [`${target.origin}/*`] }))) {
        throw new Error("Website access was not granted. No setup started.");
      }
      await request({ action: "setup", ...target });
      permission.hidden = true;
      status.textContent = "Setup is open on the selected website. Close this popup to choose page elements.";
      nextFocus = setup;
    });
  });
  confirm.addEventListener("click", () => {
    const action = confirmedAction;
    if (!action || pending) return;
    confirmedAction = undefined;
    confirmation.hidden = true;
    run(action);
  });
  cancel.addEventListener("click", () => {
    if (pending) return;
    confirmedAction = undefined;
    confirmation.hidden = true;
    confirmationInvoker?.focus();
  });
};
