import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const tokenEnvironmentName = "BACHATA_BRIDGE_ARTIFACT_LOCK_TOKEN";
const lockDirectory = path.resolve(".bachata-artifacts.lock");
/**
 * BB-A4-F21. The lock is the `owner` link, not the directory.
 *
 * The directory used to be the mutual-exclusion object: `mkdir` took it and `rename` gave it up.
 * That made the retire unsafe by construction, because the rename vacated the shared slot BEFORE
 * anything checked whose lock it had taken — a delayed contender acting on a judgement it made
 * about an earlier owner moved a live holder's lock aside, and a third contender's `mkdir`
 * succeeded into the gap. Reproduced deterministically: five runs out of five, `retired=false`
 * (the contender correctly declined the instance) with `intruded=true` (a third party held the
 * slot anyway) while the real holder was still inside its critical section.
 *
 * So the object is now a hard link. `owner` is linked to the holder's own proof file, and
 * retiring renames THE PROOF, not the link. Renaming a hard-linked file does not unlink `owner`:
 * the slot stays occupied for every waiter, and only the caller whose rename succeeded — at most
 * one, and only while that token still holds — may unlink it. A stale contender's rename fails
 * `ENOENT` and it has touched nothing, so no contender can ever remove or relocate a live
 * holder's canonical lock.
 */
const ownerPath = path.join(lockDirectory, "owner");
const proofPath = (token) => path.join(lockDirectory, `owner-${token}.json`);
const retryMs = 50;
const timeoutMs = 300_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const readOwnerAt = async (file) => {
  try {
    const owner = JSON.parse(await readFile(file, "utf8"));
    return typeof owner.token === "string" ? owner : undefined;
  } catch {
    return undefined;
  }
};

const readOwner = async () => readOwnerAt(ownerPath);

const errorCode = (error) =>
  error instanceof Error && Reflect.has(error, "code") ? Reflect.get(error, "code") : undefined;

/**
 * BR-G6-21. Take exactly the lock instance that was judged, or take nothing.
 *
 * Removing the directory in place is not that. Between reading an owner and deleting the
 * directory it named, another waiter can reclaim, `mkdir` and write its own owner — and the
 * recursive delete then removes a *live* holder's lock, without failing, letting two runs into
 * `dist` at once. A rename is atomic: whatever ends up under the private name is one whole
 * instance, and its owner file says which. An instance that turns out not to be the one judged
 * is put straight back.
 */
export const retireLockInstance = async (expected) => {
  if (typeof expected !== "string" || expected.length === 0) {
    // Nothing to name, so nothing may be taken. The unowned-directory case the old signature
    // carried cannot arise any more: `owner` is only ever created by a completed `link`.
    return false;
  }
  const retired = path.join(lockDirectory, `retired-${randomUUID()}.json`);
  try {
    // The rename IS the check. A proof named for a token that no longer holds the lock is not
    // there to be taken, and `owner` stays linked throughout, so the slot is never observably
    // free to a waiter while a holder is live.
    await rename(proofPath(expected), retired);
  } catch {
    return false;
  }
  const held = (await readOwnerToken()) === expected;
  if (held) {
    await rm(ownerPath, { force: true });
  }
  await rm(retired, { force: true });
  return held;
};

const readOwnerToken = async () => (await readOwner())?.token;

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(error, "code") === "EPERM";
  }
};

// This lock serialises `dist` producers and consumers inside one repository. Unlike the
// extension worktree lock — which guards a human's uncommitted work and is deliberately
// never reclaimed — a build lock whose holder was killed must be recoverable, or a single
// cancelled CI job or interrupted run wedges the repository for good. The owner records its
// pid so a dead one can be identified rather than merely waited out.
//
// A directory with no readable owner is the half-initialised state: created between `mkdir`
// and the owner write. It is reclaimed only after a grace period, so a live holder that is
// simply slow to write its owner file is never stolen from.
const abandonedOwnerGraceMs = 5_000;

// `unownedSince` must track how long *this* lock instance has looked unowned, not how long
// the caller has been waiting. Measuring from the waiter's own start meant a process queued
// behind a long build would pass the grace period and then reclaim the very next holder if
// it happened to look between that holder's `mkdir` and its owner write — stealing a live
// lock and letting two runs into `dist` at once. It resets whenever an owner is readable.
const reclaimIfAbandoned = async (state) => {
  const owner = await readOwner();
  if (!owner) {
    // BB-A4-F21. A holder writes its record in full and only then links it, so an `owner` that
    // cannot be read names nobody: it is a corrupted file rather than a lock being taken. It is
    // still only removed after the grace period, so a filesystem that is briefly answering
    // strangely does not cost a live holder its lock.
    state.unownedSince ??= Date.now();
    if (Date.now() - state.unownedSince < abandonedOwnerGraceMs) return false;
    await rm(ownerPath, { force: true });
    state.unownedSince = undefined;
    return true;
  }
  state.unownedSince = undefined;
  if (processIsAlive(owner.pid)) return false;
  return await retireLockInstance(owner.token);
};

const acquireRootLock = async () => {
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const reclaimState = { unownedSince: undefined };
  await mkdir(lockDirectory, { recursive: true });
  // Written in full before it is linked, so `owner` never names a half-written record and the
  // half-initialised state the grace period existed for cannot occur.
  await writeFile(proofPath(token), `${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
  while (true) {
    try {
      await link(proofPath(token), ownerPath);
      return token;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        await rm(proofPath(token), { force: true });
        throw error;
      }
      if (Date.now() >= deadline) {
        await rm(proofPath(token), { force: true });
        throw new Error(`Timed out waiting for the repository artifact lock at ${lockDirectory}`);
      }
      await reclaimIfAbandoned(reclaimState);
      await delay(retryMs);
    }
  }
};

export const artifactLockEnvironment = (token) => ({
  ...process.env,
  [tokenEnvironmentName]: token,
});

export const withoutArtifactLockEnvironment = () => {
  const environment = { ...process.env };
  delete environment[tokenEnvironmentName];
  return environment;
};

export const withArtifactLock = async (run) => {
  const inheritedToken = process.env[tokenEnvironmentName];
  if (inheritedToken) {
    if (await readOwnerToken() !== inheritedToken) {
      throw new Error("Inherited artifact lock token does not own the repository lock");
    }
    return run(inheritedToken);
  }

  const token = await acquireRootLock();
  try {
    return await run(token);
  } finally {
    // BR-G6-21. The release removes the instance this run owns, by the same rename, so a lock
    // that changed hands between the check and the removal is not deleted out from under its
    // new owner.
    if (!(await retireLockInstance(token))) {
      throw new Error("Artifact lock ownership changed before release");
    }
  }
};
