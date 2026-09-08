import assert from "node:assert/strict";
import test from "node:test";
import { createPopupRecoveryStore, isPopupRecovery, popupRecoveryDescription, recoveryForRequest } from "../dist/background/popupRecovery.js";

test("recovery wording preserves submission and Stop uncertainty", () => {
  for (const kind of ["failure", "capture", "binding", "stopUnconfirmed", "stopped"]) {
    for (const request of [{}, { submissionAttempted: true }, { submissionCommitted: true }, { submissionAttempted: true, submissionCommitted: true }]) {
      const recovery = recoveryForRequest(request, kind);
      assert.equal(isPopupRecovery(recovery), true);
      const text = popupRecoveryDescription(recovery);
      assert.match(text, request.submissionCommitted ? /Prompt was submitted/ : request.submissionAttempted ? /submission is uncertain/ : /was not submitted/);
      assert.match(text, /No prompt will be resent/);
      if (kind === "stopUnconfirmed") assert.match(text, /Stop was not confirmed; generation may still be running/);
      assert.doesNotMatch(text, /retry|resend automatically|Stop confirmed/i);
    }
  }
  for (const invalid of [null, [], {}, { kind: "failure", submission: "uncertain", extra: true }, { kind: "retry", submission: "committed" }, { kind: "failure", submission: false }]) {
    assert.equal(isPopupRecovery(invalid), false);
  }
});

test("recovery stays tied to its document and cannot be cleared by another request", () => {
  const store = createPopupRecoveryStore();
  const request = { tabId: 1, requestId: "one", documentToken: "document", conversationIdentity: "conversation", submissionAttempted: true };
  assert.equal(store.get(1), undefined);
  store.remember(request, "failure");
  assert.equal(store.get(1, request).kind, "failure");
  assert.equal(store.get(1, { ...request, documentToken: "replacement" }).kind, "binding");
  assert.equal(store.get(1, { ...request, conversationIdentity: "other" }).kind, "binding");
  assert.equal(store.get(1).kind, "binding");
  store.clear(1, "another");
  assert.ok(store.get(1));
  store.clear(1, "one");
  assert.equal(store.get(1), undefined);
  store.remember(request, "stopUnconfirmed");
  store.clear(1);
  assert.equal(store.get(1), undefined);
});

test("recovery retains one bounded current state per tab", () => {
  const store = createPopupRecoveryStore();
  for (let tabId = 1; tabId <= 201; tabId += 1) {
    store.remember({ tabId, requestId: String(tabId), documentToken: "document", conversationIdentity: "conversation" }, "failure");
  }
  assert.equal(store.get(1), undefined);
  assert.ok(store.get(2));
  store.remember({ tabId: 2, requestId: "new", documentToken: "document", conversationIdentity: "conversation" }, "stopped");
  store.clear(2, "2");
  assert.ok(store.get(2));
});
