export type ProvisioningOutcome<Result> =
  | { status: "completed"; result: Result }
  | { status: "failed"; error: Error }
  | { status: "cancelled" };

export type ProvisioningQueue<Input> = {
  enqueue: (requestId: string, input: Input) => boolean;
  cancel: (requestId: string) => boolean;
  cancelAll: () => void;
  has: (requestId: string) => boolean;
  activeCount: () => number;
  queuedCount: () => number;
};

type Entry<Input> = {
  requestId: string;
  input: Input;
  controller: AbortController;
  state: "queued" | "running";
};

export const createProvisioningQueue = <Input, Result>(options: {
  maxConcurrent: number;
  run: (requestId: string, input: Input, signal: AbortSignal) => Promise<Result>;
  settle: (requestId: string, input: Input, outcome: ProvisioningOutcome<Result>) => void;
}): ProvisioningQueue<Input> => {
  const entries = new Map<string, Entry<Input>>();
  const queued: string[] = [];
  let active = 0;

  const pump = (): void => {
    while (active < options.maxConcurrent && queued.length > 0) {
      const requestId = queued.shift() as string;
      const entry = entries.get(requestId);
      if (!entry || entry.state !== "queued") {
        continue;
      }
      entry.state = "running";
      active += 1;
      void options.run(requestId, entry.input, entry.controller.signal).then(
        (result) => {
          if (!entries.delete(requestId)) {
            return;
          }
          options.settle(
            requestId,
            entry.input,
            entry.controller.signal.aborted
              ? { status: "cancelled" }
              : { status: "completed", result },
          );
        },
        (cause) => {
          if (!entries.delete(requestId)) {
            return;
          }
          options.settle(
            requestId,
            entry.input,
            entry.controller.signal.aborted
              ? { status: "cancelled" }
              : {
                  status: "failed",
                  error: cause instanceof Error ? cause : new Error(String(cause)),
                },
          );
        },
      ).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  const enqueue = (requestId: string, input: Input): boolean => {
    if (entries.has(requestId)) {
      return false;
    }
    entries.set(requestId, {
      requestId,
      input,
      controller: new AbortController(),
      state: "queued",
    });
    queued.push(requestId);
    pump();
    return true;
  };

  const cancel = (requestId: string): boolean => {
    const entry = entries.get(requestId);
    if (!entry) {
      return false;
    }
    if (entry.state === "queued") {
      entries.delete(requestId);
      const index = queued.indexOf(requestId);
      if (index >= 0) {
        queued.splice(index, 1);
      }
      entry.controller.abort();
      options.settle(requestId, entry.input, { status: "cancelled" });
      return true;
    }
    entry.controller.abort();
    return true;
  };

  const cancelAll = (): void => {
    Array.from(entries.keys()).forEach(cancel);
  };

  return {
    enqueue,
    cancel,
    cancelAll,
    has: (requestId) => entries.has(requestId),
    activeCount: () => active,
    queuedCount: () => queued.length,
  };
};
