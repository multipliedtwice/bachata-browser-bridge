import { profileIdentity } from "../dist/background/profileIdentity.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";
import { prepareGenericSetupDom, waitForSetup } from "./support/genericSetupDom.mjs";
import { setWaitScheduler } from "../dist/content/generic/transientControl.js";

// REVIEW-11 / BB-5. `content/generic/index.ts` exports nothing and installs its listeners on
// import, so no per-file gate could see it and nothing exercised its message table. It is an
// ordinary module: imported under a DOM and a `chrome` stub it registers exactly as it does in
// a page, which is what makes the guard and the message table testable at all.
//
// Driving a real request used to hang. Every wait in the entry is a wall-clock deadline and a
// pause, so a request whose page never answers spun for its full timeout and the harness could
// not end it. `setWaitScheduler` substitutes the clock those waits read — the same one
// production reads, not a second implementation — so a deadline is reached by advancing time
// rather than by waiting it out, and a locator failure, a stability failure and a timeout each
// end in the test rather than outliving it.

const dom = createGenericDom(
  "<main id=\"root\"><textarea id=\"composer\"></textarea><button id=\"send\">Send</button></main>",
);

const listeners = [];
const saved = new Map();
const define = (name, value) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

// N1 removed the 250 ms href poll, so nothing here may install a repeating timer: the entry
// is now told about navigation by the background rather than reading the route on a clock.
// Anything that did install one would hold this process open, which is what the assertion
// below is for.
const intervals = [];
define("setInterval", (callback, delayMs) => {
  intervals.push({ callback, delayMs });
  return intervals.length;
});
define("clearInterval", () => undefined);

// A cancellation schedules a 30 s bound that would outlive the suite. The timer still runs but
// no longer holds the process open.
const realSetTimeout = globalThis.setTimeout;
define("setTimeout", (callback, delayMs, ...args) => {
  const handle = realSetTimeout(callback, delayMs, ...args);
  handle.unref?.();
  return handle;
});

// The clock the entry's bounded waits read. Time only moves when a wait asks to pause, so a
// deadline is reached in as many turns as the wait takes and in no wall-clock time at all.
let clockMs = 1_000_000;
const pauses = [];
setWaitScheduler({
  now: () => clockMs,
  delay: (ms) => {
    pauses.push(ms);
    clockMs += Math.max(1, ms);
    return Promise.resolve();
  },
});

// What the background would answer. Profiles live there, not in page storage, so a bound page
// is set up by putting a profile in this list rather than by reaching into the entry.
const profiles = [];
const quarantined = new Set();
const sent = [];
let registrationOk = true;

define("chrome", {
  runtime: {
    id: "bachata-bridge-test",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: async (message) => {
      sent.push(message);
      switch (message?.type) {
        case "BACHATA_GENERIC_PROFILE_LIST":
          return { ok: true, value: profiles, fingerprints: await Promise.all(profiles.map(profileIdentity)) };
        case "BACHATA_GENERIC_PROFILE_UPSERT": {
          const index = profiles.findIndex((entry) => entry.routePattern === message.profile.routePattern);
          if (index >= 0) profiles[index] = message.profile;
          else profiles.push(message.profile);
          return { ok: true, fingerprint: await profileIdentity(message.profile) };
        }
        case "BACHATA_GENERIC_PROFILE_CLEAR":
          profiles.length = 0;
          return { ok: true };
        // The authority answers with a boolean. Anything else is "could not answer", and the
        // entry fails closed on it — which is a real path, exercised below.
        case "BACHATA_QUARANTINE_IS":
          return { ok: true, value: quarantined.has(message.conversationIdentity) };
        case "BACHATA_QUARANTINE_SET":
          quarantined.add(message.conversationIdentity);
          return { ok: true };
        case "BACHATA_QUARANTINE_CLEAR":
          quarantined.delete(message.conversationIdentity);
          return { ok: true };
        case "BACHATA_GENERIC_REGISTER":
          return registrationOk ? { ok: true } : { ok: false };
        default:
          return { ok: true };
      }
    },
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
});

await import("../dist/content/generic/index.js");

test.after(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test("the entry installs exactly one message listener and marks the document as bound", () => {
  assert.equal(listeners.length, 1);
  assert.equal(dom.window.__BACHATA_GENERIC_CONTENT_INSTALLED__, true);
});

test("a message that is not the generic protocol is declined without a reply", () => {
  for (const message of [null, "text", [], { type: "provider.status" }, {}, { type: 7 }]) {
    let replied = false;
    const kept = listeners[0](message, {}, () => {
      replied = true;
    });
    assert.equal(kept, false, JSON.stringify(message));
    assert.equal(replied, false, JSON.stringify(message));
  }
});

test("an unknown generic request is refused by name, not ignored", async () => {
  const answer = await new Promise((resolve) => {
    assert.equal(listeners[0]({ type: "BACHATA_GENERIC_NOT_A_REQUEST" }, {}, resolve), true);
  });
  assert.deepEqual(answer, { ok: false, error: "Unknown generic browser request" });
});

test("N1 left no repeating timer behind", () => {
  // The href poll is gone: Chrome's navigation events are the authority, and popstate and
  // hashchange remain as the immediate local signal. A surviving interval would both re-read
  // the route on a clock and keep this process alive.
  assert.deepEqual(intervals, []);
});

// The install-once guard is proved in `genericContentEntryInstall.test.mjs`, in its own
// process. Importing the entry twice here would import it under a second module URL, and V8
// attributes both runs to the same file: the second import skips the guarded body, so the
// coverage this file earns would be reported as the skipped run's.

const ask = (message) =>
  new Promise((resolve) => {
    const kept = listeners[0](message, {}, resolve);
    assert.equal(kept, true, JSON.stringify(message));
  });

test("a status answer describes the document the entry bound to", async () => {
  const answer = await ask({ type: "BACHATA_GENERIC_STATUS" });
  assert.equal(answer.ok, true);
  assert.match(answer.value.documentToken, /^generic-document:/u);
  assert.equal(answer.value.documentRevision, 1);
  assert.equal(typeof answer.value.url, "string");
  // An unbound page is not ready, and says so rather than reporting a usable conversation.
  assert.equal(answer.value.status, "notReady");
  assert.equal(typeof answer.value.capabilities, "object");
});

test("cancelling a request that never started still prevents its submission", async () => {
  const answer = await ask({ type: "BACHATA_GENERIC_CANCEL", requestId: "never-started" });
  assert.deepEqual(answer, {
    ok: true,
    value: { interrupted: true, submissionPrevented: true },
  });
});

test("a reuse confirmation with no attestation behind it is refused", async () => {
  const answer = await ask({ type: "BACHATA_GENERIC_CONFIRM_REUSE" });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /No current generic browser reuse attestation/u);
});

test("auto-healing without a healing authority refuses rather than inventing a binding", async () => {
  // The page carries a composer and a send control, so healing has candidates to reason about
  // and asks the configured local model. Nothing answers it here, and an unanswered heal is a
  // refusal: a binding guessed without the authority that was supposed to choose it is worse
  // than none.
  const answer = await ask({ type: "BACHATA_GENERIC_AUTO_HEAL" });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /selector-healing request failed/u);
});

// A bound page. The profile is what the background would hand back, so the entry resolves the
// same locators it would on a real site.
const recipe = (id, tag) => ({
  tag,
  stableAttributes: { id },
  cssFallback: `#${id}`,
  structuralPath: [],
});

const bindProfile = (overrides = {}) => {
  profiles.length = 0;
  profiles.push({
    protocol: "bachata-generic-binding-v1",
    origin: dom.window.location.origin,
    routePattern: "/*",
    framePath: [],
    composer: recipe("composer", "textarea"),
    conversationRoot: recipe("root", "main"),
    createdBy: "user",
    validated: true,
    consecutiveFailures: 0,
    documentRevision: 1,
    ...overrides,
  });
};

// BR-G6-12. A control binding a person made is not re-judged on shape — they picked it
// deliberately, and it may look like anything. What it may not do is become a *different* known
// control. A Stop recipe that now resolves onto Send used to be trusted as a Stop, so the page
// read as generating while it was idle, and interrupting the turn would have clicked Send and
// submitted whatever was in the composer.
test("a bound Stop that now resolves onto Send is not trusted as a Stop", async () => {
  bindProfile({
    stopButton: recipe("send", "button"),
    bindingSources: { stopButton: "user" },
  });
  const answer = await ask({ type: "BACHATA_GENERIC_STATUS" });
  assert.equal(answer.ok, true);
  assert.notEqual(
    answer.value.status,
    "streaming",
    "an idle page read as generating because its Stop binding resolved onto Send",
  );
});

const sendRequest = (overrides = {}) => ({
  type: "BACHATA_GENERIC_SEND",
  requestId: `request-${String(clockMs)}`,
  prompt: "hello",
  deadlineAt: clockMs + 5_000,
  documentToken: undefined,
  documentRevision: 1,
  conversationUrl: undefined,
  conversationIdentity: undefined,
  ...overrides,
});

const currentIdentity = async () => {
  const status = await ask({ type: "BACHATA_GENERIC_STATUS" });
  return {
    documentToken: status.value.documentToken,
    documentRevision: status.value.documentRevision,
    conversationUrl: status.value.url,
    conversationIdentity: status.value.conversationIdentity ?? `generic:${status.value.url}`,
  };
};

test("a send whose deadline has already passed is refused before the page is touched", async () => {
  bindProfile();
  const answer = await ask(sendRequest({ ...(await currentIdentity()), deadlineAt: clockMs - 1 }));
  assert.equal(answer.ok, false);
  assert.match(answer.error, /deadline has already expired/u);
});

// BR-G6-14. The deadline is checked once, to admit the request. Everything after it is an
// await — the composer has to accept the whole prompt, and the Send control has to become active,
// which polls for up to three seconds. A deadline that expires inside those waits used to be
// discovered only after the click, so a request the controller had already given up on was
// submitted anyway.
test("a send whose deadline expires while the page is being prepared is never clicked", async () => {
  const root = dom.query("#root");
  root.insertAdjacentHTML("beforeend", "<button id=\"late-send\" disabled>Send</button>");
  const late = dom.query("#late-send");
  const clicks = [];
  late.addEventListener("click", () => clicks.push("send"));
  const deadlineAt = clockMs + 100;
  const enableAt = clockMs + 400;
  // The control the page offers only once the deadline has already gone by.
  Object.defineProperty(late, "disabled", { configurable: true, get: () => clockMs < enableAt });
  try {
    bindProfile({ sendButton: recipe("late-send", "button") });
    const answer = await ask(sendRequest({ ...(await currentIdentity()), deadlineAt }));
    assert.equal(answer.ok, false);
    assert.match(answer.error, /deadline expired before submission/u);
    assert.deepEqual(clicks, [], "a request past its deadline was submitted anyway");
  } finally {
    late.remove();
  }
});

test("a send is refused when nothing on the page is bound", async () => {
  profiles.length = 0;
  const answer = await ask(sendRequest({ ...(await currentIdentity()) }));
  assert.equal(answer.ok, false);
  assert.equal(typeof answer.error, "string");
});

test("a send whose composer no longer resolves reports the binding, not a timeout", async () => {
  bindProfile({ composer: recipe("composer-that-is-gone", "textarea") });
  const answer = await ask(sendRequest({ ...(await currentIdentity()) }));
  assert.equal(answer.ok, false);
  assert.match(answer.error, /binding is no longer valid|Unable to resolve/u);
});

test("a send against a document the request does not name is refused", async () => {
  bindProfile();
  const answer = await ask(sendRequest({
    ...(await currentIdentity()),
    documentToken: "generic-document:someone-else",
  }));
  assert.equal(answer.ok, false);
  assert.match(answer.error, /no longer compatible with the active request/u);
});

test("a send whose send control never becomes active ends at its own deadline", async () => {
  // The wait-path failure. The prompt is written, the bound send control never becomes usable,
  // and the entry has to give up on its own deadline rather than on the harness's patience.
  // Before the clock was injectable this ran for the full three-second wait; it now reaches the
  // same deadline in no wall-clock time, which is what makes the case testable at all.
  const send = dom.document.getElementById("send");
  send.setAttribute("disabled", "");
  bindProfile({ sendButton: recipe("send", "button") });
  const before = clockMs;
  try {
    const answer = await ask(sendRequest({ ...(await currentIdentity()) }));
    assert.equal(answer.ok, false);
    assert.match(answer.error, /did not become available after the request was written/u);
  } finally {
    send.removeAttribute("disabled");
  }
  assert.ok(clockMs > before, "the wait reached its deadline without any wall-clock time passing");
});

test("a fresh conversation with no bound control refuses instead of guessing one", async () => {
  bindProfile();
  const answer = await ask({ type: "BACHATA_GENERIC_NEW_CONVERSATION" });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /new-conversation control/u);
});

test("a reuse confirmation whose attestation names another document is refused", async () => {
  bindProfile();
  const answer = await ask({
    type: "BACHATA_GENERIC_CONFIRM_REUSE",
    requestId: "reuse-1",
    documentToken: "generic-document:not-this-one",
    documentRevision: 1,
    conversationUrl: "https://example.invalid/",
    conversationIdentity: "generic:https://example.invalid/",
  });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /No current generic browser reuse attestation|no longer matches/u);
});

test("a validate answer is the verdict itself, not a description of one", async () => {
  bindProfile();
  const answer = await ask({ type: "BACHATA_GENERIC_VALIDATE" });
  assert.equal(answer.ok, true);
  assert.equal(typeof answer.value, "boolean");
});

test("a bound status reports the roles the profile actually carries", async () => {
  bindProfile();
  const answer = await ask({ type: "BACHATA_GENERIC_STATUS" });
  assert.equal(answer.ok, true);
  assert.equal(typeof answer.value.capabilities, "object");
  assert.equal(answer.value.documentRevision, 1);
});

test("a page with nothing readable on it says so instead of returning an empty article", async () => {
  const answer = await ask({ type: "BACHATA_GENERIC_READABLE" });
  assert.equal(answer.ok, false);
  assert.equal(typeof answer.error, "string");
});

test("a selection request with nothing selected answers with nothing, not a refusal", async () => {
  // Nothing is selected, which is an answer rather than a failure: the caller asked what the
  // user had highlighted and the truthful reply is that they had highlighted nothing.
  const answer = await ask({ type: "BACHATA_GENERIC_SELECTED_TEXT" });
  assert.equal(answer.ok, true);
});

test("every request the table answers leaves no request active behind it", async () => {
  const answer = await ask({ type: "BACHATA_GENERIC_CANCEL", requestId: "nothing-running" });
  assert.deepEqual(answer, { ok: true, value: { interrupted: true, submissionPrevented: true } });
});

test("the Generic entry opens one setup panel and delegates validation to the current profile", async () => {
  bindProfile();
  const { panel, shadows } = prepareGenericSetupDom(dom.document);
  assert.deepEqual(await ask({ type: "BACHATA_GENERIC_SETUP" }), { ok: true });
  await waitForSetup(() => panel().querySelectorAll("li").length === 6);
  const firstHost = [...shadows.keys()][0];
  assert.equal(panel().querySelectorAll("li").length, 6);
  const validate = panel().querySelectorAll("button").find((element) => element.textContent === "Validate binding");
  const event = dom.document.createEvent("Event");
  event.initEvent("click", true, true);
  validate.dispatchEvent(event);
  await waitForSetup(() => !validate.disabled);
  assert.match(panel().textContent, /Binding validated/);
  assert.deepEqual(await ask({ type: "BACHATA_GENERIC_SETUP" }), { ok: true });
  assert.equal(firstHost.parentNode, null);
  panel().querySelectorAll("button").find((element) => element.textContent === "Close setup").dispatchEvent(event);
});
