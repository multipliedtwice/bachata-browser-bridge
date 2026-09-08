export type TransientControlProbe<T> = {
  timeoutMs: number;
  pollIntervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
  resolveCurrent: () => T | undefined;
  collectHeuristicCandidates: () => T[];
  startHealing?: (() => Promise<T | undefined> | undefined) | undefined;
  maximumHealingAttempts?: number | undefined;
  isValid: (candidate: T | undefined) => candidate is T;
};

/**
 * The clock every bounded wait in the generic content script reads.
 *
 * Each of these loops is a deadline and a pause, and both were written against the ambient
 * `Date.now` and `setTimeout`. That is fine in a page and useless in a test: a harness can make
 * `setTimeout` fire at once, but the deadline is still wall-clock, so a wait for something that
 * never happens spins for its full timeout and the suite has to wait it out. Driving a real
 * request through the entry was not slow, it was unfinishable.
 *
 * So the clock is named once and read everywhere, and a test may substitute one whose time it
 * controls. Production substitutes nothing: `realScheduler` is `Date.now` and `setTimeout`, and
 * the waits behave exactly as they did.
 */
export type WaitScheduler = {
  now: () => number;
  delay: (ms: number) => Promise<void>;
};

const realScheduler: WaitScheduler = {
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

let scheduler: WaitScheduler = realScheduler;

/** Substitute the clock. Passing nothing restores the real one, so a test can always undo it. */
export const setWaitScheduler = (next?: WaitScheduler | undefined): void => {
  scheduler = next ?? realScheduler;
};

export const now = (): number => scheduler.now();

export const delay = (ms: number): Promise<void> => scheduler.delay(ms);

export const waitForTransientControl = async <T>(
  probe: TransientControlProbe<T>,
): Promise<T | undefined> => {
  const deadlineAt = now() + Math.max(1, probe.timeoutMs);
  const pollIntervalMs = Math.max(10, probe.pollIntervalMs ?? 100);
  const maximumHealingAttempts = Math.max(0, probe.maximumHealingAttempts ?? 2);
  let healingAttempts = 0;
  let healing: Promise<T | undefined> | undefined;

  while (now() <= deadlineAt) {
    if (probe.signal?.aborted) return undefined;
    const current = probe.resolveCurrent();
    if (probe.isValid(current)) return current;
    const heuristic = probe.collectHeuristicCandidates().filter((candidate) => probe.isValid(candidate));
    if (heuristic.length === 1) return heuristic[0];

    if (!healing && healingAttempts < maximumHealingAttempts && probe.startHealing) {
      const attempt = probe.startHealing();
      if (attempt) {
        healingAttempts += 1;
        healing = attempt.catch(() => undefined);
      }
    }

    const remaining = deadlineAt - now();
    if (remaining <= 0) break;
    const pause = delay(Math.min(pollIntervalMs, remaining));
    if (!healing) {
      await pause;
      continue;
    }
    const result = await Promise.race([
      healing.then((candidate) => ({ completed: true as const, candidate })),
      pause.then(() => ({ completed: false as const, candidate: undefined })),
    ]);
    if (!result.completed) continue;
    healing = undefined;
    if (probe.isValid(result.candidate)) return result.candidate;
  }
  return undefined;
};

export type StableConditionProbe = {
  timeoutMs: number;
  stableMs: number;
  pollIntervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
  observe: () => boolean | Promise<boolean>;
};

export const waitForStableCondition = async (
  probe: StableConditionProbe,
): Promise<boolean> => {
  const deadlineAt = now() + Math.max(1, probe.timeoutMs);
  const stableMs = Math.max(0, probe.stableMs);
  const pollIntervalMs = Math.max(10, probe.pollIntervalMs ?? 100);
  let stableSince: number | undefined;
  while (now() <= deadlineAt) {
    if (probe.signal?.aborted) return false;
    const observed = await probe.observe();
    const observedAt = now();
    if (observed) {
      stableSince ??= observedAt;
      if (observedAt - stableSince >= stableMs) return true;
    } else {
      stableSince = undefined;
    }
    const remaining = deadlineAt - now();
    if (remaining <= 0) break;
    await delay(Math.min(pollIntervalMs, remaining));
  }
  return false;
};
