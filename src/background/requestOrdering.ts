export type RequestOrdering = {
  queuedSendIds: Set<string>;
  pendingInterrupts: Set<string>;
  recordSend: (requestId: string) => void;
  recordInterrupt: (requestId: string) => void;
  beginSend: (requestId: string) => void;
  /**
   * BB-A4-N05. Hold a completion that arrived while a Stop was pending, so whichever way the Stop
   * settles owns it. A final answer is not a thing to drop because a Stop is in flight.
   */
  retainCompletion: (requestId: string, completion: () => Promise<void>) => void;
  /** BB-A4-N05. Take the held completion, once. A second caller gets nothing. */
  takeCompletion: (requestId: string) => (() => Promise<void>) | undefined;
  clear: () => void;
};

export const createRequestOrdering = (): RequestOrdering => {
  const queuedSendIds = new Set<string>();
  const pendingInterrupts = new Set<string>();
  const retainedCompletions = new Map<string, () => Promise<void>>();

  return {
    queuedSendIds,
    pendingInterrupts,
    recordSend: (requestId) => {
      queuedSendIds.add(requestId);
    },
    recordInterrupt: (requestId) => {
      if (queuedSendIds.has(requestId)) {
        pendingInterrupts.add(requestId);
      }
    },
    beginSend: (requestId) => {
      queuedSendIds.delete(requestId);
    },
    retainCompletion: (requestId, completion) => {
      retainedCompletions.set(requestId, completion);
    },
    takeCompletion: (requestId) => {
      const completion = retainedCompletions.get(requestId);
      retainedCompletions.delete(requestId);
      return completion;
    },
    clear: () => {
      queuedSendIds.clear();
      pendingInterrupts.clear();
      retainedCompletions.clear();
    },
  };
};
