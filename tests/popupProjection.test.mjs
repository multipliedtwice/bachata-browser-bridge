import assert from "node:assert/strict";
import test from "node:test";

import {
  POPUP_LIMITS,
  projectPopupState,
  projectPopupTabs,
  isPopupCapabilities,
  popupCapabilityDescription,
} from "../dist/background/popupProjection.js";

test("capability disclosure covers every supported combination without upgrading guarantees", () => {
  for (const submission of ["verifiedSend", "syntheticEnter", "native"]) {
    for (const completion of ["verifiedLifecycle", "manualOnly", "native"]) {
      for (const interruption of ["confirmed", "unavailable", "native"]) {
        for (const assets of ["supported", "textOnly"]) {
          for (const conversationState of ["confirmed", "uncertain"]) {
            const capabilities = { submission, completion, interruption, assets, conversationState };
            assert.equal(isPopupCapabilities(capabilities), true);
            const projected = projectPopupTabs([tab()], [session({ capabilities })])[0];
            assert.deepEqual(projected.capabilities, capabilities);
            assert.notEqual(projected.capabilities, capabilities);
            const description = popupCapabilityDescription(projected.capabilities);
            assert.match(description.summary, completion === "manualOnly" ? /Manual response selection required/ : /Automatic completion available/);
            assert.equal(description.details.includes("Stop confirmed"), interruption === "confirmed");
            assert.equal(description.details.includes("Send control verified"), submission === "verifiedSend");
            assert.equal(description.details.includes("Text and assets"), assets === "supported");
            assert.equal(description.details.includes("Conversation confirmed"), conversationState === "confirmed");
            if (conversationState === "uncertain") assert.match(description.summary, /Conversation uncertain/);
            if (interruption === "unavailable") assert.match(description.summary, /Stop unavailable/);
          }
        }
      }
    }
  }
});

test("legacy and malformed capabilities never become an affirmative capability claim", () => {
  const valid = { submission: "native", completion: "native", interruption: "native", assets: "supported", conversationState: "confirmed" };
  const missing = Object.keys(valid).map((key) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key)));
  const invalid = [null, [], {}, "native", ...missing, { ...valid, extra: true }, ...Object.keys(valid).flatMap((key) => [
    { ...valid, [key]: undefined }, { ...valid, [key]: "unexpected" }, { ...valid, [key]: [valid[key]] },
  ])];
  for (const capabilities of invalid) {
    assert.equal(isPopupCapabilities(capabilities), false);
    const projected = projectPopupTabs([tab()], [session({ capabilities })])[0];
    assert.equal(projected.capabilities, undefined);
    assert.match(popupCapabilityDescription(projected.capabilities).summary, /not reported/);
  }
  assert.equal(projectPopupTabs([tab()], [session()])[0].capabilities, undefined);
});


// BB-AUD-09. The popup's view sat beside the `chrome.tabs.query` and session build that feed
// it, so the shape the popup actually receives could only be reached by driving the whole
// service worker.

const tab = (overrides = {}) => ({
  id: 1,
  provider: "chatgpt",
  title: "ChatGPT",
  url: "https://chatgpt.com/c/1",
  ...overrides,
});

const session = (overrides = {}) => ({
  id: "session-1",
  provider: "chatgpt",
  tabId: 1,
  frameId: 0,
  documentToken: "document-1",
  conversationUrl: "https://chatgpt.com/c/1",
  conversationIdentity: "conversation-1",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("a registered ready tab carries its session identity and reads as ready", () => {
  const [projected] = projectPopupTabs([tab()], [session()], undefined);
  assert.equal(projected.ready, true);
  assert.equal(projected.reason, "Ready");
  assert.equal(projected.sessionId, "session-1");
  assert.equal(projected.conversationUrl, "https://chatgpt.com/c/1");
  assert.equal(projected.conversationIdentity, "conversation-1");
  assert.equal(projected.title, "ChatGPT");
});

test("a tab with no session is shown as unregistered, not omitted", () => {
  const [projected] = projectPopupTabs([tab()], [], undefined);
  assert.equal(projected.status, "unregistered");
  assert.equal(projected.ready, false);
  assert.equal(Object.hasOwn(projected, "sessionId"), false);
  assert.equal(Object.hasOwn(projected, "conversationUrl"), false);
  assert.equal(Object.hasOwn(projected, "conversationIdentity"), false);
  assert.notEqual(projected.reason, "");
});

test("a registered tab that is not ready explains why", () => {
  const [projected] = projectPopupTabs([tab()], [session({ status: "notAuthenticated" })], undefined);
  assert.equal(projected.ready, false);
  assert.match(projected.reason, /Sign in/u);
  assert.equal(projected.sessionId, "session-1");
});

test("each tab is matched to its own session", () => {
  const projected = projectPopupTabs(
    [tab({ id: 1 }), tab({ id: 2, provider: "claude", url: "https://claude.ai/chat/2" })],
    [session({ id: "b", tabId: 2, provider: "claude" })],
    undefined,
  );
  assert.deepEqual(projected.map((row) => row.status), ["unregistered", "ready"]);
  assert.deepEqual(projected.map((row) => row.sessionId), [undefined, "b"]);
});

test("a session for a tab the popup is not showing changes nothing", () => {
  const projected = projectPopupTabs([tab({ id: 1 })], [session({ tabId: 9 })], undefined);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].status, "unregistered");
});

test("an unconfigured endpoint or selection is left out rather than sent blank", () => {
  const state = projectPopupState({
    revision: 4,
    connected: false,
    connecting: true,
    tabs: [],
  });
  assert.equal(Object.hasOwn(state, "endpoint"), false);
  assert.equal(Object.hasOwn(state, "selectedTabId"), false);
  assert.equal(state.revision, 4);
  assert.equal(state.connecting, true);
  assert.deepEqual(state.tabs, []);
});

test("a stored endpoint and selection are projected", () => {
  const state = projectPopupState({
    endpoint: "ws://127.0.0.1:8391",
    selectedTabId: 7,
    revision: 1,
    connected: true,
    connecting: false,
    retryInMs: 500,
    error: "last failure",
    tabs: [],
  });
  assert.equal(state.endpoint, "ws://127.0.0.1:8391");
  assert.equal(state.selectedTabId, 7);
  assert.equal(state.retryInMs, 500);
  assert.equal(state.error, "last failure");
});

test("an empty endpoint and tab zero are treated as unconfigured", () => {
  const state = projectPopupState({
    endpoint: "",
    selectedTabId: 0,
    revision: 0,
    connected: false,
    connecting: false,
    tabs: [],
  });
  assert.equal(Object.hasOwn(state, "endpoint"), false);
  assert.equal(Object.hasOwn(state, "selectedTabId"), false);
});

// BR-G6-15. The popup rejects the whole state when any field is over its limit — no tabs, no
// endpoint, not even the error — so one long title or conversation URL used to blank the popup
// entirely. The projection holds the same bounds now, so a long value costs its own field.
test("a projection the popup would reject is never produced", () => {
  const long = (length) => "x".repeat(length);
  const tabs = projectPopupTabs(
    Array.from({ length: POPUP_LIMITS.tabs + 5 }, (_, index) => ({
      id: index + 1,
      provider: "chatgpt",
      title: long(POPUP_LIMITS.title + 10),
      url: long(POPUP_LIMITS.url + 10),
    })),
    [{
      id: long(POPUP_LIMITS.sessionId + 10),
      tabId: 1,
      provider: "chatgpt",
      status: "ready",
      conversationUrl: long(POPUP_LIMITS.conversationUrl + 10),
      conversationIdentity: long(POPUP_LIMITS.conversationIdentity + 10),
    }],
    undefined,
  );
  assert.equal(tabs.length, POPUP_LIMITS.tabs, "the tab list was produced over the popup's cap");
  assert.equal(tabs[0].title.length, POPUP_LIMITS.title);
  assert.equal(tabs[0].url.length, POPUP_LIMITS.url);
  assert.equal(tabs[0].sessionId.length, POPUP_LIMITS.sessionId);
  assert.equal(tabs[0].conversationUrl.length, POPUP_LIMITS.conversationUrl);
  assert.equal(tabs[0].conversationIdentity.length, POPUP_LIMITS.conversationIdentity);

  const state = projectPopupState({
    endpoint: long(POPUP_LIMITS.endpoint + 10),
    revision: 1,
    connected: true,
    connecting: false,
    error: long(POPUP_LIMITS.error + 10),
    tabs,
  });
  assert.equal(state.endpoint.length, POPUP_LIMITS.endpoint);
  assert.equal(state.error.length, POPUP_LIMITS.error);
});

// BB-A4-N07. The cap used to be taken blind to the selection, so past two hundred provider tabs
// the bound conversation could be dropped from the projection while the state still reported its
// id: the popup showed no bound row and no Unbind control, while the worker kept routing to it.
const overCapTabs = (count) => Array.from({ length: count }, (_, index) => ({
  id: index + 1,
  provider: "chatgpt",
  title: `ChatGPT ${String(index + 1)}`,
  url: `https://chatgpt.com/c/${String(index + 1)}`,
}));

test("the bound conversation survives the tab cap", () => {
  const selectedTabId = POPUP_LIMITS.tabs + 5;
  const projected = projectPopupTabs(
    overCapTabs(POPUP_LIMITS.tabs + 5),
    [session({ tabId: selectedTabId })],
    selectedTabId,
  );
  assert.equal(projected.length, POPUP_LIMITS.tabs, "the cap was not applied");
  assert.equal(projected[0].id, selectedTabId, "the bound conversation was truncated away");
  assert.equal(projected[0].status, "ready", "the bound row lost its session");
  assert.equal(
    new Set(projected.map((row) => row.id)).size,
    projected.length,
    "pinning the selection duplicated a tab",
  );
});

test("a selection already inside the cap is not moved or duplicated", () => {
  const projected = projectPopupTabs(overCapTabs(POPUP_LIMITS.tabs + 5), [], 3);
  assert.equal(projected.length, POPUP_LIMITS.tabs);
  assert.equal(projected[0].id, 1, "an already-visible selection was pinned anyway");
  assert.equal(
    new Set(projected.map((row) => row.id)).size,
    projected.length,
  );
});

test("an over-cap state keeps the tab it says is selected", () => {
  const projected = projectPopupTabs(overCapTabs(POPUP_LIMITS.tabs + 5), [], undefined);
  const state = projectPopupState({
    revision: 1,
    connected: true,
    connecting: false,
    selectedTabId: POPUP_LIMITS.tabs + 5,
    tabs: [
      ...projected,
      ...projectPopupTabs(
        overCapTabs(POPUP_LIMITS.tabs + 5).slice(POPUP_LIMITS.tabs),
        [],
        undefined,
      ),
    ],
  });
  assert.equal(state.tabs.length, POPUP_LIMITS.tabs, "the state cap was not applied");
  assert.equal(
    state.tabs.some((row) => row.id === state.selectedTabId),
    true,
    "the state reported a selected tab it had already truncated away",
  );
  assert.equal(
    new Set(state.tabs.map((row) => row.id)).size,
    state.tabs.length,
  );
});
