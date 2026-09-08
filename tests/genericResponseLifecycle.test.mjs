import assert from "node:assert/strict";
import test from "node:test";

import {
  genericLifecycleAcquisitionExpired,
  genericResponseCompletionConfirmed,
} from "../dist/content/generic/responseLifecycle.js";

test("generic lifecycle acquisition fails only after response text is visible without generation evidence", () => {
  assert.equal(genericLifecycleAcquisitionExpired({ now: 20_000, sawGeneration: false }), false);
  assert.equal(genericLifecycleAcquisitionExpired({ responseObservedAt: 1_000, now: 15_999, sawGeneration: false }), false);
  assert.equal(genericLifecycleAcquisitionExpired({ responseObservedAt: 1_000, now: 16_000, sawGeneration: false }), true);
  assert.equal(genericLifecycleAcquisitionExpired({ responseObservedAt: 1_000, now: 30_000, sawGeneration: true }), false);
});

test("generic completion requires observed generation, generation end, and stable response", () => {
  const base = {
    generationObserverAvailable: true,
    sawGeneration: true,
    generating: false,
    generationEndedAt: 1_000,
    stableSince: 1_000,
    now: 3_500,
  };
  assert.equal(genericResponseCompletionConfirmed(base), true);
  assert.equal(genericResponseCompletionConfirmed({ ...base, generationObserverAvailable: false }), false);
  assert.equal(genericResponseCompletionConfirmed({ ...base, sawGeneration: false }), false);
  assert.equal(genericResponseCompletionConfirmed({ ...base, generating: true }), false);
  assert.equal(genericResponseCompletionConfirmed({ ...base, now: 3_499 }), false);
});
