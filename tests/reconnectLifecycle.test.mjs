import assert from "node:assert/strict";
import test from "node:test";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const saveGlobals = (names) => new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

const restoreGlobals = (saved) => {
  for (const [name, descriptor] of saved) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
};

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
};

const createEvent = () => {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    listeners,
  };
};

const backgroundChromeSupport = () => ({
  contextMenus: {
    create: () => undefined,
    remove: async () => undefined,
    onClicked: { addListener: () => undefined },
  },
});

test("production background restores an alarm-backed reconnect after service-worker restart", async () => {
  const names = [
    "chrome",
    "WebSocket",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
  ];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  const alarmEvent = createEvent();
  const writes = [];
  const createdAlarms = [];
  const clearedAlarms = [];
  const timers = new Map();
  const sockets = [];
  let nextTimerId = 1;
  const reconnectAt = Date.now() + 60_000;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      alarms: {
        create: async (name, info) => createdAlarms.push({ name, info: structuredClone(info) }),
        clear: async (name) => {
          clearedAlarms.push(name);
          return true;
        },
        onAlarm: alarmEvent,
      },
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({
            "bachataBridgeState.v8": {
              endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
              connectionToken: "saved-token",
              reconnectAttempt: 4,
              reconnectAt,
            },
          }),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [],
        get: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async () => ({ success: false }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: createEvent(),
      },
      // N1. The entry subscribes Chrome's navigation events at load, so every harness that
      // starts it has to offer them.
      webNavigation: {
        onCommitted: createEvent(),
        onHistoryStateUpdated: createEvent(),
        onReferenceFragmentUpdated: createEvent(),
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      close() {
        this.readyState = 3;
      }

      send() {}
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setTimeout", (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    });
    setGlobal("clearTimeout", (id) => timers.delete(id));
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?alarm-reconnect-${Date.now()}-${Math.random()}`);
    await nextTurn();
    await nextTurn();

    assert.equal(sockets.length, 0);
    assert.equal(alarmEvent.listeners.length, 1);
    assert.equal(createdAlarms.some((value) => value.name === "bachataBridgeReconnect.v8" && value.info.when === reconnectAt), true);

    alarmEvent.listeners[0]({ name: "bachataBridgeReconnect.v8", scheduledTime: reconnectAt });
    await nextTurn();
    await nextTurn();

    assert.equal(sockets.length, 1);
    assert.equal(clearedAlarms.includes("bachataBridgeReconnect.v8"), true);
    assert.equal(writes.some((value) => value["bachataBridgeState.v8"]?.reconnectAt === undefined), true);
  } finally {
    restoreGlobals(saved);
  }
});


test("production background schedules a short reconnect after the active socket closes", async () => {
  const names = ["chrome", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  const timers = new Map();
  const writes = [];
  const sockets = [];
  let nextTimerId = 1;
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({
            "bachataBridgeState.v8": {
              endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
              connectionToken: "saved-token",
            },
          }),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [],
        get: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async () => ({ success: false }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: createEvent(),
      },
      // N1. The entry subscribes Chrome's navigation events at load, so every harness that
      // starts it has to offer them.
      webNavigation: {
        onCommitted: createEvent(),
        onHistoryStateUpdated: createEvent(),
        onReferenceFragmentUpdated: createEvent(),
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      close() {
        this.readyState = 3;
        this.emit("close");
      }

      send() {}
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setTimeout", (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    });
    setGlobal("clearTimeout", (id) => timers.delete(id));
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?short-reconnect-${Date.now()}-${Math.random()}`);
    await nextTurn();
    await nextTurn();

    assert.equal(sockets.length, 1);
    sockets[0].emit("close");
    await nextTurn();

    const reconnectTimer = [...timers.values()].find((timer) => timer.delay >= 2_700 && timer.delay <= 3_300);
    assert.ok(reconnectTimer);
    assert.equal(writes.some((value) => value["bachataBridgeState.v8"]?.reconnectAttempt === 1), true);
    reconnectTimer.callback();
    await nextTurn();
    await nextTurn();
    assert.equal(sockets.length, 2);
  } finally {
    restoreGlobals(saved);
  }
});

test("production background clears expired reconnect metadata and ignores stale alarm events", async () => {
  const names = ["chrome", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  const alarmEvent = createEvent();
  const writes = [];
  const sockets = [];
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      alarms: {
        create: async () => undefined,
        clear: async () => true,
        onAlarm: alarmEvent,
      },
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({
            "bachataBridgeState.v8": {
              endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
              connectionToken: "saved-token",
              reconnectAttempt: 99,
              reconnectAt: Date.now() - 10_000,
            },
          }),
          set: async (value) => writes.push(structuredClone(value)),
        },
      },
      tabs: {
        query: async () => [],
        get: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async () => ({ success: false }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: createEvent(),
      },
      // N1. The entry subscribes Chrome's navigation events at load, so every harness that
      // starts it has to offer them.
      webNavigation: {
        onCommitted: createEvent(),
        onHistoryStateUpdated: createEvent(),
        onReferenceFragmentUpdated: createEvent(),
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      close() {}
      send() {}
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setTimeout", () => 1);
    setGlobal("clearTimeout", () => undefined);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?expired-reconnect-${Date.now()}-${Math.random()}`);
    await nextTurn();
    await nextTurn();

    assert.equal(sockets.length, 1);
    assert.equal(writes.some((value) => value["bachataBridgeState.v8"]?.reconnectAt === undefined), true);
    alarmEvent.listeners[0]({ name: "unrelated-alarm", scheduledTime: Date.now() });
    alarmEvent.listeners[0]({ name: "bachataBridgeReconnect.v8", scheduledTime: Date.now() });
    await nextTurn();
    assert.equal(sockets.length, 1);
  } finally {
    restoreGlobals(saved);
  }
});

test("production background keeps a long retry timer when Chrome alarm creation fails", async () => {
  const names = ["chrome", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval"];
  const saved = saveGlobals(names);
  const runtimeEvent = createEvent();
  const removedEvent = createEvent();
  const updatedEvent = createEvent();
  const alarmEvent = createEvent();
  const timers = [];
  const sockets = [];
  try {
    const chrome = {
      ...backgroundChromeSupport(),
      alarms: {
        create: () => {
          throw new Error("alarm creation failed");
        },
        clear: async () => true,
        onAlarm: alarmEvent,
      },
      runtime: { onMessage: runtimeEvent },
      storage: {
        local: {
          get: async () => ({
            "bachataBridgeState.v8": {
              endpoint: "ws://127.0.0.1:43123/bachata-browser-bridge-v9",
              connectionToken: "saved-token",
              reconnectAttempt: 4,
            },
          }),
          set: async () => undefined,
        },
      },
      tabs: {
        query: async () => [],
        get: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async () => ({ success: false }),
        onRemoved: removedEvent,
        onUpdated: updatedEvent,
        onReplaced: createEvent(),
      },
      // N1. The entry subscribes Chrome's navigation events at load, so every harness that
      // starts it has to offer them.
      webNavigation: {
        onCommitted: createEvent(),
        onHistoryStateUpdated: createEvent(),
        onReferenceFragmentUpdated: createEvent(),
      },
      scripting: { executeScript: async () => undefined },
      windows: { update: async () => undefined },
    };
    class FakeWebSocket {
      static OPEN = 1;

      constructor(endpoint) {
        this.endpoint = endpoint;
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }

      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? [];
        values.push(listener);
        this.listeners.set(type, values);
      }

      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      close() {}
      send() {}
    }
    setGlobal("chrome", chrome);
    setGlobal("WebSocket", FakeWebSocket);
    setGlobal("setTimeout", (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    });
    setGlobal("clearTimeout", () => undefined);
    setGlobal("setInterval", () => 1);
    setGlobal("clearInterval", () => undefined);

    await import(`../dist/background/index.js?failed-alarm-${Date.now()}-${Math.random()}`);
    await nextTurn();
    await nextTurn();
    sockets[0].emit("close");
    await nextTurn();

    assert.equal(timers.some((timer) => timer.delay >= 43_200 && timer.delay <= 52_800), true);
  } finally {
    restoreGlobals(saved);
  }
});
