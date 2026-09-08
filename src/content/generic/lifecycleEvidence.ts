import type { GenericBindingProfile } from "./types.js";

const evidenceMaximumAgeMs = 7 * 24 * 60 * 60 * 1_000;

const lifecycleEvidenceKeys = [
  "stopControlObservedAt",
  "stopControlFingerprint",
  "stopControlRoutePattern",
  "lifecycleCompletedAt",
  "lifecycleCompletedFingerprint",
  "lifecycleCompletedRoutePattern",
  "interruptionConfirmedAt",
  "interruptionConfirmedFingerprint",
  "interruptionConfirmedRoutePattern",
] as const satisfies readonly (keyof GenericBindingProfile)[];

const evidenceRoute = (profile: GenericBindingProfile): string => profile.routePattern ?? "";

const recentTimestamp = (value: string | undefined, now: number): boolean => {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= evidenceMaximumAgeMs;
};

export const stopControlFingerprint = (profile: GenericBindingProfile): string | undefined =>
  profile.stopButton ? JSON.stringify(profile.stopButton) : undefined;

export const replaceGenericBindingProfileState = (
  target: GenericBindingProfile,
  source: GenericBindingProfile,
): GenericBindingProfile => {
  for (const key of lifecycleEvidenceKeys) Reflect.deleteProperty(target, key);
  Object.assign(target, source);
  return target;
};

export const withoutGenericLifecycleEvidence = (profile: GenericBindingProfile): GenericBindingProfile => {
  const next = { ...profile };
  delete next.stopControlObservedAt;
  delete next.stopControlFingerprint;
  delete next.stopControlRoutePattern;
  delete next.lifecycleCompletedAt;
  delete next.lifecycleCompletedFingerprint;
  delete next.lifecycleCompletedRoutePattern;
  delete next.interruptionConfirmedAt;
  delete next.interruptionConfirmedFingerprint;
  delete next.interruptionConfirmedRoutePattern;
  return next;
};

export const profileHasObservedStopControl = (
  profile: GenericBindingProfile | undefined,
  now = Date.now(),
): boolean => {
  if (!profile) return false;
  const fingerprint = stopControlFingerprint(profile);
  const route = evidenceRoute(profile);
  return Boolean(
    fingerprint
    && recentTimestamp(profile.stopControlObservedAt, now)
    && profile.stopControlFingerprint === fingerprint
    && profile.stopControlRoutePattern === route,
  );
};

export const profileHasVerifiedLifecycle = (
  profile: GenericBindingProfile | undefined,
  now = Date.now(),
): boolean => {
  if (!profile || !profileHasObservedStopControl(profile, now)) return false;
  const fingerprint = stopControlFingerprint(profile);
  const route = evidenceRoute(profile);
  return Boolean(
    recentTimestamp(profile.lifecycleCompletedAt, now)
    && profile.lifecycleCompletedFingerprint === fingerprint
    && profile.lifecycleCompletedRoutePattern === route,
  );
};

export const profileHasConfirmedInterruption = (
  profile: GenericBindingProfile | undefined,
  now = Date.now(),
): boolean => {
  if (!profile || !profileHasVerifiedLifecycle(profile, now)) return false;
  const fingerprint = stopControlFingerprint(profile);
  const route = evidenceRoute(profile);
  return Boolean(
    recentTimestamp(profile.interruptionConfirmedAt, now)
    && profile.interruptionConfirmedFingerprint === fingerprint
    && profile.interruptionConfirmedRoutePattern === route,
  );
};

export const withObservedStopControlEvidence = (
  profile: GenericBindingProfile,
  observedAt = new Date().toISOString(),
): GenericBindingProfile => {
  const fingerprint = stopControlFingerprint(profile);
  if (!fingerprint) return withoutGenericLifecycleEvidence(profile);
  const route = evidenceRoute(profile);
  const evidenceMatches = profile.stopControlFingerprint === fingerprint
    && profile.stopControlRoutePattern === route;
  const next = evidenceMatches ? { ...profile } : withoutGenericLifecycleEvidence(profile);
  next.stopControlObservedAt = observedAt;
  next.stopControlFingerprint = fingerprint;
  next.stopControlRoutePattern = route;
  return next;
};

export const withCompletedLifecycleEvidence = (
  profile: GenericBindingProfile,
  completedAt = new Date().toISOString(),
): GenericBindingProfile => {
  const next = withObservedStopControlEvidence(profile, completedAt);
  const fingerprint = stopControlFingerprint(next);
  if (!fingerprint) return next;
  next.lifecycleCompletedAt = completedAt;
  next.lifecycleCompletedFingerprint = fingerprint;
  next.lifecycleCompletedRoutePattern = evidenceRoute(next);
  return next;
};

export const withConfirmedInterruptionEvidence = (
  profile: GenericBindingProfile,
  confirmedAt = new Date().toISOString(),
): GenericBindingProfile => {
  const next = withCompletedLifecycleEvidence(profile, confirmedAt);
  const fingerprint = stopControlFingerprint(next);
  if (!fingerprint) return next;
  next.interruptionConfirmedAt = confirmedAt;
  next.interruptionConfirmedFingerprint = fingerprint;
  next.interruptionConfirmedRoutePattern = evidenceRoute(next);
  return next;
};
