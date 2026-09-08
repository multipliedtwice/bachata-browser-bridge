import assert from "node:assert/strict";
import test from "node:test";

import {
  profileHasConfirmedInterruption,
  profileHasObservedStopControl,
  profileHasVerifiedLifecycle,
  replaceGenericBindingProfileState,
  withCompletedLifecycleEvidence,
  withConfirmedInterruptionEvidence,
  withObservedStopControlEvidence,
} from "../dist/content/generic/lifecycleEvidence.js";

const profile = () => ({
  protocol: "bachata-generic-binding-v1",
  origin: "https://example.test",
  routePattern: "/chat/*",
  framePath: [],
  composer: { stableAttributes: {}, structuralPath: [0] },
  conversationRoot: { stableAttributes: {}, structuralPath: [1] },
  stopButton: { role: "button", accessibleName: "Stop", stableAttributes: {}, structuralPath: [2] },
  createdBy: "autoHeal",
  validated: true,
  consecutiveFailures: 0,
  documentRevision: 1,
});

const observedAt = "2026-08-17T00:00:00.000Z";
const completedAt = "2026-08-17T00:00:05.000Z";
const interruptedAt = "2026-08-17T00:00:10.000Z";
const now = Date.parse("2026-08-17T00:01:00.000Z");

test("observed Stop evidence alone does not claim completion or interruption", () => {
  const observed = withObservedStopControlEvidence(profile(), observedAt);
  assert.equal(profileHasObservedStopControl(observed, now), true);
  assert.equal(profileHasVerifiedLifecycle(observed, now), false);
  assert.equal(profileHasConfirmedInterruption(observed, now), false);
});

test("natural completion and confirmed interruption remain separate capabilities", () => {
  const completed = withCompletedLifecycleEvidence(profile(), completedAt);
  assert.equal(profileHasVerifiedLifecycle(completed, now), true);
  assert.equal(profileHasConfirmedInterruption(completed, now), false);

  const interrupted = withConfirmedInterruptionEvidence(completed, interruptedAt);
  assert.equal(profileHasVerifiedLifecycle(interrupted, now), true);
  assert.equal(profileHasConfirmedInterruption(interrupted, now), true);
});

test("route or Stop locator changes invalidate prior lifecycle evidence", () => {
  const completed = withCompletedLifecycleEvidence(profile(), completedAt);
  assert.equal(profileHasVerifiedLifecycle({ ...completed, routePattern: "/other/*" }, now), false);
  assert.equal(profileHasVerifiedLifecycle({
    ...completed,
    stopButton: { ...completed.stopButton, accessibleName: "Cancel generation" },
  }, now), false);
});

test("lifecycle evidence expires instead of becoming permanent capability", () => {
  const interrupted = withConfirmedInterruptionEvidence(profile(), interruptedAt);
  const expiredNow = Date.parse(interruptedAt) + (7 * 24 * 60 * 60 * 1_000) + 1;
  assert.equal(profileHasObservedStopControl(interrupted, expiredNow), false);
  assert.equal(profileHasVerifiedLifecycle(interrupted, expiredNow), false);
  assert.equal(profileHasConfirmedInterruption(interrupted, expiredNow), false);
});

test("observing the same Stop locator renews expired evidence", () => {
  const first = withCompletedLifecycleEvidence(profile(), observedAt);
  const expiredNow = Date.parse(observedAt) + (7 * 24 * 60 * 60 * 1_000) + 1;
  assert.equal(profileHasObservedStopControl(first, expiredNow), false);

  const renewedAt = new Date(expiredNow).toISOString();
  const renewed = withObservedStopControlEvidence(first, renewedAt);
  assert.equal(profileHasObservedStopControl(renewed, expiredNow), true);
  assert.equal(renewed.stopControlObservedAt, renewedAt);
  assert.equal(profileHasVerifiedLifecycle(renewed, expiredNow), false);
});


test("replacing profile state removes lifecycle fields omitted by the source", () => {
  const target = withConfirmedInterruptionEvidence(profile(), interruptedAt);
  const source = { ...profile(), routePattern: "/other/*", documentRevision: 2 };
  const replaced = replaceGenericBindingProfileState(target, source);

  assert.equal(replaced, target);
  assert.equal(replaced.routePattern, "/other/*");
  assert.equal(replaced.documentRevision, 2);
  assert.equal(replaced.stopControlObservedAt, undefined);
  assert.equal(replaced.lifecycleCompletedAt, undefined);
  assert.equal(replaced.interruptionConfirmedAt, undefined);
});

test("a binding with no Stop control can hold no lifecycle evidence at all", () => {
  const unbound = { ...profile() };
  delete unbound.stopButton;
  const observed = withObservedStopControlEvidence({
    ...unbound,
    stopControlObservedAt: observedAt,
    stopControlFingerprint: "stale",
    stopControlRoutePattern: "/chat/*",
  }, observedAt);
  assert.equal(observed.stopControlObservedAt, undefined, "evidence survived a binding with no Stop control");
  assert.equal(profileHasObservedStopControl(observed, now), false);
  assert.equal(withCompletedLifecycleEvidence(observed, completedAt).lifecycleCompletedAt, undefined);
  assert.equal(withConfirmedInterruptionEvidence(observed, interruptedAt).interruptionConfirmedAt, undefined);
});

test("no binding at all claims no capability", () => {
  assert.equal(profileHasObservedStopControl(undefined, now), false);
  assert.equal(profileHasVerifiedLifecycle(undefined, now), false);
  assert.equal(profileHasConfirmedInterruption(undefined, now), false);
});

test("evidence that is unparsable or dated in the future is not evidence", () => {
  const observed = withObservedStopControlEvidence(profile(), observedAt);
  assert.equal(
    profileHasObservedStopControl({ ...observed, stopControlObservedAt: "not-a-date" }, now),
    false,
    "an unparsable timestamp was accepted as recent evidence",
  );
  assert.equal(
    profileHasObservedStopControl(observed, Date.parse("2026-08-16T00:00:00.000Z")),
    false,
    "evidence recorded after the current moment was accepted",
  );
});

test("completion evidence is refused when the Stop control it was recorded for changed", () => {
  const completed = withCompletedLifecycleEvidence(profile(), completedAt);
  assert.equal(profileHasVerifiedLifecycle(completed, now), true);
  const rebound = {
    ...completed,
    stopButton: { role: "button", accessibleName: "Cancel", stableAttributes: {}, structuralPath: [3] },
  };
  assert.equal(
    profileHasVerifiedLifecycle(rebound, now),
    false,
    "completion recorded for the old Stop control was reused for a new one",
  );
  assert.equal(profileHasConfirmedInterruption(rebound, now), false);
});

test("interruption evidence requires the completion evidence it builds on", () => {
  const confirmed = withConfirmedInterruptionEvidence(profile(), interruptedAt);
  assert.equal(profileHasConfirmedInterruption(confirmed, now), true);
  const withoutCompletion = { ...confirmed };
  delete withoutCompletion.lifecycleCompletedAt;
  assert.equal(
    profileHasConfirmedInterruption(withoutCompletion, now),
    false,
    "interruption was claimed without an observed completion lifecycle",
  );
});
