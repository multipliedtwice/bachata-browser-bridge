import { computeAccessibleName } from "dom-accessibility-api";
import { finder } from "@medv/finder";
import type { LocatorRecipe } from "./types.js";

const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "aria-label", "name", "placeholder", "role"];

const elementChildren = (element: Element): Element[] => Array.from(element.children);

const structuralPath = (element: Element): number[] => {
  const values: number[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (!parent) {
      break;
    }
    values.unshift(elementChildren(parent).indexOf(current));
    current = parent;
  }
  return values;
};

const stableAttributes = (element: Element): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const name of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(name)?.trim();
    if (value && value.length <= 256) {
      result[name] = value;
    }
  }
  return result;
};

export const createLocatorRecipe = (element: Element): LocatorRecipe => {
  let cssFallback: string | undefined;
  try {
    cssFallback = finder(element, {
      root: document.body,
      attr: (name) => STABLE_ATTRIBUTES.includes(name),
      className: () => false,
      idName: (name) => !/^\d+$/.test(name),
      seedMinLength: 1,
      optimizedMinLength: 2,
      maxNumberOfPathChecks: 800,
    });
  } catch {
    cssFallback = undefined;
  }
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") ?? undefined,
    accessibleName: computeAccessibleName(element).trim() || undefined,
    placeholder: element.getAttribute("placeholder") ?? undefined,
    stableAttributes: stableAttributes(element),
    cssFallback,
    structuralPath: structuralPath(element),
  };
};

const resolveStructural = (recipe: LocatorRecipe): Element | undefined => {
  let current: Element = document.documentElement;
  for (const index of recipe.structuralPath) {
    const next: Element | undefined = elementChildren(current)[index];
    if (!next) {
      return undefined;
    }
    current = next;
  }
  return current;
};

const semanticCandidates = (recipe: LocatorRecipe): Element[] => {
  const selectors: string[] = [];
  for (const [name, value] of Object.entries(recipe.stableAttributes)) {
    selectors.push(`[${CSS.escape(name)}="${CSS.escape(value)}"]`);
  }
  if (recipe.role) {
    selectors.push(`[role="${CSS.escape(recipe.role)}"]`);
  }
  if (recipe.placeholder) {
    selectors.push(`[placeholder="${CSS.escape(recipe.placeholder)}"]`);
  }
  const result = new Set<Element>();
  for (const selector of selectors) {
    try {
      for (const element of document.querySelectorAll(selector)) {
        result.add(element);
      }
    } catch {
      continue;
    }
  }
  return [...result].filter((element) =>
    !recipe.accessibleName || computeAccessibleName(element).trim() === recipe.accessibleName);
};


export const locatorRecipeMatchesElement = (
  recipe: LocatorRecipe,
  element: Element,
): boolean => {
  if (recipe.tag && element.tagName.toLowerCase() !== recipe.tag.toLowerCase()) return false;
  if (recipe.role && element.getAttribute("role") !== recipe.role) return false;
  if (recipe.placeholder && element.getAttribute("placeholder") !== recipe.placeholder) return false;
  if (recipe.accessibleName && computeAccessibleName(element).trim() !== recipe.accessibleName) return false;
  for (const [name, value] of Object.entries(recipe.stableAttributes)) {
    if (element.getAttribute(name) !== value) return false;
  }
  return true;
};

export const isVisibleElement = (element: Element): boolean => {
  if (!element.isConnected) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.display !== "none"
    && style.visibility !== "hidden"
    && Number(style.opacity || "1") > 0;
};


export const resolveLocatorRecipeCandidates = (
  recipe: LocatorRecipe,
  root: ParentNode = document,
  relaxedAccessibleName = false,
): Element[] => {
  const selectors: string[] = [];
  for (const [name, value] of Object.entries(recipe.stableAttributes)) {
    selectors.push(`[${CSS.escape(name)}="${CSS.escape(value)}"]`);
  }
  if (recipe.role) {
    selectors.push(`[role="${CSS.escape(recipe.role)}"]`);
  }
  if (recipe.placeholder) {
    selectors.push(`[placeholder="${CSS.escape(recipe.placeholder)}"]`);
  }
  if (selectors.length === 0 && recipe.tag && /^[a-z][a-z0-9-]*$/i.test(recipe.tag)) {
    selectors.push(recipe.tag);
  }
  const result = new Set<Element>();
  for (const selector of selectors) {
    try {
      for (const element of root.querySelectorAll(selector)) {
        result.add(element);
      }
    } catch {
      continue;
    }
  }
  if (recipe.cssFallback) {
    try {
      for (const element of root.querySelectorAll(recipe.cssFallback)) {
        result.add(element);
      }
    } catch {
      // BB-AUD-10. A stored fallback selector the page's engine rejects contributes no
      // candidates; the semantic and structural matches above already stand on their own.
    }
  }
  return [...result].filter((element) =>
    isVisibleElement(element)
    && (relaxedAccessibleName || !recipe.accessibleName || computeAccessibleName(element).trim() === recipe.accessibleName));
};

export const resolveLocatorRecipe = (recipe: LocatorRecipe): Element | undefined => {
  const semantic = semanticCandidates(recipe).filter((element) =>
    isVisibleElement(element) && locatorRecipeMatchesElement(recipe, element));
  if (semantic.length === 1) {
    return semantic[0];
  }
  if (recipe.cssFallback) {
    try {
      const candidates = Array.from(document.querySelectorAll(recipe.cssFallback)).filter((element) =>
        isVisibleElement(element) && locatorRecipeMatchesElement(recipe, element));
      if (candidates.length === 1) {
        return candidates[0];
      }
    } catch {
      // BB-AUD-10. As above: an unusable fallback selector resolves nothing, and the
      // structural match below is tried next.
    }
  }
  const structural = resolveStructural(recipe);
  return structural && isVisibleElement(structural) && locatorRecipeMatchesElement(recipe, structural)
    ? structural
    : undefined;
};

export const isWritableElement = (element: Element): element is HTMLElement =>
  element instanceof HTMLTextAreaElement
  || element instanceof HTMLInputElement
  || (element instanceof HTMLElement && element.isContentEditable);
