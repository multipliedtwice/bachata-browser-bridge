import { profileIdentity } from "../dist/background/profileIdentity.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";
import { setWaitScheduler } from "../dist/content/generic/transientControl.js";

// BB-A4-N03. A Generic turn driven end to end through the production entry, with the page's
// route under the test's control.
//
// The conversation an answer belongs to used to be read after the capture had already returned,
// so a page that moved in between named the conversation it had moved to: the answer produced in
// A was registered as B and minted B a reuse confirmation. The answer now carries the page it was
// accepted in, and finalization revalidates that record after every await instead of re-reading
// the page. Both halves are driven here — a clean turn that must still be attributed to A, and a
// turn whose page navigates while the final identity is being registered.

const dom = createGenericDom(
  "<main id=\"root\"><textarea id=\"composer\"></textarea><button id=\"send\">Send</button><button id=\"stop\">Stop</button></main>",
);

const ORIGIN = "https://generic-finalization.invalid";
const ROUTE_A = `${ORIGIN}/chat/a`;
const ROUTE_B = `${ORIGIN}/chat/b`;

const saved = new Map();
const define = (name, value) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

// The route the entry reads. Nothing in the entry writes it, so a plain object with the two
// members it uses is the whole surface, and the test moves the page by assigning to it.
const route = { href: ROUTE_A, origin: ORIGIN };
define("location", route);

const listeners = [];
define("setInterval", () => 1);
define("clearInterval", () => undefined);
const realSetTimeout = globalThis.setTimeout;
// A cancellation schedules a 30 s bound that would outlive the suite. The capture's own polls
// are short and must keep the loop alive, or a turn in flight is abandoned rather than finished.
define("setTimeout", (callback, delayMs, ...args) => {
  const handle = realSetTimeout(callback, delayMs, ...args);
  if (Number(delayMs) >= 1_000) handle.unref?.();
  return handle;
});

// The clock the entry's bounded waits read. The response capture keeps its own wall clock, so
// this only removes the waits that would otherwise idle for seconds before the page answers.
let clockMs = 2_000_000;
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
// Called with each outgoing background message, so a test can move the page in the middle of one
// of finalization's own awaits.
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

const ANSWER = "the answer that belongs to conversation A";

/**
 * A page that behaves: the Send control commits the prompt as a user turn, the Stop control is
 * live while the answer streams, and the answer settles once the Stop control goes away.
 */
const wirePage = (onAnswer = () => undefined) => {
  const root = dom.query("#root");
  root.innerHTML = "<textarea id=\"composer\"></textarea><button id=\"send\">Send</button><button id=\"stop\">Stop</button>";
  const composer = dom.query("#composer");
  const send = dom.query("#send");
  const stop = dom.query("#stop");
  let generating = false;
  Object.defineProperty(stop, "disabled", { configurable: true, get: () => !generating });
  send.addEventListener("click", () => {
    const submitted = composer.value;
    composer.value = "";
    generating = true;
    root.insertAdjacentHTML(
      "beforeend",
      `<article data-message-author-role="user">${submitted}</article>`,
    );
    realSetTimeout(() => {
      root.insertAdjacentHTML(
        "beforeend",
        `<article data-message-author-role="assistant"><p>${ANSWER}</p></article>`,
      );
      generating = false;
      onAnswer();
    }, 20);
  });
  return { composer, send, stop };
};

const send = async () => {
  const status = await ask({ type: "BACHATA_GENERIC_STATUS" });
  return await ask({
    type: "BACHATA_GENERIC_SEND",
    requestId: `request-${String(clockMs)}`,
    prompt: "hello",
    deadlineAt: Date.now() + 60_000,
    documentToken: status.value.documentToken,
    documentRevision: status.value.documentRevision,
    conversationUrl: status.value.url,
    conversationIdentity: status.value.conversationIdentity ?? `generic:${status.value.url}`,
  });
};

test("a Generic turn that never moves is attributed to the conversation it ran in", async () => {
  route.href = ROUTE_A;
  quarantined.clear();
  onBackgroundMessage = () => undefined;
  wirePage();
  bindProfile();
  const answer = await send();
  assert.equal(answer.ok, true, `a clean turn failed: ${String(answer.error)}`);
  assert.equal(answer.value.text.includes(ANSWER), true);
  assert.equal(answer.value.conversationUrl, ROUTE_A);
  assert.equal(answer.value.conversationIdentity, `generic:${ROUTE_A}`);
  assert.equal(answer.value.providerIdleConfirmed, true);
  assert.equal(answer.value.completionSource, "verifiedLifecycle");
  // A Generic conversation is quarantined the moment a turn is submitted and stays so until the
  // controller confirms reuse, so the turn completing is not what lifts it.
  assert.equal(quarantined.has(`generic:${ROUTE_A}`), true);
  assert.equal(
    quarantined.has(`generic:${ROUTE_B}`),
    false,
    "a turn that never left conversation A quarantined B as well",
  );
});

test("a page that navigates while the answer is being registered refuses to relabel it", async () => {
  route.href = ROUTE_A;
  quarantined.clear();
  let armed = false;
  let moved = false;
  wirePage(() => { armed = true; });
  bindProfile();
  // The page moves inside finalization's own await: the registration round trip. Everything the
  // finalizer could read about the page afterwards says B, and the answer was produced in A.
  onBackgroundMessage = (message) => {
    if (armed && message?.type === "BACHATA_GENERIC_REGISTER" && !moved) {
      moved = true;
      route.href = ROUTE_B;
    }
  };
  try {
    const answer = await send();
    assert.equal(answer.ok, false, "an answer captured in A was returned after the page moved to B");
    assert.match(answer.error, /changed conversation while this answer was being finalized/u);
    assert.equal(moved, true, "the page never moved, so nothing was proved");
    // Neither conversation may be trusted afterwards: the one the answer was produced in and the
    // one the page moved to are both left quarantined rather than one of them being stamped on it.
    assert.equal(quarantined.has(`generic:${ROUTE_A}`), true);
    assert.equal(quarantined.has(`generic:${ROUTE_B}`), true);
  } finally {
    onBackgroundMessage = () => undefined;
    route.href = ROUTE_A;
  }
});

test("a page that navigates before the answer is even offered never names the new conversation", async () => {
  route.href = ROUTE_A;
  quarantined.clear();
  let armed = false;
  let moved = false;
  wirePage(() => { armed = true; });
  bindProfile();
  // Lifecycle persistence is the first thing finalization awaits, and it happens after the answer
  // was accepted. A page that moves here has already made the answer unattributable.
  onBackgroundMessage = (message) => {
    if (armed && message?.type === "BACHATA_GENERIC_PROFILE_UPSERT" && !moved) {
      moved = true;
      route.href = ROUTE_B;
    }
  };
  try {
    const answer = await send();
    assert.equal(answer.ok, false);
    assert.match(answer.error, /changed conversation while this answer was being finalized/u);
    assert.equal(moved, true, "the page never moved, so nothing was proved");
    // Both conversations are quarantined and neither is given the answer. The document may still
    // register itself at its new route — that is document bookkeeping, not attribution — but no
    // answer and no reuse confirmation travels with it.
    assert.equal(quarantined.has(`generic:${ROUTE_A}`), true);
    assert.equal(quarantined.has(`generic:${ROUTE_B}`), true);
    assert.equal(
      sent.filter((message) => message.type === "BACHATA_LOCAL_MODEL_PROMPT").length,
      0,
      "an unattributable answer was retried through binding repair",
    );
  } finally {
    onBackgroundMessage = () => undefined;
    route.href = ROUTE_A;
  }
});

// BB-A4-N03, scope recorded rather than assumed. A route change *during* the capture is a
// different question from the one this finding is about, and it is answered elsewhere: once a
// turn is submitted the document match is deliberately origin-only, because a provider may assign
// the submitted turn a new conversation URL, and the nonce anchor is what proves the answer is
// this request's. Driven here so the boundary is a fact rather than an assumption: the answer is
// named by the conversation the page was in when the capture accepted it, and every conversation
// the turn touched is left quarantined.
test("a route change during the capture is answered by the nonce anchor, not by the finalizer", async () => {
  route.href = ROUTE_A;
  quarantined.clear();
  let armed = false;
  let moved = false;
  wirePage(() => { armed = true; });
  bindProfile();
  onBackgroundMessage = (message) => {
    if (!armed || moved || message?.type !== "BACHATA_GENERIC_STREAM") return;
    moved = true;
    route.href = ROUTE_B;
  };
  try {
    const answer = await send();
    assert.equal(moved, true, "the page never moved, so nothing was proved");
    // The submitted turn is still on the page, carrying this request's nonce, so the answer is
    // this request's answer. What changed is the conversation it now lives in.
    assert.equal(answer.ok, true, `a submitted turn's own answer was refused: ${String(answer.error)}`);
    assert.equal(answer.value.text.includes(ANSWER), true);
    assert.equal(answer.value.conversationUrl, ROUTE_B);
    // Attribution the finalizer could not prove is never invented, and the conversation the turn
    // was authorized in stays quarantined.
    assert.equal(quarantined.has(`generic:${ROUTE_A}`), true);
  } finally {
    onBackgroundMessage = () => undefined;
    route.href = ROUTE_A;
  }
});
