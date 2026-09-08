import assert from "node:assert/strict";
import test from "node:test";

import { createProvisioningQueue } from "../dist/background/provisioning.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("provisioning queue enforces concurrency and drains in order", async () => {
  const releases = new Map();
  const started = [];
  const settled = [];
  const queue = createProvisioningQueue({
    maxConcurrent: 2,
    run: async (requestId) => {
      started.push(requestId);
      const release = deferred();
      releases.set(requestId, release);
      return release.promise;
    },
    settle: (requestId, input, outcome) => {
      settled.push({ requestId, input, outcome });
    },
  });

  assert.equal(queue.enqueue("one", 1), true);
  assert.equal(queue.enqueue("two", 2), true);
  assert.equal(queue.enqueue("three", 3), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(started, ["one", "two"]);
  assert.equal(queue.activeCount(), 2);
  assert.equal(queue.queuedCount(), 1);

  releases.get("one").resolve("result-one");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(started, ["one", "two", "three"]);
  assert.equal(queue.activeCount(), 2);
  assert.equal(queue.queuedCount(), 0);

  releases.get("two").resolve("result-two");
  releases.get("three").resolve("result-three");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    settled.map(({ requestId, outcome }) => [requestId, outcome.status]),
    [["one", "completed"], ["two", "completed"], ["three", "completed"]],
  );
  assert.equal(queue.activeCount(), 0);
  assert.equal(queue.queuedCount(), 0);
});

test("provisioning queue deduplicates active request ids", async () => {
  const release = deferred();
  let runs = 0;
  const queue = createProvisioningQueue({
    maxConcurrent: 1,
    run: async () => {
      runs += 1;
      return release.promise;
    },
    settle: () => undefined,
  });

  assert.equal(queue.enqueue("same", 1), true);
  assert.equal(queue.enqueue("same", 2), false);
  assert.equal(runs, 1);
  release.resolve("ok");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 1);
});

test("queued provisioning cancellation settles immediately", async () => {
  const first = deferred();
  const settled = [];
  const queue = createProvisioningQueue({
    maxConcurrent: 1,
    run: async (requestId) => requestId === "one" ? first.promise : "unexpected",
    settle: (requestId, input, outcome) => settled.push({ requestId, input, outcome }),
  });

  queue.enqueue("one", 1);
  queue.enqueue("two", 2);
  assert.equal(queue.cancel("two"), true);
  assert.equal(queue.has("two"), false);
  assert.equal(queue.queuedCount(), 0);
  assert.deepEqual(settled.map(({ requestId, outcome }) => [requestId, outcome.status]), [["two", "cancelled"]]);

  first.resolve("ok");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("running provisioning cancellation aborts and settles once", async () => {
  const settled = [];
  const queue = createProvisioningQueue({
    maxConcurrent: 1,
    run: async (_requestId, _input, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    settle: (requestId, input, outcome) => settled.push({ requestId, input, outcome }),
  });

  queue.enqueue("one", 1);
  assert.equal(queue.cancel("one"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(settled.map(({ requestId, outcome }) => [requestId, outcome.status]), [["one", "cancelled"]]);
  assert.equal(queue.has("one"), false);
  assert.equal(queue.activeCount(), 0);
});

test("cancelAll cancels queued and running provisioning", async () => {
  const settled = [];
  const queue = createProvisioningQueue({
    maxConcurrent: 1,
    run: async (_requestId, _input, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    settle: (requestId, input, outcome) => settled.push({ requestId, input, outcome }),
  });

  queue.enqueue("one", 1);
  queue.enqueue("two", 2);
  queue.cancelAll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    settled.map(({ requestId, outcome }) => [requestId, outcome.status]).sort(),
    [["one", "cancelled"], ["two", "cancelled"]],
  );
  assert.equal(queue.activeCount(), 0);
  assert.equal(queue.queuedCount(), 0);
});
