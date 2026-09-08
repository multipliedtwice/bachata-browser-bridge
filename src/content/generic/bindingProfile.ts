import { withoutGenericLifecycleEvidence } from "./lifecycleEvidence.js";
import { isGenericBindingProfile, type GenericBindingProfile, type GenericBindingRole, type GenericBindingSource, type LocatorRecipe } from "./types.js";

const DRAFT_PREFIX = "bachata.generic.draft.";

type GenericProfileResponse = {
  ok?: boolean;
  value?: unknown;
  error?: string;
  fingerprints?: unknown;
  fingerprint?: unknown;
};

const storageGet = async <T>(key: string): Promise<T | undefined> => {
  const value = await chrome.storage.local.get(key);
  return value[key] as T | undefined;
};

const storageSet = async (key: string, value: unknown): Promise<void> => {
  await chrome.storage.local.set({ [key]: value });
};

const originKey = (prefix: string): string => `${prefix}${location.origin}`;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const currentRouteValue = (): string => `${location.pathname || "/"}${location.search}${location.hash}`;

export const routePatternMatches = (pattern: string | undefined, route = currentRouteValue()): boolean => {
  if (!pattern?.trim()) return false;
  const expression = `^${pattern.split("*").map(escapeRegex).join(".*")}$`;
  try {
    return new RegExp(expression).test(route);
  } catch {
    return false;
  }
};

const dynamicSegment = (value: string): boolean =>
  /^\d+$/.test(value)
  || /^[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}$/i.test(value)
  || /^[A-Za-z0-9_-]{16,}$/.test(value);

export const currentRoutePattern = (): string => {
  const pathname = location.pathname || "/";
  const suffix = `${location.search}${location.hash}`;
  const slash = pathname.lastIndexOf("/");
  if (slash < 0 || slash === pathname.length - 1) return `${pathname}${suffix}`;
  const segment = pathname.slice(slash + 1);
  if (!dynamicSegment(segment)) return `${pathname}${suffix}`;
  return `${pathname.slice(0, slash + 1)}*${suffix}`;
};

const draftKey = (): string => `${originKey(DRAFT_PREFIX)}:${encodeURIComponent(currentRoutePattern())}`;

const isProfile = (value: unknown): value is GenericBindingProfile =>
  isGenericBindingProfile(value, location.origin);

const profileRequest = async (type: string, payload: Record<string, unknown> = {}): Promise<GenericProfileResponse> => {
  const response = await chrome.runtime.sendMessage({
    type,
    ...payload,
  }) as GenericProfileResponse | undefined;
  if (!response || response.ok !== true) {
    throw new Error(response?.error ?? "Generic browser binding storage request failed");
  }
  return response;
};

type ProfileVersion = { routePattern: string; fingerprint: string; targets: ReadonlyMap<string, string> };
const profileVersions = new WeakMap<GenericBindingProfile, ProfileVersion>();
const isFingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const normalizedRoute = (profile: GenericBindingProfile): string => profile.routePattern?.trim() || "/*";

export const loadBindingProfiles = async (): Promise<GenericBindingProfile[]> => {
  const response = await profileRequest("BACHATA_GENERIC_PROFILE_LIST");
  if (!Array.isArray(response.value)) return [];
  const fingerprints = response.fingerprints;
  if (!Array.isArray(fingerprints) || fingerprints.length !== response.value.length || !fingerprints.every(isFingerprint)) {
    throw new Error("Binding versions are unavailable. Reload the page and try again.");
  }
  const profiles: GenericBindingProfile[] = [];
  const targets = new Map<string, string>();
  response.value.forEach((entry, index) => {
    if (!isProfile(entry)) return;
    const fingerprint = fingerprints[index];
    if (!isFingerprint(fingerprint)) return;
    const routePattern = normalizedRoute(entry);
    targets.set(routePattern, fingerprint);
    profileVersions.set(entry, { routePattern, fingerprint, targets });
    profiles.push(entry);
  });
  return profiles;
};

const profileRank = (profile: GenericBindingProfile): number => {
  const literalLength = (profile.routePattern ?? "").replace(/\*/g, "").length;
  const exactBonus = profile.routePattern?.includes("*") ? 0 : 10_000;
  return exactBonus + literalLength;
};

const bestMatchingProfile = (profiles: GenericBindingProfile[], validatedOnly: boolean): GenericBindingProfile | undefined =>
  profiles
    .filter((profile) => routePatternMatches(profile.routePattern) && (!validatedOnly || profile.validated))
    .sort((left, right) => {
      const rank = profileRank(right) - profileRank(left);
      if (rank !== 0) return rank;
      return (right.lastSuccessfulAt ?? "").localeCompare(left.lastSuccessfulAt ?? "");
    })[0];

export const loadBindingProfile = async (): Promise<GenericBindingProfile | undefined> =>
  bestMatchingProfile(await loadBindingProfiles(), true);

export const loadUnvalidatedBindingProfile = async (): Promise<GenericBindingProfile | undefined> =>
  bestMatchingProfile(await loadBindingProfiles(), false);

export const saveBindingProfile = async (
  profile: GenericBindingProfile,
  baseProfile: GenericBindingProfile = profile,
): Promise<void> => {
  if (profile.origin !== location.origin) {
    throw new Error("Binding origin does not match the current page");
  }
  const version = profileVersions.get(baseProfile);
  const routePattern = profile.routePattern?.trim() || currentRoutePattern();
  const response = await profileRequest("BACHATA_GENERIC_PROFILE_UPSERT", {
    profile: { ...profile, routePattern },
    expectedTargetHash: version?.targets.get(routePattern) ?? null,
    ...(version ? { expectedSource: { routePattern: version.routePattern, fingerprint: version.fingerprint } } : {}),
  });
  if (!isFingerprint(response.fingerprint)) throw new Error("Binding update returned an invalid version");
  const targets = new Map(version?.targets);
  targets.set(routePattern, response.fingerprint);
  profileVersions.set(profile, { routePattern, fingerprint: response.fingerprint, targets });
};

export const clearBindingProfile = async (): Promise<void> => {
  await profileRequest("BACHATA_GENERIC_PROFILE_CLEAR");
};

type BindingDraft = Partial<Record<GenericBindingRole, LocatorRecipe>> & {
  documentRevision: number;
  createdBy: "user" | "autoHeal";
  bindingSources: Partial<Record<GenericBindingRole, GenericBindingSource>>;
  updatedAt?: number;
};

// A draft only becomes a profile once every required role is bound. One the user abandons
// halfway is never completed and so was never removed; each origin and route kept its own.
const draftLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

const draftIsFresh = (draft: BindingDraft | undefined, now: number): draft is BindingDraft =>
  draft !== undefined
  && typeof draft.updatedAt === "number"
  && Number.isFinite(draft.updatedAt)
  && now - draft.updatedAt < draftLifetimeMs;

// Sweeping every stale draft on load keeps the cost bounded without a background timer.
const discardStaleDrafts = async (now: number): Promise<void> => {
  const stored = await chrome.storage.local.get(null);
  const stale = Object.entries(stored)
    .filter(([key]) => key.startsWith(DRAFT_PREFIX))
    .filter(([, value]) => !draftIsFresh(value as BindingDraft | undefined, now))
    .map(([key]) => key);
  if (stale.length > 0) await chrome.storage.local.remove(stale);
};

export const loadBindingDraft = async (): Promise<BindingDraft | undefined> => {
  const now = Date.now();
  await discardStaleDrafts(now).catch(() => undefined);
  const draft = await storageGet<BindingDraft>(draftKey());
  return draftIsFresh(draft, now) ? draft : undefined;
};

export const saveBindingDraftRole = async (
  role: GenericBindingRole,
  locator: LocatorRecipe,
  documentRevision: number,
  createdBy: "user" | "autoHeal" = "user",
): Promise<GenericBindingProfile | undefined> => {
  const origin = location.origin;
  const route = currentRouteValue();
  const routePattern = currentRoutePattern();
  const key = draftKey();
  const assertCurrentPage = (): void => {
    if (location.origin !== origin || currentRouteValue() !== route) {
      throw new Error("The page changed while saving this binding. Choose the control again.");
    }
  };
  const current = await loadBindingDraft();
  assertCurrentPage();
  const existing = await loadUnvalidatedBindingProfile();
  assertCurrentPage();
  const existingDraft: BindingDraft | undefined = existing
    ? {
      composer: existing.composer,
      conversationRoot: existing.conversationRoot,
      ...(existing.sendButton ? { sendButton: existing.sendButton } : {}),
      ...(existing.stopButton ? { stopButton: existing.stopButton } : {}),
      ...(existing.newConversationButton ? { newConversationButton: existing.newConversationButton } : {}),
      ...(existing.responseMessage ? { responseMessage: existing.responseMessage } : {}),
      documentRevision,
      createdBy,
      bindingSources: existing.bindingSources ?? {},
    }
    : undefined;
  const base = current?.documentRevision === documentRevision ? current : existingDraft;
  const draft: BindingDraft = base
    ? { ...base, [role]: locator, documentRevision, createdBy, bindingSources: { ...base.bindingSources, [role]: createdBy } }
    : { [role]: locator, documentRevision, createdBy, bindingSources: { [role]: createdBy } };
  await storageSet(key, { ...draft, updatedAt: Date.now() });
  assertCurrentPage();
  if (!draft.composer || !draft.conversationRoot) {
    return undefined;
  }
  const profile: GenericBindingProfile = {
    protocol: "bachata-generic-binding-v1",
    origin,
    routePattern,
    framePath: [],
    composer: draft.composer,
    conversationRoot: draft.conversationRoot,
    sendButton: draft.sendButton,
    stopButton: draft.stopButton,
    newConversationButton: draft.newConversationButton,
    responseMessage: draft.responseMessage,
    createdBy: draft.createdBy,
    bindingSources: { ...draft.bindingSources },
    validated: false,
    consecutiveFailures: 0,
    documentRevision,
  };
  await saveBindingProfile(profile, existing);
  assertCurrentPage();
  await chrome.storage.local.remove(key);
  return profile;
};

export const markProfileValidation = async (
  profile: GenericBindingProfile,
  success: boolean,
  documentRevision: number,
  forceInvalid = false,
): Promise<GenericBindingProfile> => {
  const consecutiveFailures = success ? 0 : profile.consecutiveFailures + 1;
  const routePattern = success && !routePatternMatches(profile.routePattern)
    ? currentRoutePattern()
    : profile.routePattern;
  const evidenceValid = success && routePattern === profile.routePattern;
  const base = evidenceValid ? { ...profile } : withoutGenericLifecycleEvidence(profile);
  const next: GenericBindingProfile = {
    ...base,
    routePattern,
    validated: success ? true : forceInvalid ? false : profile.validated && consecutiveFailures < 5,
    consecutiveFailures,
    lastSuccessfulAt: success ? new Date().toISOString() : profile.lastSuccessfulAt,
    documentRevision,
  };
  await saveBindingProfile(next, profile);
  return next;
};
