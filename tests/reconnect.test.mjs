import assert from "node:assert/strict";
import test from "node:test";

import {
  clearReconnectWakeup,
  maximumStoredReconnectAttempt,
  nextReconnectMetadata,
  persistedReconnectAttempt,
  reconnectAlarmName,
  reconnectDelay,
  reconnectDelayUntil,
  sanitizeReconnectMetadata,
  scheduleReconnectWakeup,
  shouldRestoreReconnect,
} from "../dist/background/reconnect.js";

test("reconnect metadata is accepted only with valid credentials and bounded values", () => {
  assert.deepEqual(sanitizeReconnectMetadata({ reconnectAttempt: 2, reconnectAt: 12.9 }), {});
  assert.deepEqual(
    sanitizeReconnectMetadata({ reconnectAttempt: 2, reconnectAt: 12.9 }, "token"),
    { reconnectAttempt: 2, reconnectAt: 12 },
  );
  for (const reconnectAttempt of [-1, maximumStoredReconnectAttempt + 1, 1.5, "2"]) {
    assert.deepEqual(
      sanitizeReconnectMetadata({ reconnectAttempt, reconnectAt: 12 }, "token"),
      { reconnectAt: 12 },
    );
  }
  for (const reconnectAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
    assert.deepEqual(
      sanitizeReconnectMetadata({ reconnectAttempt: 2, reconnectAt }, "token"),
      { reconnectAttempt: 2 },
    );
  }
});

test("reconnect backoff and persisted attempt values are deterministic and bounded", () => {
  assert.equal(reconnectDelay(0, () => 0.5), 3_000);
  assert.equal(reconnectDelay(4, () => 0), 43_200);
  assert.equal(reconnectDelay(99, () => 1), 66_000);
  assert.equal(reconnectDelay(-10, () => 0), 1_000);
  assert.deepEqual(nextReconnectMetadata(4, 1_000, () => 0.5), {
    reconnectAttempt: 5,
    reconnectAt: 49_000,
    delay: 48_000,
  });
  assert.equal(
    nextReconnectMetadata(maximumStoredReconnectAttempt, 0, () => 0.5).reconnectAttempt,
    maximumStoredReconnectAttempt,
  );
  assert.equal(persistedReconnectAttempt(0), undefined);
  assert.equal(persistedReconnectAttempt(2), 2);
  assert.equal(reconnectDelayUntil(10, 20), 1);
  assert.equal(reconnectDelayUntil(30, 20), 10);
});

test("persisted reconnect restoration requires complete future state", () => {
  assert.equal(shouldRestoreReconnect("ws://example", "token", 11, 10), true);
  assert.equal(shouldRestoreReconnect(undefined, "token", 11, 10), false);
  assert.equal(shouldRestoreReconnect("ws://example", undefined, 11, 10), false);
  assert.equal(shouldRestoreReconnect("ws://example", "token", undefined, 10), false);
  assert.equal(shouldRestoreReconnect("ws://example", "token", 10, 10), false);
});

test("reconnect wakeups clear timers and alarms without surfacing alarm failures", async () => {
  const clearedTimers = [];
  const clearedAlarms = [];
  clearReconnectWakeup(7, {
    create: async () => undefined,
    clear: async (name) => {
      clearedAlarms.push(name);
      return true;
    },
  }, (timer) => clearedTimers.push(timer));
  await Promise.resolve();
  assert.deepEqual(clearedTimers, [7]);
  assert.deepEqual(clearedAlarms, [reconnectAlarmName]);

  clearReconnectWakeup(undefined, undefined, () => {
    throw new Error("unexpected timer clear");
  });
  clearReconnectWakeup(undefined, {
    create: async () => undefined,
    clear: async () => {
      throw new Error("ignored clear failure");
    },
  });
  await Promise.resolve();
});

test("reconnect wakeups use timers for every delay and alarms for long delays", async () => {
  const timers = [];
  const alarms = [];
  const onDue = () => undefined;
  const setTimer = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };

  assert.deepEqual(
    scheduleReconnectWakeup(20_000, onDue, undefined, 10_000, setTimer),
    { timer: 1, retryInMs: 10_000 },
  );
  assert.deepEqual(alarms, []);

  const alarmApi = {
    create: async (name, info) => alarms.push({ name, info }),
    clear: async () => true,
  };
  assert.deepEqual(
    scheduleReconnectWakeup(50_000, onDue, alarmApi, 10_000, setTimer),
    { timer: 2, retryInMs: 40_000 },
  );
  await Promise.resolve();
  assert.deepEqual(alarms, [{ name: reconnectAlarmName, info: { when: 50_000 } }]);

  const throwingAlarm = {
    create: () => {
      throw new Error("ignored create failure");
    },
    clear: async () => true,
  };
  assert.deepEqual(
    scheduleReconnectWakeup(60_000, onDue, throwingAlarm, 10_000, setTimer),
    { timer: 3, retryInMs: 50_000 },
  );

  const rejectingAlarm = {
    create: async () => {
      throw new Error("ignored async create failure");
    },
    clear: async () => true,
  };
  assert.deepEqual(
    scheduleReconnectWakeup(70_000, onDue, rejectingAlarm, 10_000, setTimer),
    { timer: 4, retryInMs: 60_000 },
  );
  await Promise.resolve();
});
