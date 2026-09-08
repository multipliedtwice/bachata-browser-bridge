import assert from "node:assert/strict";
import test from "node:test";

import { createRequestOrdering } from "../dist/background/requestOrdering.js";

test("only an interrupt for a known queued send is preserved", () => {
  const ordering = createRequestOrdering();

  ordering.recordInterrupt("unknown");
  assert.equal(ordering.pendingInterrupts.has("unknown"), false);

  ordering.recordSend("request-1");
  ordering.recordInterrupt("request-1");
  assert.equal(ordering.pendingInterrupts.has("request-1"), true);

  ordering.beginSend("request-1");
  assert.equal(ordering.queuedSendIds.has("request-1"), false);
  assert.equal(ordering.pendingInterrupts.delete("request-1"), true);
});

test("request ordering state is cleared on disconnect", () => {
  const ordering = createRequestOrdering();
  ordering.recordSend("request-1");
  ordering.recordInterrupt("request-1");
  ordering.clear();
  assert.equal(ordering.queuedSendIds.size, 0);
  assert.equal(ordering.pendingInterrupts.size, 0);
});

// BB-A4-N05. A final answer that arrives while a Stop is pending is held rather than dropped, so
// whichever way the Stop settles owns it — and it can be owned exactly once.
test("a completion retained for a pending interrupt is taken once and cleared on disconnect", () => {
  const ordering = createRequestOrdering();
  const completion = async () => undefined;

  assert.equal(ordering.takeCompletion("absent"), undefined);

  ordering.retainCompletion("request-1", completion);
  assert.equal(ordering.takeCompletion("request-1"), completion);
  assert.equal(
    ordering.takeCompletion("request-1"),
    undefined,
    "a held answer was handed to two owners",
  );

  ordering.retainCompletion("request-2", completion);
  ordering.clear();
  assert.equal(
    ordering.takeCompletion("request-2"),
    undefined,
    "a held answer outlived the connection it belonged to",
  );
});
