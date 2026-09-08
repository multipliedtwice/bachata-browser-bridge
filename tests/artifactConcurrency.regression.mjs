import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { withoutArtifactLockEnvironment } from "../scripts/lib/artifact-lock.mjs";
import { removeScratch, scratchRoot } from "./support/scratch.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
// BB-A4-F21. The lock is the `owner` link inside the directory. The directory itself is created
// once and kept, so its presence says nothing about whether the lock is held.
const lockRoot = path.join(root, ".bachata-artifacts.lock");
const lockDirectory = path.join(lockRoot, "owner");

const run = (command, args, environment = withoutArtifactLockEnvironment()) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve(output);
    else reject(new Error(`${command} ${args.join(" ")} ${signal ? `stopped by ${signal}` : `exited ${String(code)}`}\n${output}`));
  });
});

const waitForLock = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(lockDirectory);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Artifact lock was not acquired");
};

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

// A lock instance owned by somebody else, standing in the slot this run believes it holds.
const acquireForeignLock = async () => {
  const token = randomUUID();
  await mkdir(lockRoot, { recursive: true });
  const proof = path.join(lockRoot, `owner-${token}.json`);
  await writeFile(proof, `${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
  await link(proof, lockDirectory);
  return token;
};

const temporary = await scratchRoot("bachata-bridge-artifacts-");
try {
  await run(process.execPath, ["scripts/with-artifact-lock.mjs", "--", process.execPath,
    "scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", "process.exit(0)"]);

  await assert.rejects(
    run(process.execPath, ["scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", "process.exit(7)"]),
    /exited 7/u,
  );
  await run(process.execPath, ["scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", "process.exit(0)"]);

  const signalChild = spawn(process.execPath, ["scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", "setInterval(() => undefined, 1000)"], {
    cwd: root,
    env: withoutArtifactLockEnvironment(),
    stdio: "ignore",
  });
  await waitForLock();
  signalChild.kill("SIGTERM");
  await new Promise((resolve) => signalChild.once("exit", resolve));
  await run(process.execPath, ["scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", "process.exit(0)"]);

  // BR-G6-22. `npm` is a launcher: the work that writes `dist` runs in its children. Signalling
  // and awaiting the immediate child alone released the lock while that work was still running,
  // and the next run wrote `dist` beside processes nobody was waiting for any more. The wrapped
  // command here leaves a grandchild holding a marker file open past its own exit.
  if (process.platform !== "win32") {
    const marker = path.join(temporary, "descendant.pid");
    const descendantScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const grandchild = spawn(process.execPath, ['-e', "setInterval(() => undefined, 50)"], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(marker)}, String(grandchild.pid));`,
      "setInterval(() => undefined, 50);",
    ].join("");
    const scopeChild = spawn(
      process.execPath,
      ["scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", descendantScript],
      { cwd: root, env: withoutArtifactLockEnvironment(), stdio: "ignore" },
    );
    await waitForLock();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const descendantPid = Number(await readFile(marker, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "the descendant never started");
    scopeChild.kill("SIGTERM");
    await new Promise((resolve) => scopeChild.once("exit", resolve));
    // The lock is only released once the whole scope is gone, so by the time the wrapper has
    // exited the descendant must be gone too.
    let descendantAlive = true;
    try {
      process.kill(descendantPid, 0);
    } catch (error) {
      descendantAlive = Reflect.get(error, "code") === "EPERM";
    }
    assert.equal(
      descendantAlive,
      false,
      "the lock was released while the cancelled run's own descendants were still writing dist",
    );
    await run(process.execPath, ["scripts/with-artifact-lock.mjs", "--", process.execPath, "-e", "process.exit(0)"]);
  }

  // BR-G6-21. Reclaiming a lock used to remove the directory in place: between reading a dead
  // owner and deleting what it named, another waiter could reclaim and write its own owner, and
  // the recursive delete then took a live holder's lock without failing. Releasing a lock that
  // has already changed hands must refuse rather than delete.
  {
    const { retireLockInstance, withArtifactLock } = await import("../scripts/lib/artifact-lock.mjs");
    // The fencing itself: taking a lock instance is a rename, and an instance that turns out not
    // to be the one that was judged is put straight back rather than deleted. Removing the
    // directory in place could not tell the two apart, so a waiter that judged a dead owner and
    // then lost the race deleted the live holder that had replaced it.
    const foreign = await acquireForeignLock();
    assert.equal(
      await retireLockInstance("a-token-that-owns-nothing"),
      false,
      "a lock instance owned by somebody else was taken",
    );
    assert.equal(
      await readFile(lockDirectory, "utf8").then((value) => JSON.parse(value).token),
      foreign,
      "the live owner's lock was deleted instead of being put back",
    );
    assert.equal(await retireLockInstance(foreign), true, "the instance that was judged was not taken");
    await assert.rejects(access(lockDirectory));
    assert.equal(
      await retireLockInstance(foreign),
      false,
      "a lock that is not there was reported as taken",
    );

    const originalToken = process.env.BACHATA_BRIDGE_ARTIFACT_LOCK_TOKEN;
    delete process.env.BACHATA_BRIDGE_ARTIFACT_LOCK_TOKEN;
    let replacement;
    try {
      await assert.rejects(
        withArtifactLock(async () => {
          // A second run takes over the slot while this one is working: the instance this run
          // owns is gone, and a fresh one with a different owner stands in its place.
          await rm(lockRoot, { recursive: true, force: true });
          replacement = await acquireForeignLock();
        }),
        /ownership changed before release/u,
      );
      assert.equal(
        await readFile(lockDirectory, "utf8").then((value) => JSON.parse(value).token),
        replacement,
        "the release deleted a lock instance that belonged to another owner",
      );
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
      if (originalToken !== undefined) process.env.BACHATA_BRIDGE_ARTIFACT_LOCK_TOKEN = originalToken;
    }
    // No instance may be left held aside under a private name.
    const retiredLeftBehind = (await readdir(lockRoot).catch(() => [])).filter((entry) =>
      entry.startsWith("retired-"));
    assert.deepEqual(retiredLeftBehind, [], "a retired lock instance was left in the repository");
  }

  const firstArchive = path.join(temporary, "first.zip");
  const secondArchive = path.join(temporary, "second.zip");
  await Promise.all([
    run("npm", ["run", "build:base"]),
    run("npm", ["run", "build:generic"]),
    run("npm", ["run", "test:coverage" ]),
    run("npm", ["run", "package"], { ...withoutArtifactLockEnvironment(), BACHATA_BRIDGE_PACKAGE_OUTPUT: firstArchive }),
  ]);
  await run("npm", ["run", "package"], { ...withoutArtifactLockEnvironment(), BACHATA_BRIDGE_PACKAGE_OUTPUT: secondArchive });
  assert.equal(await digest(firstArchive), await digest(secondArchive));
  await assert.rejects(access(lockDirectory));
} finally {
  await removeScratch(temporary);
}
