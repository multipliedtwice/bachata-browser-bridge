export type ReconnectMetadata = {
  reconnectAttempt?: number;
  reconnectAt?: number;
};

export type ReconnectAlarmApi = {
  create(name: string, alarmInfo: { when: number }): void | Promise<void>;
  clear(name: string): boolean | Promise<boolean>;
};

export type ReconnectWakeup = {
  timer: ReturnType<typeof setTimeout>;
  retryInMs: number;
};

export const reconnectAlarmName = "bachataBridgeReconnect.v8";
export const reconnectAlarmThresholdMs = 25_000;
export const maximumStoredReconnectAttempt = 32;

export const sanitizeReconnectMetadata = (
  candidate: Record<string, unknown>,
  connectionToken?: string,
): ReconnectMetadata => {
  if (!connectionToken) {
    return {};
  }
  const reconnectAttempt = Number.isInteger(candidate.reconnectAttempt) &&
    Number(candidate.reconnectAttempt) >= 0 &&
    Number(candidate.reconnectAttempt) <= maximumStoredReconnectAttempt
      ? Number(candidate.reconnectAttempt)
      : undefined;
  const reconnectAt = typeof candidate.reconnectAt === "number" &&
    Number.isFinite(candidate.reconnectAt) &&
    candidate.reconnectAt > 0
      ? Math.trunc(candidate.reconnectAt)
      : undefined;
  return {
    ...(reconnectAttempt === undefined ? {} : { reconnectAttempt }),
    ...(reconnectAt === undefined ? {} : { reconnectAt }),
  };
};

export const reconnectDelay = (
  attempt: number,
  random = Math.random,
): number => {
  const base = Math.min(60_000, 3_000 * 2 ** Math.min(attempt, 5));
  const jitter = Math.floor(base * (random() * 0.2 - 0.1));
  return Math.max(1_000, base + jitter);
};

export const nextReconnectMetadata = (
  attempt: number,
  now = Date.now(),
  random = Math.random,
): Required<ReconnectMetadata> & { delay: number } => {
  const delay = reconnectDelay(attempt, random);
  return {
    reconnectAttempt: Math.min(maximumStoredReconnectAttempt, attempt + 1),
    reconnectAt: now + delay,
    delay,
  };
};

export const persistedReconnectAttempt = (attempt: number): number | undefined =>
  attempt > 0 ? attempt : undefined;

export const reconnectDelayUntil = (when: number, now = Date.now()): number =>
  Math.max(1, when - now);

export const shouldRestoreReconnect = (
  endpoint: string | undefined,
  connectionToken: string | undefined,
  reconnectAt: number | undefined,
  now = Date.now(),
): reconnectAt is number =>
  Boolean(endpoint && connectionToken && reconnectAt !== undefined && reconnectAt > now);

export const clearReconnectWakeup = (
  timer: ReturnType<typeof setTimeout> | undefined,
  alarms: ReconnectAlarmApi | undefined,
  clearTimer = clearTimeout,
): void => {
  if (timer !== undefined) {
    clearTimer(timer);
  }
  if (alarms) {
    void Promise.resolve(alarms.clear(reconnectAlarmName)).catch(() => undefined);
  }
};

export const scheduleReconnectWakeup = (
  when: number,
  onDue: () => void,
  alarms: ReconnectAlarmApi | undefined,
  now = Date.now(),
  setTimer = setTimeout,
): ReconnectWakeup => {
  const retryInMs = reconnectDelayUntil(when, now);
  const timer = setTimer(onDue, retryInMs);
  if (retryInMs >= reconnectAlarmThresholdMs && alarms) {
    // BB-AUD-10. The alarm is the wakeup that survives the service worker being evicted; the
    // timer above already covers the case where it is not. A create that refuses, now or
    // asynchronously, therefore costs a wakeup after eviction and nothing else, which is why
    // it is absorbed rather than failing the schedule the caller just made.
    try {
      void Promise.resolve(alarms.create(reconnectAlarmName, { when })).catch(() => undefined);
    } catch {
      // Absorbed: the timer above still fires.
    }
  }
  return { timer, retryInMs };
};
