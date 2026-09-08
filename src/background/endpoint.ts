const endpointPattern = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/bachata-browser-bridge-v9$/u;

export const normalizeBridgeEndpoint = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Bridge endpoint must be a string");
  }
  const trimmed = value.trim();
  const match = trimmed.match(endpointPattern);
  if (!match) {
    throw new Error("Bridge endpoint must use the Bachata loopback WebSocket URL");
  }
  const port = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Bridge endpoint port must be between 1 and 65535");
  }
  // No second pass over a parsed URL. `endpointPattern` is anchored and already fixes the
  // scheme, host, path and port digits, and forbids userinfo, query and fragment by leaving
  // them nowhere to appear — so every component that pass re-checked was already decided,
  // and none of its branches could ever be taken. What actually keeps an unvalidated
  // component from escaping is the return value: the endpoint is rebuilt from the one
  // capture that was range-checked, never echoed back from the caller's string.
  return `ws://127.0.0.1:${String(port)}/bachata-browser-bridge-v9`;
};
