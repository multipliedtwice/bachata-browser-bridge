import { profileIdentity } from "../dist/background/profileIdentity.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";
import { setWaitScheduler } from "../dist/content/generic/transientControl.js";

// BB-A4-N02. A Generic cancellation driven end to end through the production entry, with the
// page's route under the test's control.
//
// A same-document conversation change leaves the document revision, popstate, hashchange and
// every resolved control exactly where they were, and replaces the conversation underneath them.
// The cancellation transaction crosses five awaits — profile resolution, transient-control
// learning, the Stop click, the idle confirmation, and lifecycle recording plus document
// registration — and each one is a place where the Stop control this would click stops being
// this turn's. A regex over the source cannot show that; each case below moves the page at one
// of those points and asserts the same four things: no foreign Stop click, no confirmed
// interruption, the conversation left quarantined, and no request left occupying the document.

const dom = createGenericDom(
  "<main id=\"root\"><textarea id=\"composer\"></textarea><button id=\"send\">Send</button><button id=\"stop\">Stop</button></main>",
);

const ORIGIN = "https://generic-cancellation.invalid";
const ROUTE_A = `${ORIGIN}/chat/a`;
const ROUTE_B = `${ORIGIN}/chat/b`;

const saved = new Map();
const define = (name, value) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

// The route the entry reads. A same-document change is exactly this: a new href, the same
// document, the same revision, the same nodes.
const route = { href: ROUTE_A, origin: ORIGIN };
define("location", route);

const listeners = [];
define("setInterval", () => 1);
define("clearInterval", () => undefined);
const realSetTimeout = globalThis.setTimeout;
define("setTimeout", (callback, delayMs, ...args) => {
  const handle = realSetTimeout(callback, delayMs, ...args);
  if (Number(delayMs) >= 1_000) handle.unref?.();
  return handle;
});

let clockMs = 3_000_000;
setWaitScheduler({
  now: () => clockMs,
  delay: (ms) => {
    clockMs += Math.max(1, ms);
    return Promise.resolve();
  },
});

const profiles = [];
const quarantined = new Set();
const sent = [];
let onBackgroundMessage = () => undefined;

define("chrome", {
  runtime: {
    id: "bachata-bridge-test",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: async (message) => {
      sent.push(message);
      onBackgroundMessage(message);
      switch (message?.type) {
        case "BACHATA_GENERIC_PROFILE_LIST":
          return { ok: true, value: profiles, fingerprints: await Promise.all(profiles.map(profileIdentity)) };
        case "BACHATA_GENERIC_PROFILE_UPSERT": {
          const index = profiles.findIndex((entry) => entry.routePattern === message.profile.routePattern);
          if (index >= 0) profiles[index] = message.profile;
          else profiles.push(message.profile);
          return { ok: true, fingerprint: await profileIdentity(message.profile) };
        }
        case "BACHATA_QUARANTINE_IS":
          return { ok: true, value: quarantined.has(message.conversationIdentity) };
        case "BACHATA_QUARANTINE_SET":
          quarantined.add(message.conversationIdentity);
          return { ok: true };
        case "BACHATA_QUARANTINE_CLEAR":
          quarantined.delete(message.conversationIdentity);
          return { ok: true };
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
  dom.restore();
});

const ask = (message) =>
  new Promise((resolve) => {
    listeners[0](message, { id: "bachata-bridge-test" }, resolve);
  });

const recipe = (id, tag) => ({
  tag,
  stableAttributes: { id },
  cssFallback: `#${id}`,
  structuralPath: [],
});

const bindProfile = () => {
  profiles.length = 0;
  profiles.push({
    protocol: "bachata-generic-binding-v1",
    origin: ORIGIN,
    routePattern: "/*",
    framePath: [],
    composer: recipe("composer", "textarea"),
    conversationRoot: recipe("root", "main"),
    sendButton: recipe("send", "button"),
    stopButton: recipe("stop", "button"),
    bindingSources: { sendButton: "user", stopButton: "user" },
    createdBy: "user",
    validated: true,
    consecutiveFailures: 0,
    documentRevision: 1,
  });
};

const ANSWER = "an answer nobody asked for";

/**
 * A page that generates until it is told to stop. The Stop control is live for as long as the
 * page is generating, and every read of it is reported, because a read is the only moment inside
 * control resolution and idle confirmation a test can act on.
 */
const wirePage = () => {
  const root = dom.query("#root");
  root.innerHTML = "<textarea id=\"composer\"></textarea><button id=\"send\">Send</button><button id=\"stop\">Stop</button>";
  const composer = dom.query("#composer");
  const sendButton = dom.query("#send");
  const stop = dom.query("#stop");
  const page = { generating: false, stopClicks: 0, stopReads: 0, onStopRead: () => undefined, submitted: undefined };
  Object.defineProperty(stop, "disabled", {
    configurable: true,
    get() {
      page.stopReads += 1;
      page.onStopRead(page.stopReads);
      return !page.generating;
    },
  });
  stop.addEventListener("click", () => {
    page.stopClicks += 1;
    // A real Stop ends the generation it belongs to.
    page.generating = false;
  });
  sendButton.addEventListener("click", () => {
    page.submitted = composer.value;
    composer.value = "";
    page.generating = true;
    root.insertAdjacentHTML(
      "beforeend",
      `<article data-message-author-role="user">${page.submitted}</article>`,
    );
  });
  page.answer = () => {
    page.generating = false;
    root.insertAdjacentHTML(
      "beforeend",
      `<article data-message-author-role="assistant"><p>${ANSWER}</p></article>`,
    );
  };
  return page;
};

const nextTurn = () => new Promise((resolve) => realSetTimeout(resolve, 5));

const startSend = async () => {
  const status = await ask({ type: "BACHATA_GENERIC_STATUS" });
  const requestId = `request-${String(clockMs)}-${String(sent.length)}`;
  const pending = ask({
    type: "BACHATA_GENERIC_SEND",
    requestId,
    prompt: "hello",
    deadlineAt: Date.now() + 60_000,
    documentToken: status.value.documentToken,
    documentRevision: status.value.documentRevision,
    conversationUrl: status.value.url,
    conversationIdentity: status.value.conversationIdentity ?? `generic:${status.value.url}`,
  });
  return { requestId, pending };
};

const waitFor = async (condition, what) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await nextTurn();
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * Submit a turn, move the page at one named point of the cancellation, and report what the
 * cancellation answered and what it did to the page.
 */
const runCancellationRace = async (moveAt, action = "BACHATA_GENERIC_CANCEL") => {
  route.href = ROUTE_A;
  quarantined.clear();
  sent.length = 0;
  const page = wirePage();
  bindProfile();
  const { requestId, pending } = await startSend();
  await waitFor(() => sent.some((message) => message.type === "BACHATA_GENERIC_SUBMITTED"), "submission");

  let armed = false;
  let moved = false;
  const move = () => {
    if (!armed || moved) return;
    moved = true;
    route.href = ROUTE_B;
  };
  if (moveAt === "stopControlResolution") {
    // Reading the Stop control is what transient-control learning does; the page becomes another
    // conversation while it is being read.
    page.onStopRead = () => move();
  }
  if (moveAt === "idleConfirmation") {
    page.onStopRead = () => {
      if (page.stopClicks > 0) move();
    };
  }
  onBackgroundMessage = (message) => {
    if (moveAt === "profileResolution" && message?.type === "BACHATA_GENERIC_PROFILE_LIST") move();
    if (moveAt === "beforeStop"
      && message?.type === "BACHATA_GENERIC_PROFILE_UPSERT"
      && page.stopClicks === 0) move();
    if (moveAt === "lifecycleRecord"
      && message?.type === "BACHATA_GENERIC_PROFILE_UPSERT"
      && page.stopClicks > 0) move();
    if (moveAt === "documentRegistration" && message?.type === "BACHATA_GENERIC_REGISTER") move();
  };
  armed = true;

  const cancelled = await ask({
    type: action,
    requestId,
    documentToken: undefined,
  });
  onBackgroundMessage = () => undefined;
  page.onStopRead = () => undefined;

  // The turn was never interrupted, so it is still running. Let it finish so the request releases
  // the document, which is the other half of what a refused cancellation must not break.
  route.href = ROUTE_A;
  page.answer();
  const answer = await pending;
  const afterStatus = await ask({ type: "BACHATA_GENERIC_STATUS" });
  return { page, cancelled, answer, moved, afterStatus, requestId };
};

const MOVE_POINTS = [
  ["profileResolution", 0],
  ["stopControlResolution", 0],
  ["beforeStop", 0],
  ["idleConfirmation", 1],
  ["lifecycleRecord", 1],
  ["documentRegistration", 1],
];

for (const [moveAt, expectedStopClicks] of MOVE_POINTS.filter(([point]) => point !== "documentRegistration")) {
  test(`manual selected-response recovery refuses a conversation change during ${moveAt}`, async () => {
    define("getSelection", () => ({ toString: () => "Selected answer", anchorNode: null, focusNode: null }));
    const result = await runCancellationRace(moveAt, "BACHATA_GENERIC_SELECTED_TEXT");
    assert.equal(result.moved, true);
    assert.equal(result.cancelled.ok, false);
    assert.match(result.cancelled.error, /conversation|document|nonce|interruption/i);
    assert.equal(result.page.stopClicks, expectedStopClicks);
    assert.equal(quarantined.has(`generic:${ROUTE_A}`), true);
  });
}

for (const [moveAt, expectedStopClicks] of MOVE_POINTS) {
  test(`a same-document conversation change during ${moveAt} refuses the interruption`, async () => {
    const run = await runCancellationRace(moveAt);
    assert.equal(run.moved, true, "the page never moved, so nothing was proved");
    // No confirmed interruption.
    assert.equal(run.cancelled.ok, false, `the interruption was confirmed at ${moveAt}`);
    assert.match(
      run.cancelled.error,
      /moved to another conversation|nonce is no longer present|no longer resolvable|document changed after submission|did not confirm that generation stopped/u,
      `${moveAt} refused for a reason that is not the conversation moving`,
    );
    assert.equal(run.cancelled.value, undefined);
    // No foreign Stop click: before the page moves the control is this turn's and may be
    // clicked; after it, nothing on the new conversation is ever activated.
    assert.equal(
      run.page.stopClicks,
      expectedStopClicks,
      `${moveAt} clicked a Stop control that was not this turn's`,
    );
    // The quarantine the submission took out is still standing.
    assert.equal(
      quarantined.has(`generic:${ROUTE_A}`),
      true,
      `${moveAt} left the conversation unquarantined after refusing`,
    );
    // The conversation the page moved to is quarantined as well, and that is deliberate: an
    // in-flight turn touched it, and nothing here can prove what state it was left in.
    assert.equal(quarantined.has(`generic:${ROUTE_B}`), true);
    // No leaked occupied request: the turn it refused to interrupt still finishes and still
    // releases the document.
    assert.equal(run.answer.ok, true, `the refused turn never settled at ${moveAt}`);
    assert.notEqual(run.afterStatus.value.status, "streaming");
  });
}

test("a cancellation whose page never moves interrupts the turn and confirms it once", async () => {
  route.href = ROUTE_A;
  quarantined.clear();
  sent.length = 0;
  const page = wirePage();
  bindProfile();
  const { requestId, pending } = await startSend();
  await waitFor(() => sent.some((message) => message.type === "BACHATA_GENERIC_SUBMITTED"), "submission");
  const cancelled = await ask({ type: "BACHATA_GENERIC_CANCEL", requestId, documentToken: undefined });
  assert.equal(cancelled.ok, true, `a clean interruption was refused: ${String(cancelled.error)}`);
  assert.equal(cancelled.value.interrupted, true);
  assert.equal(cancelled.value.stopConfirmed, true);
  assert.equal(cancelled.value.conversationUrl, ROUTE_A);
  assert.equal(page.stopClicks, 1, "a confirmed interruption clicked its Stop control more than once");
  const answer = await pending;
  assert.equal(answer.ok, false, "an interrupted turn returned an answer");
  const afterStatus = await ask({ type: "BACHATA_GENERIC_STATUS" });
  assert.notEqual(afterStatus.value.status, "streaming");
});
