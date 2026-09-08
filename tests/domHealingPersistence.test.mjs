import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { createGenericDom } from "./support/genericDom.mjs";

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const page = `
  <main id="thread" role="main">
    <article data-message-author-role="assistant">answer</article>
  </main>
  <form id="composer-form">
    <textarea id="prompt" placeholder="Ask anything"></textarea>
    <button id="send" aria-label="Send message">Send</button>
  </form>
`;

const dom = createGenericDom(page);

// Layout is stated, not measured: the healer scores by rectangle and refuses anything with
// no area at all.
const layOut = () => {
  dom.resize(dom.query("#thread"), { x: 0, y: 0, width: 800, height: 600 });
  dom.resize(dom.query("#prompt"), { x: 0, y: 700, width: 700, height: 60 });
  dom.resize(dom.query("#send"), { x: 720, y: 700, width: 60, height: 40 });
  dom.resize(dom.query("article"), { x: 0, y: 0, width: 800, height: 120 });
};

const createSessionStorage = (faults = {}) => {
  const entries = new Map();
  return {
    entries,
    api: {
      getItem: (key) => {
        if (faults.getItem) throw new Error("storage read refused");
        return entries.has(key) ? entries.get(key) : null;
      },
      setItem: (key, value) => {
        if (faults.setItem) throw new Error("storage write refused");
        entries.set(key, String(value));
      },
      removeItem: (key) => {
        if (faults.removeItem) throw new Error("storage removal refused");
        entries.delete(key);
      },
    },
  };
};

const decision = {
  protocol: "bachata-dom-heal-v1",
  status: "selected",
};

const loadHealing = async (faults = {}) => {
  dom.document.body.innerHTML = page;
  layOut();
  const storage = createSessionStorage(faults);
  setGlobal("sessionStorage", storage.api);
  setGlobal("location", { origin: "https://chatgpt.com", pathname: "/c/heal" });
  setGlobal("performance", { timeOrigin: 1, now: () => 1 });
  setGlobal("crypto", { randomUUID });
  setGlobal("innerHeight", 900);
  // The harness supplies the element constructors the generic content modules need; the
  // healer also classifies buttons by constructor.
  setGlobal("HTMLButtonElement", dom.query("#send").constructor);
  setGlobal("addEventListener", () => undefined);
  setGlobal("removeEventListener", () => undefined);
  const prompts = [];
  setGlobal("chrome", {
    runtime: {
      sendMessage: async (message) => {
        if (message.type !== "BACHATA_LOCAL_MODEL_PROMPT") return { ok: true };
        prompts.push(message);
        const candidates = JSON.parse(message.prompt).candidates;
        const idOf = (kind) => candidates.find((entry) => entry.kindHint === kind)?.id;
        return {
          ok: true,
          text: JSON.stringify({
            ...decision,
            composerIds: [idOf("composer")].filter(Boolean),
            conversationRootIds: [idOf("conversationRoot")].filter(Boolean),
            sendButtonIds: [idOf("sendButton")].filter(Boolean),
            stopButtonIds: [idOf("stopButton")].filter(Boolean),
          }),
        };
      },
    },
  });
  delete globalThis.__pairDomHealing;
  await import(`../dist/content/domHealing.js?${randomUUID()}`);
  return { healing: globalThis.__pairDomHealing, storage, prompts };
};

const persistedKey = "bachata.domHealing.chatgpt.v1";

test("a healed selection is cached and written through to session storage", async () => {
  const { healing, storage } = await loadHealing();
  assert.equal(await healing.heal("chatgpt"), true);
  assert.equal(healing.cached("chatgpt")?.composer.id, "prompt");
  assert.equal(healing.cached("chatgpt")?.conversationRoot.id, "thread");
  assert.equal(storage.entries.has(persistedKey), true);
});

// BB-AUD-10. The persisted copy saves one healing pass after a reload. Storage that refuses
// to write costs that pass and nothing else.
test("storage that refuses to write does not fail the heal it was caching", async () => {
  const { healing, storage } = await loadHealing({ setItem: true });
  assert.equal(await healing.heal("chatgpt"), true);
  assert.equal(healing.cached("chatgpt")?.composer.id, "prompt");
  assert.equal(storage.entries.size, 0);
});

test("a persisted selection is restored without healing again", async () => {
  const first = await loadHealing();
  assert.equal(await first.healing.heal("chatgpt"), true);
  const persisted = first.storage.entries.get(persistedKey);

  const second = await loadHealing();
  second.storage.entries.set(persistedKey, persisted);
  assert.equal(second.healing.cached("chatgpt")?.composer.id, "prompt");
  assert.deepEqual(second.prompts, [], "a restorable selection still asked the model");
});

test("storage that refuses to read restores nothing rather than failing", async () => {
  const { healing } = await loadHealing({ getItem: true });
  assert.equal(healing.cached("chatgpt"), undefined);
});

// BB-AUD-10. Invalidation drops the live selection first. A removal that refuses can leave a
// stale persisted copy, which restoration cannot turn into a wrong control.
test("invalidation clears the live selection even when the removal refuses", async () => {
  const { healing, storage } = await loadHealing({ removeItem: true });
  assert.equal(await healing.heal("chatgpt"), true);
  assert.doesNotThrow(() => healing.invalidate("chatgpt"));
  assert.equal(storage.entries.has(persistedKey), true, "the stale copy was expected to survive");

  // The stale copy names controls that are gone, so restoration refuses it.
  dom.document.body.innerHTML = `<main id="thread" role="main"></main>`;
  dom.resize(dom.query("#thread"), { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(healing.cached("chatgpt"), undefined);
});

test("a stale persisted selector that now names another kind of control restores nothing", async () => {
  const { healing, storage } = await loadHealing();
  storage.entries.set(
    persistedKey,
    JSON.stringify({ composer: "#thread", conversationRoot: "#thread" }),
  );
  assert.equal(
    healing.cached("chatgpt"),
    undefined,
    "a selector resolving to the wrong kind of element was restored",
  );
});

test("invalidation removes the persisted copy when storage accepts it", async () => {
  const { healing, storage } = await loadHealing();
  assert.equal(await healing.heal("chatgpt"), true);
  healing.invalidate("chatgpt");
  assert.equal(storage.entries.has(persistedKey), false);
});

test.after(() => dom.restore());

// BB-A4-F12. Both providers show one composer button whose accessible name toggles between Stop
// and Send on the same node. A cached control was only ever re-checked for connection, so a node
// bound as Stop while a turn generated stayed on offer as Stop once it read "Send" again — and
// the interrupt path clicks whatever `stopButton()` hands it.
const addStopControl = (label = "Stop generating") => {
  const button = dom.document.createElement("button");
  button.id = "stop";
  button.setAttribute("aria-label", label);
  button.textContent = label;
  dom.query("#composer-form").appendChild(button);
  dom.resize(button, { x: 640, y: 700, width: 60, height: 40 });
  return button;
};

test("a cached Stop control that becomes a Send control is no longer offered as Stop", async () => {
  const { healing } = await loadHealing();
  const stop = addStopControl();
  assert.equal(await healing.heal("chatgpt"), true);
  assert.equal(healing.cached("chatgpt")?.stopButton?.id, "stop");

  stop.setAttribute("aria-label", "Send message");
  stop.textContent = "Send";
  const after = healing.cached("chatgpt");
  assert.equal(after?.stopButton, undefined, "a control that now reads Send was still offered as Stop");
  assert.equal(after?.composer.id, "prompt", "the whole binding was discarded over one button");
  assert.equal(after?.conversationRoot.id, "thread");
});

test("a cached Send control that becomes a Stop control is no longer offered as Send", async () => {
  const { healing } = await loadHealing();
  assert.equal(await healing.heal("chatgpt"), true);
  assert.equal(healing.cached("chatgpt")?.sendButton?.id, "send");

  const send = dom.query("#send");
  send.setAttribute("aria-label", "Stop generating");
  send.textContent = "Stop";
  assert.equal(
    healing.cached("chatgpt")?.sendButton,
    undefined,
    "a control that now reads Stop was still offered as Send, so a submit would click it",
  );
});

test("a control whose role returns is offered again without healing a second time", async () => {
  const { healing, prompts } = await loadHealing();
  assert.equal(await healing.heal("chatgpt"), true);
  const healCount = prompts.length;
  const send = dom.query("#send");
  send.setAttribute("aria-label", "Stop generating");
  send.textContent = "Stop";
  assert.equal(healing.cached("chatgpt")?.sendButton, undefined);

  // The same node reads as Send again on the next idle turn. Hiding it was a filter, not a
  // withdrawal, so nothing has to be rediscovered.
  send.setAttribute("aria-label", "Send message");
  send.textContent = "Send";
  assert.equal(healing.cached("chatgpt")?.sendButton?.id, "send");
  assert.equal(prompts.length, healCount, "a recovered role cost another healing pass");
});
