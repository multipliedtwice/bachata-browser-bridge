import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBridgeEndpoint } from "../dist/background/endpoint.js";

test("bridge endpoint accepts only the exact loopback protocol endpoint", () => {
  assert.equal(
    normalizeBridgeEndpoint(" ws://127.0.0.1:32123/bachata-browser-bridge-v9 "),
    "ws://127.0.0.1:32123/bachata-browser-bridge-v9",
  );
  assert.equal(
    normalizeBridgeEndpoint("ws://127.0.0.1:080/bachata-browser-bridge-v9"),
    "ws://127.0.0.1:80/bachata-browser-bridge-v9",
  );
  assert.throws(
    () => normalizeBridgeEndpoint("ws://127.0.0.1:99999/bachata-browser-bridge-v9"),
    /between 1 and 65535/u,
  );
  assert.throws(
    () => normalizeBridgeEndpoint("ws://localhost:32123/bachata-browser-bridge-v9"),
    /loopback WebSocket URL/u,
  );
  assert.throws(
    () => normalizeBridgeEndpoint("wss://127.0.0.1:32123/bachata-browser-bridge-v9"),
    /loopback WebSocket URL/u,
  );
  assert.throws(
    () => normalizeBridgeEndpoint("ws://127.0.0.1:32123/bachata-browser-bridge-v9?x=1"),
    /loopback WebSocket URL/u,
  );
  assert.throws(
    () => normalizeBridgeEndpoint("ws://127.0.0.1:32123/bachata-browser-bridge-v7"),
    /loopback WebSocket URL/u,
  );
});

// REVIEW-12 / BB-AUD-09. The endpoint is rebuilt from the range-checked capture rather than
// echoed back, so no component of the caller's string can survive normalisation. These pin
// that property, and the rejection paths the single anchored pattern is now solely
// responsible for.
test("a normalised endpoint is rebuilt, never echoed", () => {
  assert.equal(
    normalizeBridgeEndpoint("ws://127.0.0.1:00001/bachata-browser-bridge-v9"),
    "ws://127.0.0.1:1/bachata-browser-bridge-v9",
  );
  assert.equal(
    normalizeBridgeEndpoint("ws://127.0.0.1:65535/bachata-browser-bridge-v9"),
    "ws://127.0.0.1:65535/bachata-browser-bridge-v9",
  );
});

test("userinfo, query and fragment are refused by the anchored pattern", () => {
  for (const value of [
    "ws://user@127.0.0.1:32123/bachata-browser-bridge-v9",
    "ws://user:secret@127.0.0.1:32123/bachata-browser-bridge-v9",
    "ws://127.0.0.1:32123/bachata-browser-bridge-v9#fragment",
    "ws://127.0.0.1:32123/bachata-browser-bridge-v9/extra",
    "ws://127.0.0.1:32123/bachata-browser-bridge-v9 trailing",
    "ws://127.0.0.1/bachata-browser-bridge-v9",
    "ws://127.0.0.2:32123/bachata-browser-bridge-v9",
  ]) {
    assert.throws(
      () => normalizeBridgeEndpoint(value),
      /loopback WebSocket URL/u,
      `${value} was accepted`,
    );
  }
});

test("a non-string endpoint is refused before any parsing", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.throws(() => normalizeBridgeEndpoint(value), /must be a string/u);
  }
});

test("the port range is enforced at both ends", () => {
  assert.throws(() => normalizeBridgeEndpoint("ws://127.0.0.1:0/bachata-browser-bridge-v9"), /between 1 and 65535/u);
  assert.throws(() => normalizeBridgeEndpoint("ws://127.0.0.1:65536/bachata-browser-bridge-v9"), /between 1 and 65535/u);
});
