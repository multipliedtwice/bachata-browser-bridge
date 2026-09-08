import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  handleLocalModelPromptMessage,
  setLocalModelConfig,
} from "../dist/background/localModelProxy.js";

// Captured before withGlobals swaps globalThis.fetch, so the real-redirect fixtures below exercise
// the platform fetch (redirect: "error") against ephemeral loopback servers rather than a stub.
const nativeFetch = globalThis.fetch;

const listen = (handler) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

// REVIEW-11 / BB-5. The local-model proxy is the extension's only outbound network path.
// Nothing exercised it, so the loopback-only rule, the prompt limit, the sender check and
// the backend fallback order were all unguarded behaviour.

const extensionId = "bachata-bridge-test";
const savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

const withGlobals = async (fetchImpl, body) => {
  Object.defineProperty(globalThis, "chrome", {
    value: { runtime: { id: extensionId } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "fetch", {
    value: fetchImpl,
    configurable: true,
    writable: true,
  });
  try {
    return await body();
  } finally {
    if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome);
    else delete globalThis.chrome;
    if (savedFetch) Object.defineProperty(globalThis, "fetch", savedFetch);
    else delete globalThis.fetch;
  }
};

const enabled = (overrides = {}) => {
  setLocalModelConfig({
    enabled: true,
    backend: "auto",
    model: "prism-ml/Bonsai-27B-mlx-1bit",
    timeoutMs: 30_000,
    ...overrides,
  });
};

const respond = () => {
  let settle;
  const answered = new Promise((resolve) => {
    settle = resolve;
  });
  return { answered, sendResponse: (value) => settle(value) };
};

const prompt = (overrides = {}) => ({
  type: "BACHATA_LOCAL_MODEL_PROMPT",
  requestId: "request-1",
  prompt: "Pick a candidate",
  ...overrides,
});

const jsonResponse = (value, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => value,
});

const ask = (message, sender = { id: extensionId }) => {
  const { answered, sendResponse } = respond();
  const kept = handleLocalModelPromptMessage(message, sender, sendResponse);
  return { answered, kept };
};

test("a message that is not a local-model request is left to another listener", () => {
  [null, "text", [], { type: "BACHATA_GENERIC_STATUS" }].forEach((message) => {
    assert.equal(
      handleLocalModelPromptMessage(message, { id: extensionId }, () => undefined),
      false,
    );
  });
});

test("a prompt from anything but this extension is refused", async () => {
  await withGlobals(async () => jsonResponse({}), async () => {
    enabled();
    const { answered, kept } = ask(prompt(), { id: "some-other-extension" });
    assert.equal(kept, false);
    assert.deepEqual(await answered, {
      ok: false,
      error: "Invalid local-model prompt request",
    });
  });
});

test("a malformed prompt request is refused before any network work", async () => {
  await withGlobals(
    async () => {
      throw new Error("no request should reach the network");
    },
    async () => {
      enabled();
      const cases = [
        { prompt: 7 },
        { requestId: "" },
        { requestId: 5 },
        { deadlineAt: 1.5 },
      ];
      for (const overrides of cases) {
        const { answered, kept } = ask(prompt(overrides));
        assert.equal(kept, false, JSON.stringify(overrides));
        assert.equal((await answered).ok, false, JSON.stringify(overrides));
      }
    },
  );
});

test("a prompt beyond the selector-healing limit is refused", async () => {
  await withGlobals(
    async () => {
      throw new Error("no request should reach the network");
    },
    async () => {
      enabled();
      const { answered, kept } = ask(prompt({ prompt: "x".repeat(256 * 1024 + 1) }));
      assert.equal(kept, false);
      assert.match((await answered).error, /exceeds the selector-healing limit/u);
    },
  );
});

test("healing that is switched off answers with the setting, not a network error", async () => {
  await withGlobals(
    async () => {
      throw new Error("no request should reach the network");
    },
    async () => {
      setLocalModelConfig({
        enabled: false,
        backend: "auto",
        model: "model",
        timeoutMs: 30_000,
      });
      const { answered } = ask(prompt());
      assert.match((await answered).error, /disabled in Bachata settings/u);
    },
  );
});

test("a blank model name is refused", async () => {
  await withGlobals(
    async () => {
      throw new Error("no request should reach the network");
    },
    async () => {
      enabled({ model: "   " });
      const { answered } = ask(prompt());
      assert.match((await answered).error, /local model must be configured/u);
    },
  );
});

test("only loopback HTTP(S) endpoints are dialled", async () => {
  const attempted = [];
  await withGlobals(
    async (url) => {
      attempted.push(url);
      return jsonResponse({ choices: [{ message: { content: "{}" } }] });
    },
    async () => {
      for (const endpoint of [
        "http://192.168.1.10:1234",
        "https://example.invalid",
        "ftp://127.0.0.1:1234",
      ]) {
        enabled({ backend: "lmstudio", endpoint });
        const { answered } = ask(prompt());
        assert.match((await answered).error, /only loopback HTTP\(S\)/u, endpoint);
      }
      enabled({ backend: "lmstudio", endpoint: "not a url" });
      const { answered } = ask(prompt());
      assert.match((await answered).error, /must be a valid URL/u);
      assert.deepEqual(attempted, []);
    },
  );
});

test("a trailing slash on a loopback endpoint is not doubled into the path", async () => {
  const attempted = [];
  await withGlobals(
    async (url) => {
      attempted.push(url);
      return jsonResponse({ choices: [{ message: { content: "{\"id\":\"a\"}" } }] });
    },
    async () => {
      enabled({ backend: "lmstudio", endpoint: "http://localhost:1234//" });
      const { answered } = ask(prompt());
      assert.deepEqual(await answered, { ok: true, text: "{\"id\":\"a\"}" });
      assert.deepEqual(attempted, ["http://localhost:1234/v1/chat/completions"]);
    },
  );
});

test("the LM Studio backend reads the first choice's message content", async () => {
  await withGlobals(
    async (url, init) => {
      assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
      assert.equal(JSON.parse(init.body).model, "configured-model");
      return jsonResponse({ choices: [{ message: { content: "lmstudio-answer" } }] });
    },
    async () => {
      enabled({ backend: "lmstudio", model: "configured-model" });
      const { answered, kept } = ask(prompt());
      assert.equal(kept, true);
      assert.deepEqual(await answered, { ok: true, text: "lmstudio-answer" });
    },
  );
});

test("the Ollama backend reads its own message content", async () => {
  await withGlobals(
    async (url) => {
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      return jsonResponse({ message: { content: "ollama-answer" } });
    },
    async () => {
      enabled({ backend: "ollama" });
      const { answered } = ask(prompt());
      assert.deepEqual(await answered, { ok: true, text: "ollama-answer" });
    },
  );
});

test("a backend that answers without content is reported by name", async () => {
  await withGlobals(async () => jsonResponse({ choices: [] }), async () => {
    enabled({ backend: "lmstudio" });
    assert.match((await ask(prompt()).answered).error, /LM Studio returned no message content/u);
  });
  await withGlobals(async () => jsonResponse({}), async () => {
    enabled({ backend: "ollama" });
    assert.match((await ask(prompt()).answered).error, /Ollama returned no message content/u);
  });
});

test("an HTTP failure and a non-object body are both reported", async () => {
  await withGlobals(async () => jsonResponse({}, false, 503), async () => {
    enabled({ backend: "lmstudio" });
    assert.match((await ask(prompt()).answered).error, /failed with HTTP 503/u);
  });
  await withGlobals(async () => jsonResponse([1, 2, 3]), async () => {
    enabled({ backend: "lmstudio" });
    assert.match((await ask(prompt()).answered).error, /returned invalid JSON/u);
  });
});

test("the automatic backend tries LM Studio first and falls back to Ollama", async () => {
  const attempted = [];
  await withGlobals(
    async (url) => {
      attempted.push(url);
      if (url.includes("/v1/chat/completions")) throw new Error("no LM Studio here");
      return jsonResponse({ message: { content: "ollama-answer" } });
    },
    async () => {
      enabled();
      const { answered } = ask(prompt());
      assert.deepEqual(await answered, { ok: true, text: "ollama-answer" });
      assert.deepEqual(attempted, [
        "http://127.0.0.1:1234/v1/chat/completions",
        "http://127.0.0.1:11434/api/chat",
      ]);
    },
  );
});

test("an endpoint on Ollama's own port is tried as Ollama first", async () => {
  const attempted = [];
  await withGlobals(
    async (url) => {
      attempted.push(url);
      return jsonResponse({ message: { content: "ollama-answer" } });
    },
    async () => {
      enabled({ endpoint: "http://127.0.0.1:11434" });
      const { answered } = ask(prompt());
      assert.deepEqual(await answered, { ok: true, text: "ollama-answer" });
      assert.deepEqual(attempted, ["http://127.0.0.1:11434/api/chat"]);
    },
  );
});

test("a configured endpoint that speaks neither API names both failures", async () => {
  await withGlobals(
    async () => {
      throw new Error("connection refused");
    },
    async () => {
      enabled({ endpoint: "http://127.0.0.1:9999" });
      const { answered } = ask(prompt());
      const { error } = await answered;
      assert.match(error, /did not expose LM Studio or Ollama APIs/u);
      assert.match(error, /connection refused \| connection refused/u);
    },
  );
});

test("a cancellation for this extension is acknowledged, and another sender's is refused", async () => {
  await withGlobals(async () => jsonResponse({}), async () => {
    const own = respond();
    assert.equal(
      handleLocalModelPromptMessage(
        { type: "BACHATA_LOCAL_MODEL_CANCEL", requestId: "request-1" },
        { id: extensionId },
        own.sendResponse,
      ),
      false,
    );
    assert.deepEqual(await own.answered, { ok: true });

    const foreign = respond();
    handleLocalModelPromptMessage(
      { type: "BACHATA_LOCAL_MODEL_CANCEL", requestId: "request-1" },
      { id: "another-extension" },
      foreign.sendResponse,
    );
    assert.deepEqual(await foreign.answered, {
      ok: false,
      error: "Invalid local-model cancellation request",
    });
  });
});

test("a request cancelled while it is in flight ends as an interruption", async () => {
  await withGlobals(
    (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        handleLocalModelPromptMessage(
          { type: "BACHATA_LOCAL_MODEL_CANCEL", requestId: "in-flight" },
          { id: extensionId },
          () => undefined,
        );
      }),
    async () => {
      enabled({ backend: "lmstudio" });
      const { answered } = ask(prompt({ requestId: "in-flight" }));
      assert.equal((await answered).ok, false);
    },
  );
});

test("a deadline already in the past is refused as a timeout", async () => {
  await withGlobals(
    async () => {
      throw new Error("no request should reach the network");
    },
    async () => {
      enabled();
      const { answered } = ask(prompt({ deadlineAt: Date.now() - 1_000 }));
      assert.match((await answered).error, /timed out/u);
    },
  );
});

test("a second prompt waits for the first, and the queue refuses beyond its bound", async () => {
  const held = [];
  await withGlobals(
    (url, init) =>
      new Promise((resolve, reject) => {
        held.push(() => resolve(jsonResponse({ choices: [{ message: { content: "answer" } }] })));
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    async () => {
      enabled({ backend: "lmstudio" });
      const inFlight = ask(prompt({ requestId: "first" }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(held.length, 1);

      const queued = [1, 2, 3, 4].map((index) =>
        ask(prompt({ requestId: `queued-${String(index)}` })),
      );
      const overflow = ask(prompt({ requestId: "overflow" }));
      assert.match((await overflow.answered).error, /queue is full/u);

      held[0]();
      assert.deepEqual(await inFlight.answered, { ok: true, text: "answer" });
      for (const entry of queued) {
        // Each queued request runs in turn once the one before it releases.
        await new Promise((resolve) => setImmediate(resolve));
        held[held.length - 1]?.();
        assert.equal((await entry.answered).ok, true);
      }
    },
  );
});

// PAIR-R26-01. A loopback service the reader configured can answer with a redirect. The proxy asks
// fetch to reject redirects at the transport boundary, and refuses a redirected response, so the
// healing prompt never crosses to the redirect destination.
test("the proxy asks fetch to reject redirects and refuses a redirected response", async () => {
  let seenRedirect;
  await withGlobals(
    async (_url, init) => {
      seenRedirect = init.redirect;
      return { ok: true, redirected: true, status: 200, json: async () => ({}) };
    },
    async () => {
      enabled({ backend: "lmstudio" });
      const { answered } = ask(prompt());
      const result = await answered;
      assert.equal(seenRedirect, "error", "fetch was not asked to reject redirects");
      assert.equal(result.ok, false);
      assert.match(result.error, /off-host redirect/u);
    },
  );
});

// PAIR-R26-01 (real transport). Ephemeral loopback redirector answers 307/308 with a Location on a
// different loopback port (the redirect destination). With redirect: "error" the platform fetch
// refuses the redirect before dialling that destination, so the destination server records zero
// hits across the explicit LM Studio, explicit Ollama, and auto-fallback backends. Same host,
// different port — a cross-origin redirect destination, not a claimed off-host exploit.
test("a real loopback redirect is refused before the redirect destination is contacted", async () => {
  for (const { status, backend, path } of [
    { status: 307, backend: "lmstudio", path: "/v1/chat/completions" },
    { status: 308, backend: "ollama", path: "/api/chat" },
    { status: 307, backend: "auto", path: "/v1/chat/completions" },
  ]) {
    let destinationHits = 0;
    const destination = await listen((_request, response) => {
      destinationHits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "{}" } }], message: { content: "{}" } }));
    });
    const destinationUrl = `http://127.0.0.1:${String(destination.address().port)}${path}`;
    const redirector = await listen((_request, response) => {
      response.writeHead(status, { location: destinationUrl });
      response.end();
    });
    const endpoint = `http://127.0.0.1:${String(redirector.address().port)}`;
    try {
      await withGlobals(nativeFetch, async () => {
        enabled({ backend, endpoint, timeoutMs: 2_000 });
        const { answered } = ask(prompt());
        const result = await answered;
        assert.equal(result.ok, false, `${backend} ${String(status)} was not refused`);
      });
      assert.equal(destinationHits, 0, `${backend} ${String(status)} followed the redirect to its destination`);
    } finally {
      await close(redirector);
      await close(destination);
    }
  }
});

test("a real loopback 200 still succeeds through the platform fetch", async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
  });
  const endpoint = `http://127.0.0.1:${String(server.address().port)}`;
  try {
    await withGlobals(nativeFetch, async () => {
      enabled({ backend: "lmstudio", endpoint, timeoutMs: 2_000 });
      const { answered } = ask(prompt());
      assert.deepEqual(await answered, { ok: true, text: "{\"ok\":true}" });
    });
  } finally {
    await close(server);
  }
});
