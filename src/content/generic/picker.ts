import { createLocatorRecipe } from "./locator.js";
import { saveBindingDraftRole } from "./bindingProfile.js";
import { collectDomCandidates } from "./candidates.js";
import type { GenericBindingRole } from "./types.js";

const pickerLifetimeMs = 2 * 60_000;
const instructions = "Click an element, or use Up/Down for suggestions, Left for its parent, Right for its first child. Enter chooses; Escape cancels.";

export const pickBindingElement = async (
  role: GenericBindingRole,
  documentRevision: number,
  signal?: AbortSignal,
): Promise<boolean> => await new Promise<boolean>((resolve) => {
  if (signal?.aborted) {
    resolve(false);
    return;
  }
  const previousCursor = document.documentElement.style.cursor;
  const previousFocus = document.activeElement;
  const suggestions = [...collectDomCandidates().values()].map((entry) => entry.element);
  const outline = document.createElement("div");
  outline.setAttribute("data-bachata-picker-outline", "");
  outline.setAttribute("aria-hidden", "true");
  outline.style.cssText = "position:fixed;pointer-events:none;border:3px solid #4285f4;box-sizing:border-box;z-index:2147483647;display:none";
  const hint = document.createElement("div");
  hint.setAttribute("data-bachata-picker-help", "");
  hint.setAttribute("role", "status");
  hint.setAttribute("aria-live", "polite");
  hint.tabIndex = -1;
  hint.textContent = instructions;
  hint.style.cssText = "position:fixed;top:12px;left:12px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:12px;border:1px solid #8ab4f8;border-radius:6px;background:#202124;color:#fff;font:14px/1.5 system-ui;pointer-events:none;z-index:2147483647";
  document.documentElement.appendChild(outline);
  document.documentElement.appendChild(hint);
  let selected: Element | undefined;
  let settled = false;
  const settle = (value: boolean): void => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  const expiry = setTimeout(() => {
    cleanup();
    settle(false);
  }, pickerLifetimeMs);
  const cleanup = (): void => {
    clearTimeout(expiry);
    document.documentElement.style.cursor = previousCursor;
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    signal?.removeEventListener("abort", abort);
    selected?.removeAttribute("data-bachata-binding-target");
    outline.remove();
    hint.remove();
    if (previousFocus instanceof HTMLElement && document.documentElement.contains(previousFocus)) previousFocus.focus();
  };
  const choose = (element: Element | undefined): void => {
    selected?.removeAttribute("data-bachata-binding-target");
    selected = element && document.documentElement.contains(element) && element !== outline && element !== hint ? element : undefined;
    outline.style.display = selected ? "block" : "none";
    if (!selected) { hint.textContent = instructions; return; }
    selected.setAttribute("data-bachata-binding-target", role);
    const rect = selected.getBoundingClientRect();
    outline.style.left = `${String(rect.left)}px`;
    outline.style.top = `${String(rect.top)}px`;
    outline.style.width = `${String(rect.width)}px`;
    outline.style.height = `${String(rect.height)}px`;
    const name = selected.getAttribute("aria-label") || selected.id || selected.tagName.toLowerCase();
    hint.textContent = `Selected ${selected.tagName.toLowerCase()}: ${name}. ${instructions}`;
  };
  const reposition = (): void => { choose(selected); };
  const commit = (element: Element | undefined): void => {
    cleanup();
    if (!element || settled || !document.documentElement.contains(element) || element === outline || element === hint) {
      settle(false);
      return;
    }
    void saveBindingDraftRole(role, createLocatorRecipe(element), documentRevision)
      .then(() => settle(true))
      .catch(() => settle(false));
  };
  const move = (event: MouseEvent): void => {
    choose(event.target instanceof Element ? event.target : undefined);
  };
  const click = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    commit(event.target instanceof Element ? event.target : selected);
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["Escape", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") { cleanup(); settle(false); return; }
    if (event.key === "Enter") { if (selected) commit(selected); return; }
    const available = suggestions.filter((element) => document.documentElement.contains(element));
    let next: Element | undefined;
    if (event.key === "ArrowLeft") next = selected?.parentElement ?? undefined;
    else if (event.key === "ArrowRight") next = selected?.firstElementChild ?? undefined;
    else if (available.length > 0) {
      const index = selected ? available.indexOf(selected) : -1;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      next = available[(index < 0 ? offset > 0 ? 0 : available.length - 1 : index + offset + available.length) % available.length];
    }
    if (next) { next.scrollIntoView({ block: "nearest", inline: "nearest" }); choose(next); }
  };
  const abort = (): void => { cleanup(); settle(false); };
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("mousemove", move, true);
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  signal?.addEventListener("abort", abort, { once: true });
  hint.focus();
});
