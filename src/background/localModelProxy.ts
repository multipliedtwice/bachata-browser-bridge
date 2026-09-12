import type { BrowserLocalModelConfig } from "../protocol/types.js";

type LocalModelPromptRequest = {
  type: "BACHATA_LOCAL_MODEL_PROMPT";
  requestId: string;
  prompt: string;
  deadlineAt?: number;
};

type PromptConfig = {
  backend: "auto" | "lmstudio" | "ollama";
  endpoint?: string;
  model: string;
  timeoutMs: number;
};

type QueueWaiter = {
  requestId: string;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_QUEUE = 4;
// No model is assumed. The extension resolves which local model this machine actually has and
// sends it; until then there is nothing to heal with, and saying so is better than asking a server
// for a model nobody confirmed is installed.
let configured: BrowserLocalModelConfig = {
  enabled: false,
  backend: "auto",
  model: "",
  timeoutMs: 30_000,
};
let active = false;
const queue: QueueWaiter[] = [];
const controllers = new Map<string, AbortController>();

export const setLocalModelConfig = (value: BrowserLocalModelConfig): void => {
  configured = { ...value };
};

const abortError = (): Error => new Error("Local model request interrupted");
const timeoutError = (): Error => new Error("Local model request timed out");

const cleanWaiter = (waiter: QueueWaiter): void => {
  clearTimeout(waiter.timer);
  waiter.signal.removeEventListener("abort", waiter.abort);
};

const activateNext = (): void => {
  while (queue.length > 0) {
    const waiter = queue.shift()!;
    cleanWaiter(waiter);
    if (waiter.signal.aborted) {
      waiter.reject(abortError());
      continue;
    }
    active = true;
    waiter.resolve();
    return;
  }
  active = false;
};

const acquire = async (requestId: string, signal: AbortSignal, deadlineAt: number): Promise<() => void> => {
  if (signal.aborted) throw abortError();
  if (Date.now() >= deadlineAt) throw timeoutError();
  if (!active) {
    active = true;
    return activateNext;
  }
  if (queue.length >= MAX_QUEUE) throw new Error("Local model queue is full");
  await new Promise<void>((resolve, reject) => {
    const remaining = Math.max(1, deadlineAt - Date.now());
    const waiter = {} as QueueWaiter;
    waiter.requestId = requestId;
    waiter.signal = signal;
    waiter.resolve = resolve;
    waiter.reject = reject;
    waiter.abort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      cleanWaiter(waiter);
      reject(abortError());
    };
    waiter.timer = setTimeout(() => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      signal.removeEventListener("abort", waiter.abort);
      reject(timeoutError());
    }, remaining);
    signal.addEventListener("abort", waiter.abort, { once: true });
    queue.push(waiter);
  });
  return activateNext;
};

const loopbackEndpoint = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Local model endpoint must be a valid URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (!loopback || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("Selector healing accepts only loopback HTTP(S) local-model endpoints");
  }
  return value.replace(/\/+$/, "");
};

const fetchJson = async (
  url: string,
  init: RequestInit,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw timeoutError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.redirected || response.type === "opaqueredirect") {
      throw new Error("Local model endpoint attempted an off-host redirect");
    }
    if (!response.ok) throw new Error(`Local model request failed with HTTP ${String(response.status)}`);
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local model returned invalid JSON");
    return value as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};

const lmStudio = async (prompt: string, config: PromptConfig, deadlineAt: number, signal: AbortSignal): Promise<string> => {
  const endpoint = loopbackEndpoint(config.endpoint ?? "http://127.0.0.1:1234");
  const response = await fetchJson(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 384,
      messages: [
        { role: "system", content: "Return only the requested compact JSON object. Select only supplied candidate IDs. Abstain when uncertain." },
        { role: "user", content: prompt },
      ],
    }),
  }, deadlineAt, signal);
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string") throw new Error("LM Studio returned no message content");
  return message.content;
};

const ollama = async (prompt: string, config: PromptConfig, deadlineAt: number, signal: AbortSignal): Promise<string> => {
  const endpoint = loopbackEndpoint(config.endpoint ?? "http://127.0.0.1:11434");
  const response = await fetchJson(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: 384 },
      messages: [
        { role: "system", content: "Return only the requested compact JSON object. Select only supplied candidate IDs. Abstain when uncertain." },
        { role: "user", content: prompt },
      ],
    }),
  }, deadlineAt, signal);
  const message = response.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string") throw new Error("Ollama returned no message content");
  return message.content;
};

const resolveConfig = (): PromptConfig => {
  if (!configured.enabled) throw new Error("Browser selector healing is disabled in Bachata settings");
  const model = configured.model.trim();
  if (!model) {
    throw new Error(
      "No local model is available for selector healing. Bachata selects one from your Ollama or LM Studio installation; start one, or set a model in Bachata settings.",
    );
  }
  return {
    backend: configured.backend,
    ...(configured.endpoint?.trim() ? { endpoint: configured.endpoint.trim() } : {}),
    model,
    timeoutMs: Math.max(1_000, Math.min(120_000, configured.timeoutMs)),
  };
};

const runPrompt = async (request: LocalModelPromptRequest): Promise<string> => {
  const config = resolveConfig();
  const configuredDeadlineAt = Date.now() + config.timeoutMs;
  const deadlineAt = request.deadlineAt === undefined
    ? configuredDeadlineAt
    : Math.min(configuredDeadlineAt, request.deadlineAt);
  if (deadlineAt <= Date.now()) throw timeoutError();
  const controller = new AbortController();
  controllers.set(request.requestId, controller);
  const deadline = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
  let release: (() => void) | undefined;
  try {
    release = await acquire(request.requestId, controller.signal, deadlineAt);
    if (config.backend === "lmstudio") return await lmStudio(request.prompt, config, deadlineAt, controller.signal);
    if (config.backend === "ollama") return await ollama(request.prompt, config, deadlineAt, controller.signal);
    const attempts = config.endpoint
      ? (() => {
          const endpoint = loopbackEndpoint(config.endpoint!);
          const port = new URL(endpoint).port;
          return (port === "11434" ? [ollama, lmStudio] : [lmStudio, ollama]).map((attempt) => ({ attempt, endpoint }));
        })()
      : [
          { attempt: lmStudio, endpoint: "http://127.0.0.1:1234" },
          { attempt: ollama, endpoint: "http://127.0.0.1:11434" },
        ];
    const errors: string[] = [];
    for (const { attempt, endpoint } of attempts) {
      if (controller.signal.aborted) throw Date.now() >= deadlineAt ? timeoutError() : abortError();
      if (Date.now() >= deadlineAt) throw timeoutError();
      try {
        return await attempt(request.prompt, { ...config, endpoint }, deadlineAt, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw Date.now() >= deadlineAt ? timeoutError() : abortError();
        if (Date.now() >= deadlineAt) throw timeoutError();
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Configured local model did not expose LM Studio or Ollama APIs: ${errors.join(" | ")}`);
  } finally {
    clearTimeout(deadline);
    controllers.delete(request.requestId);
    release?.();
  }
};

const cancelRequest = (requestId: string): void => {
  controllers.get(requestId)?.abort();
  const waiter = queue.find((entry) => entry.requestId === requestId);
  waiter?.abort();
};

export const handleLocalModelPromptMessage = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: unknown) => void,
): boolean => {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  if (record.type === "BACHATA_LOCAL_MODEL_CANCEL") {
    if (sender.id === chrome.runtime.id && typeof record.requestId === "string") {
      cancelRequest(record.requestId);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "Invalid local-model cancellation request" });
    }
    return false;
  }
  if (record.type !== "BACHATA_LOCAL_MODEL_PROMPT") return false;
  if (sender.id !== chrome.runtime.id
    || typeof record.prompt !== "string"
    || typeof record.requestId !== "string"
    || !record.requestId
    || (record.deadlineAt !== undefined && !Number.isSafeInteger(record.deadlineAt))) {
    sendResponse({ ok: false, error: "Invalid local-model prompt request" });
    return false;
  }
  if (new TextEncoder().encode(record.prompt).byteLength > MAX_PROMPT_BYTES) {
    sendResponse({ ok: false, error: "Local-model prompt exceeds the selector-healing limit" });
    return false;
  }
  const request: LocalModelPromptRequest = {
    type: "BACHATA_LOCAL_MODEL_PROMPT",
    requestId: record.requestId,
    prompt: record.prompt,
    ...(typeof record.deadlineAt === "number" ? { deadlineAt: record.deadlineAt } : {}),
  };
  void runPrompt(request).then(
    (text) => sendResponse({ ok: true, text }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
};
