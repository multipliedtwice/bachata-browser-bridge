/**
 * BB-A4-F22. The two windows in which the artifact-lock wrapper had no signal handler installed.
 *
 * The wrapper's whole job is that it does not release the lock until the wrapped command's
 * process group is gone, so the lock outlives every descendant still writing `dist`. Two windows
 * broke that: the handlers were removed on the immediate child's `exit`, *before* the drain that
 * can wait twenty seconds; and they were registered with `once`, so the first Ctrl-C removed them
 * and a second killed the wrapper outright. Either way the group was abandoned and the lock was
 * released underneath it.
 *
 * `scripts/lib/artifact-lock.mjs` resolves its lock directory from `process.cwd()`, so each case
 * runs the real wrapper in a temporary directory and takes a lock of its own. That is what lets
 * this be an ordinary gated test rather than a manual runner: it never contends for the
 * repository's ambient lock, which `npm test` is already holding around it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withoutArtifactLockEnvironment } from "../scripts/lib/artifact-lock.mjs";
import { removeScratch, scratchRoot } from "./support/scratch.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrapperScript = path.join(root, "scripts", "with-artifact-lock.mjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(error, "code") === "EPERM";
  }
};

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(error, "code") === "EPERM";
  }
};

const waitUntil = async (predicate, attempts = 400) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    await delay(25);
  }
  return false;
};

const exists = async (target) => access(target).then(() => true, () => false);

/**
 * A wrapper run in its own directory, plus the teardown that has to happen whatever the test
 * does next.
 *
 * The cleanup is unconditional and is registered before the first assertion: a case that fails
 * mid-flight — including the mutation proof this test exists to make possible — must still take
 * its wrapper and everything the wrapper started with it, or it leaves exactly the abandoned
 * group the defect under test produces.
 */
const startWrapper = (cwd, script) => {
  const child = spawn(process.execPath, [wrapperScript, "--", process.execPath, "-e", script], {
    cwd,
    env: withoutArtifactLockEnvironment(),
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const extra = new Set();
  const cleanup = async () => {
    if (child.pid && alive(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the outcome this is here to guarantee.
      }
      await waitUntil(async () => !alive(child.pid), 200);
    }
    await exited.catch(() => undefined);
    // The wrapper spawns its command detached, so a command that outlived a killed wrapper leads
    // its own group and is not reachable through the wrapper's. Each watched pid is therefore
    // signalled both as a group and on its own.
    for (const pid of extra) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await waitUntil(async () => !alive(pid) && !groupAlive(pid), 200);
    }
  };
  return { child, exited, cleanup, watch: (pid) => extra.add(pid) };
};

const skip = process.platform === "win32"
  ? { skip: "the wrapper signals a process group, which Windows has no equivalent for" }
  : {};

test("a signal taken while the wrapper drains descendants reaches the group", skip, async (t) => {
  const scratch = await scratchRoot("bachata-bridge-lock-drain-");
  // BB-A4-F21. The lock is the `owner` link inside the directory, not the directory, which is
  // created up front and kept.
  const lockDirectory = path.join(scratch, ".bachata-artifacts.lock", "owner");
  const marker = path.join(scratch, "descendant.pid");
  const commandMarker = path.join(scratch, "command.pid");
  // The immediate child leaves a descendant behind and exits on its own, so the wrapper is inside
  // its drain — not waiting on the child — when the signal arrives.
  const run = startWrapper(scratch, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(commandMarker)}, String(process.pid));`,
    `const grandchild = spawn(process.execPath, ['-e', "setInterval(() => undefined, 50)"], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(marker)}, String(grandchild.pid));`,
    "process.exit(0);",
  ].join(""));
  t.after(async () => {
    await run.cleanup();
    await removeScratch(scratch);
  });

  assert.equal(await waitUntil(() => exists(lockDirectory)), true, "the wrapper never took its lock");
  assert.equal(await waitUntil(() => exists(commandMarker)), true, "the command never started");
  run.watch(Number(await readFile(commandMarker, "utf8")));
  assert.equal(await waitUntil(() => exists(marker)), true, "the descendant never started");
  const descendant = Number(await readFile(marker, "utf8"));
  assert.ok(Number.isInteger(descendant) && descendant > 0, "the descendant has no pid");
  run.watch(descendant);

  // The immediate child has exited and the descendant has not, so the wrapper is draining — and
  // it is still holding the lock, which is the half of the contract the drain exists to keep.
  await delay(300);
  assert.equal(alive(descendant), true, "the descendant died before the window under test opened");
  assert.equal(await exists(lockDirectory), true, "the lock was released while the group was alive");

  run.child.kill("SIGTERM");
  const exit = await run.exited;
  assert.equal(
    exit.signal,
    null,
    "the signal killed the wrapper instead of being forwarded to the group it was waiting for",
  );
  assert.equal(alive(descendant), false, "the abandoned descendant outlived the wrapper");
  assert.equal(await exists(lockDirectory), false, "the lock survived the run that held it");
});

test("a second signal is still forwarded to the wrapped command", skip, async (t) => {
  const scratch = await scratchRoot("bachata-bridge-lock-repeat-");
  // BB-A4-F21. The lock is the `owner` link inside the directory, not the directory, which is
  // created up front and kept.
  const lockDirectory = path.join(scratch, ".bachata-artifacts.lock", "owner");
  const commandMarker = path.join(scratch, "command.pid");
  // The command survives the first signal and stops on the second, so only a wrapper that is
  // still forwarding can end it. Its own deadline turns a lost signal into a failed assertion
  // rather than a hang.
  const run = startWrapper(scratch, [
    `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, String(process.pid));`,
    "let seen = 0;",
    "process.on('SIGTERM', () => { seen += 1; if (seen >= 2) process.exit(0); });",
    "setInterval(() => undefined, 50);",
    "setTimeout(() => process.exit(3), 30000);",
  ].join(""));
  t.after(async () => {
    await run.cleanup();
    await removeScratch(scratch);
  });

  assert.equal(await waitUntil(() => exists(lockDirectory)), true, "the wrapper never took its lock");
  assert.equal(await waitUntil(() => exists(commandMarker)), true, "the command never started");
  run.watch(Number(await readFile(commandMarker, "utf8")));
  await delay(750);
  run.child.kill("SIGTERM");
  await delay(400);
  assert.equal(alive(run.child.pid), true, "one signal ended a command that answers to two");
  run.child.kill("SIGTERM");

  const exit = await run.exited;
  assert.equal(
    exit.signal,
    null,
    "the second signal killed the wrapper rather than being forwarded to the command",
  );
  assert.equal(
    exit.code,
    0,
    "the command was never told to stop a second time, so it ran out its own deadline",
  );
  assert.equal(await exists(lockDirectory), false, "the lock survived a second signal");
});
