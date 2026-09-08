export type RevisionQueue = {
  revision: () => number;
  enqueueMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  enqueueRead: <T>(operation: () => Promise<T>) => Promise<T>;
};

export const createRevisionQueue = (): RevisionQueue => {
  let revision = 0;
  let queue = Promise.resolve();

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const guarded = async (): Promise<T> => {
      revision += 1;
      return operation();
    };
    const next = queue.then(guarded, guarded);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const enqueueRead = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    revision: () => revision,
    enqueueMutation,
    enqueueRead,
  };
};

export type SnapshotWriteQueue<T> = {
  enqueue: (value: T) => Promise<void>;
  flush: () => Promise<void>;
};

export const createSnapshotWriteQueue = <T>(
  clone: (value: T) => T,
  write: (value: T) => Promise<void>,
): SnapshotWriteQueue<T> => {
  let queue = Promise.resolve();

  const enqueue = (value: T): Promise<void> => {
    const snapshot = clone(value);
    const operation = queue.then(
      () => write(snapshot),
      () => write(snapshot),
    );
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return {
    enqueue,
    flush: () => queue,
  };
};
