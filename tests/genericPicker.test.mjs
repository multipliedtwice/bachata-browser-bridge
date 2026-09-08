import { profileIdentity } from "../dist/background/profileIdentity.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createGenericDom } from "./support/genericDom.mjs";

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const storage = new Map();
const upserts = [];

setGlobal("location", { origin: "https://llm.test", pathname: "/chat", search: "", hash: "" });
setGlobal("chrome", {
  runtime: {
    sendMessage: async (message) => {
      if (message.type === "BACHATA_GENERIC_PROFILE_LIST") return { ok: true, value: [], fingerprints: [] };
      if (message.type === "BACHATA_GENERIC_PROFILE_UPSERT") {
        upserts.push(message.profile);
        return { ok: true, fingerprint: await profileIdentity(message.profile) };
      }
      return { ok: false, error: "unsupported" };
    },
  },
  storage: {
    local: {
      get: async (key) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: async (values) => {
        Object.entries(values).forEach(([name, value]) => storage.set(name, value));
      },
      remove: async (key) => {
        for (const entry of Array.isArray(key) ? key : [key]) storage.delete(entry);
      },
    },
  },
});

const dom = createGenericDom("<main><button id=\"send\">Send</button></main>");
const { pickBindingElement } = await import("../dist/content/generic/picker.js");
const { loadBindingDraft } = await import("../dist/content/generic/bindingProfile.js");

const pickerLifetimeMs = 2 * 60_000;

const reset = () => {
  storage.clear();
  upserts.length = 0;
  dom.document.body.innerHTML = "<main><button id=\"send\">Send</button></main>";
  dom.document.documentElement.style.cursor = "auto";
};

const dispatch = (type, target, init = {}) => {
  const event = dom.document.createEvent("Event");
  event.initEvent(type, true, true);
  Object.defineProperty(event, "target", { configurable: true, value: target });
  Object.assign(event, init);
  target.dispatchEvent(event);
  return event;
};

// BB-10. A picker used to resolve only on click or Escape, so one the user walked away from
// held the crosshair and a capture-phase click handler for the life of the realm, and a much
// later click still wrote a binding.

test("a click binds the element the user picked", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 3);
  const button = dom.query("#send");
  dispatch("mousemove", button);
  assert.equal(button.getAttribute("data-bachata-binding-target"), "sendButton");
  dispatch("click", button);
  assert.equal(await pick, true);
  const draft = await loadBindingDraft();
  assert.equal(draft?.sendButton?.tag, "button");
  assert.equal(draft?.documentRevision, 3);
  assert.equal(button.getAttribute("data-bachata-binding-target"), null);
  assert.equal(dom.document.documentElement.style.cursor, "auto");
});

test("Escape ends the picker without binding anything", async () => {
  reset();
  const pick = pickBindingElement("composer", 1);
  dispatch("keydown", dom.query("#send"), { key: "Escape" });
  assert.equal(await pick, false);
  assert.equal(await loadBindingDraft(), undefined);
  assert.equal(dom.document.documentElement.style.cursor, "auto");
});

test("closing setup aborts its picker and a later click cannot save a binding", async () => {
  reset();
  const controller = new AbortController();
  const pick = pickBindingElement("composer", 1, controller.signal);
  controller.abort();
  assert.equal(await pick, false);
  dispatch("click", dom.query("#send"));
  assert.equal(await loadBindingDraft(), undefined);
  assert.equal(dom.document.documentElement.style.cursor, "auto");
  assert.equal(await pickBindingElement("composer", 1, controller.signal), false);
});

test("a key other than Escape leaves the picker waiting", async () => {
  reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pick = pickBindingElement("composer", 1);
    dispatch("keydown", dom.query("#send"), { key: "Enter" });
    assert.equal(dom.document.documentElement.style.cursor, "crosshair");
    mock.timers.tick(pickerLifetimeMs);
    assert.equal(await pick, false);
  } finally {
    mock.timers.reset();
  }
});

test("the picker expires on its own and binds nothing", async () => {
  reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pick = pickBindingElement("sendButton", 1);
    mock.timers.tick(pickerLifetimeMs);
    assert.equal(await pick, false);
    assert.equal(dom.document.documentElement.style.cursor, "auto");
  } finally {
    mock.timers.reset();
  }
  assert.equal(await loadBindingDraft(), undefined);
});

test("a click that lands after the deadline writes no binding", async () => {
  reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pick = pickBindingElement("sendButton", 1);
    mock.timers.tick(pickerLifetimeMs);
    assert.equal(await pick, false);
    dispatch("click", dom.query("#send"));
  } finally {
    mock.timers.reset();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(upserts, []);
  assert.equal(await loadBindingDraft(), undefined);
});

test("a click on nothing an element owns resolves without binding", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 1);
  const event = dom.document.createEvent("Event");
  event.initEvent("click", true, true);
  Object.defineProperty(event, "target", { configurable: true, value: dom.document });
  dom.document.dispatchEvent(event);
  assert.equal(await pick, false);
  assert.equal(await loadBindingDraft(), undefined);
});

test("the picker highlights the hovered target and removes its overlay on cancellation", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 3);
  const button = dom.query("#send");
  dispatch("mousemove", button);
  const outline = dom.query("[data-bachata-picker-outline]");
  assert.equal(outline.style.display, "block");
  assert.equal(outline.style.width, "120px");
  assert.equal(outline.style.height, "24px");
  assert.match(dom.query("[data-bachata-picker-help]").textContent, /Selected button: send/);
  dom.resize(button, { x: 20, y: 40, width: 150, height: 30 });
  dispatch("scroll", dom.document);
  assert.equal(outline.style.left, "20px");
  assert.equal(outline.style.top, "40px");
  assert.equal(outline.style.width, "150px");
  dom.resize(button, { x: 30, y: 50, width: 100, height: 30 });
  dispatch("resize", dom.window);
  assert.equal(outline.style.left, "30px");
  dispatch("keydown", button, { key: "Escape" });
  assert.equal(await pick, false);
  assert.equal(dom.queryAll("[data-bachata-picker-outline], [data-bachata-picker-help]").length, 0);
});

test("keyboard selection binds a nonfocusable parent without activating the page control", async () => {
  reset();
  let activated = false;
  const button = dom.query("#send");
  button.addEventListener("click", () => { activated = true; });
  const pick = pickBindingElement("conversationRoot", 3);
  dispatch("mousemove", button);
  dispatch("keydown", button, { key: "ArrowLeft" });
  assert.equal(dom.query("main").getAttribute("data-bachata-binding-target"), "conversationRoot");
  const enter = dispatch("keydown", button, { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(await pick, true);
  assert.equal(activated, false);
  assert.equal((await loadBindingDraft()).conversationRoot.tag, "main");
  assert.equal(dom.queryAll("[data-bachata-picker-outline], [data-bachata-picker-help]").length, 0);
});

test("keyboard suggestions cycle and child navigation selects an exact element", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 3);
  const button = dom.query("#send");
  dispatch("keydown", button, { key: "ArrowDown" });
  const first = dom.query("[data-bachata-binding-target]");
  assert.ok(first);
  dispatch("keydown", button, { key: "ArrowDown" });
  assert.notEqual(dom.query("[data-bachata-binding-target]"), first);
  dispatch("keydown", button, { key: "ArrowUp" });
  assert.equal(dom.query("[data-bachata-binding-target]"), first);
  dispatch("mousemove", dom.query("main"));
  dispatch("keydown", button, { key: "ArrowRight" });
  assert.equal(button.getAttribute("data-bachata-binding-target"), "sendButton");
  dispatch("keydown", button, { key: "Enter" });
  assert.equal(await pick, true);
  assert.equal((await loadBindingDraft()).sendButton.tag, "button");
});

test("Enter before choosing cannot submit a prompt and a detached target cannot be saved", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 3);
  const button = dom.query("#send");
  assert.equal(dispatch("keydown", button, { key: "Enter" }).defaultPrevented, true);
  dispatch("mousemove", button);
  button.remove();
  dispatch("keydown", dom.document.documentElement, { key: "Enter" });
  assert.equal(await pick, false);
  assert.equal(await loadBindingDraft(), undefined);
});

test("leaving an element clears its highlight and shortcuts do not commit a selection", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 3);
  const button = dom.query("#send");
  button.setAttribute("aria-label", "Send message");
  dispatch("mousemove", button);
  assert.match(dom.query("[data-bachata-picker-help]").textContent, /Send message/);
  for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
    assert.equal(dispatch("keydown", button, { key: "Enter", [modifier]: true }).defaultPrevented, false);
  }
  assert.equal(dispatch("keydown", button, { key: "a" }).defaultPrevented, false);
  dispatch("mousemove", dom.document);
  assert.equal(button.hasAttribute("data-bachata-binding-target"), false);
  assert.equal(dom.query("[data-bachata-picker-outline]").style.display, "none");
  dispatch("keydown", button, { key: "ArrowLeft" });
  dispatch("keydown", button, { key: "ArrowRight" });
  assert.equal(dom.queryAll("[data-bachata-binding-target]").length, 0);
  dispatch("keydown", button, { key: "ArrowUp" });
  assert.ok(dom.query("[data-bachata-binding-target]"));
  dispatch("keydown", button, { key: "Escape" });
  assert.equal(await pick, false);
  assert.equal(await loadBindingDraft(), undefined);
});

test("picker ignores its own controls and removed suggestions", async () => {
  reset();
  const pick = pickBindingElement("sendButton", 3);
  for (const selector of ["[data-bachata-picker-outline]", "[data-bachata-picker-help]"]) {
    dispatch("mousemove", dom.query(selector));
    assert.equal(dom.queryAll("[data-bachata-binding-target]").length, 0);
  }
  dom.query("main").remove();
  dispatch("keydown", dom.document, { key: "ArrowDown" });
  assert.equal(dom.queryAll("[data-bachata-binding-target]").length, 0);
  dispatch("click", dom.query("[data-bachata-picker-help]"));
  assert.equal(await pick, false);
  assert.equal(await loadBindingDraft(), undefined);
});

test("a failed binding save still releases the picker and restores focus", async () => {
  reset();
  const button = dom.query("#send");
  let restored = false;
  const previousActive = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
  Object.defineProperty(dom.document, "activeElement", { configurable: true, value: button });
  Object.defineProperty(button, "focus", { configurable: true, value: () => { restored = true; } });
  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error("Storage unavailable"); };
  try {
    const pick = pickBindingElement("sendButton", 3);
    dispatch("click", button);
    assert.equal(await pick, false);
    assert.equal(restored, true);
    assert.equal(dom.document.documentElement.style.cursor, "auto");
    assert.equal(dom.queryAll("[data-bachata-picker-outline], [data-bachata-picker-help]").length, 0);
  } finally {
    chrome.storage.local.set = originalSet;
    if (previousActive) Object.defineProperty(dom.document, "activeElement", previousActive);
    else delete dom.document.activeElement;
  }
});
