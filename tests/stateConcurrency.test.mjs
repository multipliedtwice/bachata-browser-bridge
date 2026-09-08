import assert from "node:assert/strict";
import test from "node:test";

import {
  createRevisionQueue,
  createSnapshotWriteQueue,
} from "../dist/background/serializedState.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("popup mutations and reads complete in one revision order", async () => {
  const queue = createRevisionQueue();
  const release = deferred();
  const events = [];

  const first = queue.enqueueMutation(async () => {
    events.push("first:start");
    await release.promise;
    events.push("first:end");
  });
  const second = queue.enqueueMutation(async () => {
    events.push("second");
  });
  const read = queue.enqueueRead(async () => {
    events.push(`read:${String(queue.revision())}`);
    return queue.revision();
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["first:start"]);

  release.resolve();
  await Promise.all([first, second]);
  assert.equal(await read, 2);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second",
    "read:2",
  ]);
});


test("a later popup mutation cannot overtake an asynchronous read", async () => {
  const queue = createRevisionQueue();
  const readStarted = deferred();
  const releaseRead = deferred();
  const events = [];

  const read = queue.enqueueRead(async () => {
    events.push("read:start");
    readStarted.resolve();
    await releaseRead.promise;
    events.push("read:end");
  });
  const mutation = queue.enqueueMutation(async () => {
    events.push("mutation");
  });

  await readStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["read:start"]);

  releaseRead.resolve();
  await Promise.all([read, mutation]);
  assert.deepEqual(events, ["read:start", "read:end", "mutation"]);
  assert.equal(queue.revision(), 1);
});

test("a failed popup mutation does not poison later operations", async () => {
  const queue = createRevisionQueue();
  await assert.rejects(
    queue.enqueueMutation(async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  const result = await queue.enqueueMutation(async () => "recovered");
  assert.equal(result, "recovered");
  assert.equal(queue.revision(), 2);
});

test("storage writes preserve enqueue order and immutable snapshots", async () => {
  const release = deferred();
  const writes = [];
  let first = true;
  const queue = createSnapshotWriteQueue(
    structuredClone,
    async (snapshot) => {
      if (first) {
        first = false;
        await release.promise;
      }
      writes.push(snapshot);
    },
  );

  const state = { selectedTabId: 1 };
  const one = queue.enqueue(state);
  state.selectedTabId = 2;
  const two = queue.enqueue(state);
  state.selectedTabId = 3;

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, []);
  release.resolve();
  await Promise.all([one, two, queue.flush()]);
  assert.deepEqual(writes, [{ selectedTabId: 1 }, { selectedTabId: 2 }]);
});
