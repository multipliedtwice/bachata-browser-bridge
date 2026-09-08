import { popupCapabilityDescription } from "../../background/popupProjection.js";
import type { BrowserSessionCapabilities } from "../../protocol/types.js";
import { loadBindingDraft, loadUnvalidatedBindingProfile } from "./bindingProfile.js";
import { resolveLocatorRecipe } from "./locator.js";
import { pickBindingElement } from "./picker.js";
import type { GenericBindingRole } from "./types.js";

const roles: readonly [GenericBindingRole, string, boolean][] = [
  ["composer", "Composer", true],
  ["conversationRoot", "Conversation region", true],
  ["responseMessage", "Assistant response", false],
  ["sendButton", "Send", false],
  ["stopButton", "Stop", false],
  ["newConversationButton", "New conversation", false],
];

export const showGenericSetup = (options: {
  revision: () => number;
  assertIdle: () => void;
  validate: () => Promise<boolean>;
  autoDetect: () => Promise<boolean>;
  capabilities: () => Promise<BrowserSessionCapabilities>;
}): (() => void) => {
  const previousFocus = document.activeElement;
  const host = document.createElement("aside");
  const shadow = host.attachShadow({ mode: "closed" });
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Generic website setup");
  panel.setAttribute("role", "region");
  const style = document.createElement("style");
  style.textContent = ":host{position:fixed!important;inset:16px 16px auto auto!important;z-index:2147483647!important;max-width:min(380px,calc(100vw - 32px))!important;color:#eee!important;font:14px/1.5 system-ui!important}section{background:#202124;border:1px solid #888;border-radius:10px;padding:16px;max-height:80vh;overflow:auto;box-shadow:0 4px 24px #0008}h2{font-size:18px;margin:0 0 8px}p{margin:8px 0}button{font:inherit;color:inherit;background:#36383b;border:1px solid #999;border-radius:4px;padding:6px 10px;margin:4px 4px 4px 0;cursor:pointer}button:focus-visible{outline:3px solid #8ab4f8;outline-offset:2px}button:disabled{opacity:.5;cursor:default}ul{list-style:none;padding:0}li{border-top:1px solid #555;padding:6px 0}small{display:block}details{margin-top:8px}[hidden]{display:none!important}";
  const title = document.createElement("h2");
  title.textContent = "Set up this website";
  const hint = document.createElement("p");
  hint.textContent = "Configurable support with limitations. Bind the composer and conversation region, then validate. The website controls model selection.";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = document.createElement("ul");
  const actions = document.createElement("div");
  const buttons = new Set<HTMLButtonElement>();
  const lifetime = new AbortController();
  let closed = false;
  let busy = false;
  const close = (): void => {
    closed = true;
    lifetime.abort();
    host.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const button = (label: string, action: () => Promise<void> | void): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", () => {
      if (busy || closed) return;
      busy = true;
      buttons.forEach((control) => { control.disabled = true; });
      void Promise.resolve().then(() => {
        options.assertIdle();
        return action();
      }).catch((error: unknown) => {
        status.textContent = error instanceof Error ? error.message : "Setup failed. Try the control again.";
      }).finally(() => {
        busy = false;
        buttons.forEach((control) => { control.disabled = false; });
        if (!closed) [...buttons].find((control) => control.textContent === label)?.focus();
      });
    });
    buttons.add(element);
    return element;
  };
  const renderChecklist = async (): Promise<void> => {
    const profile = await loadUnvalidatedBindingProfile();
    const draft = await loadBindingDraft();
    if (closed) return;
    list.querySelectorAll("button").forEach((control) => { buttons.delete(control); });
    list.replaceChildren();
    for (const [role, label, required] of roles) {
      const recipe = draft?.documentRevision === options.revision() ? draft[role] ?? profile?.[role] : profile?.[role];
      const found = recipe ? resolveLocatorRecipe(recipe) : undefined;
      const row = document.createElement("li");
      const state = document.createElement("small");
      state.textContent = `${required ? "Required" : "Optional"} · ${found ? "Located on this page" : recipe ? "Saved control not found" : "Not bound"}`;
      row.append(button(`Choose ${label}`, async () => {
        host.hidden = true;
        let picked = false;
        try {
          picked = await pickBindingElement(role, options.revision(), lifetime.signal);
        } finally {
          host.hidden = false;
        }
        if (closed) return;
        status.textContent = picked ? `${label} saved. Validate after choosing controls.` : "Selection cancelled or expired.";
        await renderChecklist();
      }), state);
      list.append(row);
    }
  };
  const detect = button("Auto-detect controls", async () => {
    status.textContent = "Detecting controls using the configured local model…";
    const detected = await options.autoDetect();
    status.textContent = detected ? "Controls found. Review the checklist, then validate." : "No unambiguous binding found. Choose the required controls below.";
    await renderChecklist();
  });
  const validate = button("Validate binding", async () => {
    const valid = await options.validate();
    status.textContent = valid
      ? "Binding validated. Open Browser Bridge and bind this conversation. Missing optional controls keep their manual limitations; validation alone does not prove automatic completion or Stop."
      : "Binding is not valid on this page. Repair the required controls, then validate again.";
    await renderChecklist();
    if (valid && !closed) {
      const description = popupCapabilityDescription(await options.capabilities());
      if (!closed) status.textContent += ` ${description.summary} ${description.details}`;
    }
  });
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = "Close setup";
  done.addEventListener("click", close);
  actions.append(detect, validate, done);
  const advanced = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Advanced repair";
  const repair = document.createElement("p");
  repair.textContent = "The Bachata context-menu binding commands remain available. Choose one exact element; Escape cancels selection. No prompt is sent during setup.";
  advanced.append(summary, repair);
  panel.append(title, hint, status, actions, list, advanced);
  shadow.append(style, panel);
  document.documentElement.append(host);
  detect.focus();
  void renderChecklist().catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : "Could not read saved bindings.";
  });
  return close;
};
