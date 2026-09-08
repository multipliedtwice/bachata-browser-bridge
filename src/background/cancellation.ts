/**
 * Cancellation for the provisioning waits.
 *
 * Opening a provider conversation polls: for the tab, for the session, for the generic
 * binding. Each wait has to end the moment the controller cancels, and it has to end with the
 * cancellation error rather than a timeout, so the caller can tell the two apart.
 */
export const abortError = (): Error =>
  new Error("Opening the provider conversation was cancelled");

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw abortError();
  }
};

/**
 * A delay that ends early when the signal aborts.
 *
 * The listener is removed on both paths, because these waits run in a service worker that
 * outlives any one request: a listener left on a long-lived signal would keep every past
 * delay's closure alive.
 */
export const abortableDelay = (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
