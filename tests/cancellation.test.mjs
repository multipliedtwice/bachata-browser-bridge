import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  abortableDelay,
  abortError,
  throwIfAborted,
} from "../dist/background/cancellation.js";

// BB-AUD-09. The provisioning waits used to carry these inline in the service-worker entry,
// where the only way to reach a cancellation path was to drive a whole conversation open.

test("a cancellation is named as one, not as a timeout", () => {
  assert.match(abortError().message, /cancelled/);
});

test("an already-aborted signal throws before anything is scheduled", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), /cancelled/);
  assert.doesNotThrow(() => throwIfAborted(new AbortController().signal));
});

test("a delay that is never cancelled resolves when its time is up", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const waited = abortableDelay(50, controller.signal);
    mock.timers.tick(50);
    assert.equal(await waited, undefined);
    assert.equal(listenerCount(controller.signal), 0);
  } finally {
    mock.timers.reset();
  }
});

test("a delay rejects the moment its signal aborts", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const waited = abortableDelay(60_000, controller.signal);
    controller.abort();
    await assert.rejects(waited, /cancelled/);
  } finally {
    mock.timers.reset();
  }
});

test("a delay on an already-aborted signal rejects without waiting", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortableDelay(60_000, controller.signal), /cancelled/);
});

// A service worker outlives any one request. A listener left on a long-lived signal would
// keep every past delay's closure alive, so both paths have to detach.
const listenerCount = (signal) => {
  let count = 0;
  const original = signal.removeEventListener.bind(signal);
  signal.removeEventListener = (...args) => {
    count += 1;
    return original(...args);
  };
  return count;
};

test("both endings detach the abort listener", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const resolved = new AbortController();
    const detached = [];
    const track = (controller) => {
      const original = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = (type, listener, options) => {
        detached.push(type);
        return original(type, listener, options);
      };
    };
    track(resolved);
    const waited = abortableDelay(10, resolved.signal);
    mock.timers.tick(10);
    await waited;

    const cancelled = new AbortController();
    track(cancelled);
    const pending = abortableDelay(60_000, cancelled.signal);
    cancelled.abort();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(detached, ["abort", "abort"]);
  } finally {
    mock.timers.reset();
  }
});
