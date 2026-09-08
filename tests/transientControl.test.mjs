import assert from "node:assert/strict";
import test from "node:test";

import { delay, now, setWaitScheduler, waitForStableCondition, waitForTransientControl } from "../dist/content/generic/transientControl.js";

test("transient control polling observes a control that appears late in the full timeout window", async () => {
  const started = Date.now();
  const control = { id: "stop" };
  const result = await waitForTransientControl({
    timeoutMs: 220,
    pollIntervalMs: 10,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => Date.now() - started >= 130 ? [control] : [],
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, control);
  assert.ok(Date.now() - started >= 120);
});

test("transient control polling keeps scanning while a healer is pending", async () => {
  const started = Date.now();
  const control = { id: "stop" };
  const result = await waitForTransientControl({
    timeoutMs: 220,
    pollIntervalMs: 10,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => Date.now() - started >= 80 ? [control] : [],
    startHealing: () => new Promise((resolve) => setTimeout(() => resolve(undefined), 180)),
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, control);
});

test("transient control polling bounds healer retries and fails closed", async () => {
  let attempts = 0;
  const result = await waitForTransientControl({
    timeoutMs: 90,
    pollIntervalMs: 10,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => [],
    startHealing: () => {
      attempts += 1;
      return Promise.resolve(undefined);
    },
    maximumHealingAttempts: 2,
    isValid: (candidate) => Boolean(candidate),
  });
  assert.equal(result, undefined);
  assert.equal(attempts, 2);
});


test("stable condition polling rejects a brief idle flicker", async () => {
  const started = Date.now();
  const result = await waitForStableCondition({
    timeoutMs: 150,
    stableMs: 60,
    pollIntervalMs: 10,
    observe: () => {
      const elapsed = Date.now() - started;
      return elapsed >= 20 && elapsed < 55;
    },
  });
  assert.equal(result, false);
});

test("stable condition polling accepts a sustained idle state", async () => {
  const started = Date.now();
  const result = await waitForStableCondition({
    timeoutMs: 180,
    stableMs: 50,
    pollIntervalMs: 10,
    observe: () => Date.now() - started >= 35,
  });
  assert.equal(result, true);
  assert.ok(Date.now() - started >= 75);
});

test("a cancelled wait returns nothing rather than the control it was about to accept", async () => {
  const controller = new AbortController();
  controller.abort();
  const control = { id: "stop" };
  let scans = 0;
  const result = await waitForTransientControl({
    timeoutMs: 500,
    pollIntervalMs: 10,
    signal: controller.signal,
    resolveCurrent: () => control,
    collectHeuristicCandidates: () => {
      scans += 1;
      return [control];
    },
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, undefined, "a cancelled wait still returned a control");
  assert.equal(scans, 0, "a cancelled wait kept scanning the page");
});

test("a control that is already bound is returned without a heuristic scan", async () => {
  const control = { id: "stop" };
  let scans = 0;
  const result = await waitForTransientControl({
    timeoutMs: 500,
    resolveCurrent: () => control,
    collectHeuristicCandidates: () => {
      scans += 1;
      return [];
    },
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, control);
  assert.equal(scans, 0, "a bound control was re-derived from heuristics");
});

test("an ambiguous heuristic scan is refused rather than guessed", async () => {
  const started = Date.now();
  const result = await waitForTransientControl({
    timeoutMs: 120,
    pollIntervalMs: 10,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => [{ id: "stop" }, { id: "stop" }],
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, undefined, "two equally plausible controls were treated as one answer");
  assert.ok(Date.now() - started >= 110, "an ambiguous scan gave up before the timeout it was given");
});

test("a healer that returns something invalid does not end the wait", async () => {
  let healed = 0;
  const result = await waitForTransientControl({
    timeoutMs: 150,
    pollIntervalMs: 10,
    maximumHealingAttempts: 3,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => [],
    startHealing: () => {
      healed += 1;
      return Promise.resolve({ id: "not-the-stop-button" });
    },
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, undefined, "an invalid healing result was accepted as the control");
  assert.ok(healed >= 1, "healing was never attempted");
  assert.ok(healed <= 3, "healing ran past the attempts it was allowed");
});

test("a cancelled stability wait reports no stable condition", async () => {
  const controller = new AbortController();
  controller.abort();
  const stable = await waitForStableCondition({
    timeoutMs: 500,
    stableMs: 0,
    signal: controller.signal,
    observe: () => true,
  });
  assert.equal(stable, false, "a cancelled wait claimed the condition had settled");
});

test("stability polling accepts an observation that resolves asynchronously", async () => {
  const stable = await waitForStableCondition({
    timeoutMs: 300,
    stableMs: 20,
    pollIntervalMs: 10,
    observe: async () => true,
  });
  assert.equal(stable, true);
});

test("a condition that never holds fails closed at the timeout", async () => {
  const started = Date.now();
  const stable = await waitForStableCondition({
    timeoutMs: 120,
    stableMs: 50,
    pollIntervalMs: 10,
    observe: () => false,
  });
  assert.equal(stable, false);
  assert.ok(Date.now() - started >= 110);
});

test("a healer that fails is not retried forever and does not break the wait", async () => {
  let attempts = 0;
  const result = await waitForTransientControl({
    timeoutMs: 150,
    pollIntervalMs: 10,
    maximumHealingAttempts: 2,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => [],
    startHealing: () => {
      attempts += 1;
      return Promise.reject(new Error("the page changed while healing"));
    },
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, undefined);
  assert.ok(attempts >= 1 && attempts <= 2, `healing ran ${String(attempts)} times`);
});

test("a healer that declines to start leaves the wait polling", async () => {
  const result = await waitForTransientControl({
    timeoutMs: 80,
    pollIntervalMs: 10,
    resolveCurrent: () => undefined,
    collectHeuristicCandidates: () => [],
    startHealing: () => undefined,
    isValid: (candidate) => candidate?.id === "stop",
  });
  assert.equal(result, undefined);
});

// REVIEW-11 / BB-5. The clock these waits read is named once so a test can substitute it. Every
// wait in the generic content entry goes through it, which is what makes a locator failure or a
// stability failure end in a test rather than run for its whole wall-clock timeout.

test("the real clock is Date.now and a real pause", async () => {
  const before = Date.now();
  assert.ok(Math.abs(now() - before) < 50, "the default clock is not the wall clock");
  await delay(5);
  assert.ok(Date.now() >= before, "the default pause did not use a real timer");
});

test("a substituted clock is what every wait reads, and passing nothing restores the real one", async () => {
  let fake = 500_000;
  const pauses = [];
  setWaitScheduler({
    now: () => fake,
    delay: (ms) => {
      pauses.push(ms);
      fake += ms;
      return Promise.resolve();
    },
  });
  try {
    assert.equal(now(), 500_000);
    const before = Date.now();
    // A condition that is never observed has to reach its deadline. On the real clock this is
    // a two-second wait; on a substituted one it is however many turns the polling takes.
    const settled = await waitForStableCondition({
      timeoutMs: 2_000,
      stableMs: 500,
      pollIntervalMs: 100,
      observe: () => false,
    });
    assert.equal(settled, false);
    assert.ok(pauses.length > 0, "the wait never paused, so it never read the clock");
    assert.ok(fake >= 502_000, "the deadline was not reached by advancing the clock");
    assert.ok(Date.now() - before < 1_000, "the wait spent real time it did not need to");
  } finally {
    setWaitScheduler();
  }
  const restored = Date.now();
  assert.ok(Math.abs(now() - restored) < 50, "the real clock was not restored");
});

test("a substituted clock ends a transient-control search at its deadline too", async () => {
  let fake = 0;
  setWaitScheduler({
    now: () => fake,
    delay: (ms) => {
      fake += ms;
      return Promise.resolve();
    },
  });
  try {
    const found = await waitForTransientControl({
      timeoutMs: 3_000,
      pollIntervalMs: 50,
      resolveCurrent: () => undefined,
      collectHeuristicCandidates: () => [],
      isValid: (candidate) => candidate !== undefined,
    });
    assert.equal(found, undefined);
    assert.ok(fake >= 3_000, "the search did not reach its own deadline");
  } finally {
    setWaitScheduler();
  }
});
