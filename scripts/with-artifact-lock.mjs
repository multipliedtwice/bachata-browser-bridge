import { spawn } from "node:child_process";
import { artifactLockEnvironment, withArtifactLock } from "./lib/artifact-lock.mjs";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv[separator + 1] : undefined;
const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
if (!command) {
  throw new Error("Usage: node scripts/with-artifact-lock.mjs -- <command> [args...]");
}

/*
 * BR-G6-22. The lock is held until everything the wrapped command started has gone.
 *
 * `npm` is a launcher: the work — a compiler, a test runner, a bundler, all of them writing
 * `dist` — runs in its children. Signalling and waiting for `npm` alone meant a cancelled run
 * released the lock while that work was still going, and the next run acquired it and wrote
 * `dist` alongside processes nobody was waiting for any more.
 *
 * On POSIX the child leads its own process group, so the group is both what a signal is
 * delivered to and what "gone" is measured against. Windows has no equivalent here, and says so
 * rather than pretending: the immediate child is signalled and awaited as before.
 */
const usesProcessGroup = process.platform !== "win32";
const scopeDrainMs = 10_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const groupIsAlive = (pid) => {
  try {
    // Signal 0 performs the existence check without delivering anything. A negative pid names
    // the process group, so this answers for the descendants too.
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(error, "code") === "EPERM";
  }
};

const waitForGroupExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupIsAlive(pid)) return true;
    await delay(25);
  }
  return !groupIsAlive(pid);
};

const drainProcessScope = async (pid) => {
  if (!usesProcessGroup || !pid || !groupIsAlive(pid)) return;
  if (await waitForGroupExit(pid, scopeDrainMs)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone between the check and the signal.
  }
  await waitForGroupExit(pid, scopeDrainMs);
};

// The wrapper is transparent: whatever the wrapped command exits with is what this process
// exits with. Rejecting instead would collapse every distinct failure — a coverage gate's
// exit code, a test runner's, a build's — into 1, and a caller reading the status could no
// longer tell them apart. The lock is released after the wrapped scope has drained, because
// `withArtifactLock` releases in its own `finally`.
const status = await withArtifactLock(
  (token) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: artifactLockEnvironment(token),
        stdio: "inherit",
        ...(usesProcessGroup ? { detached: true } : {}),
      });
      const forwardSignal = (signal) => {
        if (usesProcessGroup && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The group is gone; fall through to the direct signal.
          }
        }
        child.kill(signal);
      };
      // BB-A4-F22. The handlers stay installed for the whole scope, not only while the immediate
      // child is alive. `once` self-removed on the first signal, and removal on `exit` happened
      // before the drain rather than after it, so a second Ctrl-C — or the first one arriving
      // during a drain that can take twenty seconds — killed this process outright and abandoned
      // the descendants still writing `dist` while the lock was released underneath them.
      // Forwarding repeatedly is safe: the child is spawned detached, so `-child.pid` is never
      // this process's own group.
      process.on("SIGINT", forwardSignal);
      process.on("SIGTERM", forwardSignal);
      const settle = (finish) => {
        process.off("SIGINT", forwardSignal);
        process.off("SIGTERM", forwardSignal);
        finish();
      };
      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        void drainProcessScope(child.pid).then(
          () => settle(() => resolve({ code, signal })),
          (error) => settle(() => reject(error)),
        );
      });
    }),
);

if (status.signal) {
  // Re-raise so the caller observes the same signal the wrapped command died from, rather
  // than an ordinary non-zero exit that hides it.
  process.kill(process.pid, status.signal);
} else {
  process.exitCode = status.code ?? 0;
}
