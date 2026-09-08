/**
 * BB-A4-F21. Two runs must never be inside `dist` at once, however badly the contenders are timed.
 *
 * The lock used to be the directory: `mkdir` took it and `rename` gave it up. That made retirement
 * unsafe by construction, because the rename vacated the shared slot BEFORE anything checked whose
 * lock it had taken. A contender acting on a judgement it made about an earlier owner moved a live
 * holder's lock aside, and a third contender walked into the gap.
 *
 * Both cases here run real contender processes against a temporary working directory:
 * `artifact-lock.mjs` resolves its lock from `process.cwd()`, so the contention is entirely their
 * own and never touches the lock `npm test` is already holding around this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { removeScratch, scratchRoot } from "./support/scratch.mjs";

const modulePath = path.resolve(new URL("../scripts/lib/artifact-lock.mjs", import.meta.url).pathname);

const childEnvironment = () => {
  const environment = { ...process.env };
  delete environment.BACHATA_BRIDGE_ARTIFACT_LOCK_TOKEN;
  return environment;
};

const runScript = (cwd, file, args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [file, ...args], { cwd, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.once("exit", (code) => resolve({ code, output }));
});

/**
 * The contender. Timestamps alone cannot prove exclusion: two sections that overlap by less than
 * the clock's resolution, or whose appends are reordered, read as disjoint. So the section takes
 * an exclusive marker as its first act — a bare `mkdir`, which is the same atomic create-or-fail
 * the lock itself is built on — and releases it as its last. A second entrant inside the same
 * window cannot create it, and says so in the log rather than being inferred from arithmetic.
 */
const holderSource = (module) => `
import { appendFileSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock } from ${JSON.stringify(module)};
const [log, holdMs] = process.argv.slice(2);
const marker = path.resolve(".bachata-critical-section");
try {
  await withArtifactLock(async (token) => {
    let exclusive = false;
    try {
      await mkdir(marker);
      exclusive = true;
    } catch {
      appendFileSync(log, \`overlap \${token} \${String(Date.now())}\\n\`);
    }
    try {
      appendFileSync(log, \`enter \${token} \${String(Date.now())}\\n\`);
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
      appendFileSync(log, \`exit \${token} \${String(Date.now())}\\n\`);
    } finally {
      if (exclusive) await rmdir(marker);
    }
  });
} catch (error) {
  appendFileSync(log, \`error \${String(error?.message ?? error)}\\n\`);
}
`;

/**
 * The delayed contender, standing in the exact window the defect lives in: it judged an earlier
 * owner abandoned and only now acts on that judgement, while a different, live holder is inside
 * its critical section. Meanwhile a third party tries to take the lock as fast as it can.
 */
const delayedSource = (module) => `
import { spawn } from "node:child_process";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { retireLockInstance } from ${JSON.stringify(module)};

const [holder, log] = process.argv.slice(2);
const lockDirectory = path.resolve(".bachata-artifacts.lock");
const ownerPath = path.join(lockDirectory, "owner");
await writeFile(log, "", "utf8");
const environment = { ...process.env };
delete environment.BACHATA_BRIDGE_ARTIFACT_LOCK_TOKEN;
const live = spawn(process.execPath, [holder, log, "900"], { env: environment, stdio: "ignore" });

const ownerToken = async () => {
  try { return JSON.parse(await readFile(ownerPath, "utf8")).token; } catch { return undefined; }
};
// Not merely "an owner": the seeded one is readable from the start, and acting while it still
// stands would be a contender racing the reclaim rather than a live holder.
let held;
for (let attempt = 0; attempt < 600; attempt += 1) {
  held = await ownerToken();
  if (held && held !== "stale-owner-token") break;
  held = undefined;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
if (!held) { console.log(JSON.stringify({ acquired: false })); process.exit(0); }

const proof = path.join(lockDirectory, "owner-intruder.json");
await mkdir(lockDirectory, { recursive: true });
await writeFile(proof, JSON.stringify({ token: "intruder", pid: process.pid }), "utf8");
let intruded = false;
let stop = false;
const intruder = (async () => {
  while (!stop) {
    try {
      await link(proof, ownerPath);
      intruded = true;
      await rm(ownerPath, { force: true });
      return;
    } catch { /* still held, which is the whole point */ }
  }
})();
const retired = await retireLockInstance("stale-owner-token");
stop = true;
await intruder;
await rm(proof, { force: true });
await new Promise((resolve) => live.once("exit", resolve));
const lines = (await readFile(log, "utf8")).split("\\n").filter(Boolean);
console.log(JSON.stringify({ acquired: true, retired, intruded, lines: lines.map((line) => line.split(" ")[0]) }));
`;

const seedAbandonedLock = async (cwd, pid) => {
  const lockDirectory = path.join(cwd, ".bachata-artifacts.lock");
  await rm(lockDirectory, { recursive: true, force: true });
  await mkdir(lockDirectory, { recursive: true });
  const proof = path.join(lockDirectory, "owner-stale-owner-token.json");
  await writeFile(proof, `${JSON.stringify({ token: "stale-owner-token", pid })}\n`, "utf8");
  await link(proof, path.join(lockDirectory, "owner"));
};

/**
 * What a settled lock directory may contain: nothing that names an owner, a holder's proof or a
 * retirement in flight. A leaked `owner` link wedges the next run; a leaked proof or retirement
 * file is a holder or a reclaim that did not finish, and the next contender's judgement is made
 * against whatever they say.
 */
const lockResidue = async (cwd) => {
  const entries = await readdir(path.join(cwd, ".bachata-artifacts.lock")).catch(() => []);
  return entries.filter((entry) =>
    entry === "owner" || entry.startsWith("owner-") || entry.startsWith("retired-")).sort();
};

const criticalSectionResidue = async (cwd) =>
  await readdir(path.join(cwd, ".bachata-critical-section")).then(() => true, () => false);

const deadPid = async () => await new Promise((resolve) => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  child.once("exit", () => resolve(child.pid));
});

test("a contender acting on a stale judgement never vacates a live holder's lock", async (t) => {
  const scratch = await scratchRoot("bachata-bridge-lock-stale-");
  t.after(async () => { await removeScratch(scratch); });
  const holder = path.join(scratch, "holder.mjs");
  const delayed = path.join(scratch, "delayed.mjs");
  await writeFile(holder, holderSource(modulePath), "utf8");
  await writeFile(delayed, delayedSource(modulePath), "utf8");
  await seedAbandonedLock(scratch, await deadPid());

  const result = await runScript(scratch, delayed, [holder, path.join(scratch, "log.txt")]);
  const observed = JSON.parse(result.output.trim().split("\n").at(-1) ?? "{}");
  assert.equal(observed.acquired, true, `no live holder ever took the lock: ${result.output}`);
  assert.deepEqual(observed.lines, ["enter", "exit"], "the live holder did not run its whole section");
  assert.equal(
    observed.retired,
    false,
    "a contender took an instance it had not judged, which is how it reached a live holder's lock",
  );
  assert.equal(
    observed.intruded,
    false,
    "a third contender took the lock while a live holder was still inside its critical section",
  );
  assert.deepEqual(await lockResidue(scratch), [], "the settled lock directory still names an owner");
  assert.equal(await criticalSectionResidue(scratch), false, "the critical-section marker outlived its holder");
});

test("repeated contention over one abandoned lock produces no overlapping critical sections", async (t) => {
  const scratch = await scratchRoot("bachata-bridge-lock-stress-");
  t.after(async () => { await removeScratch(scratch); });
  const holder = path.join(scratch, "holder.mjs");
  await writeFile(holder, holderSource(modulePath), "utf8");
  const pid = await deadPid();
  const contenders = 8;

  for (let round = 0; round < 2; round += 1) {
    const log = path.join(scratch, `log-${String(round)}.txt`);
    await writeFile(log, "", "utf8");
    await seedAbandonedLock(scratch, pid);

    const runs = await Promise.all(
      Array.from({ length: contenders }, () => runScript(scratch, holder, [log, "60"])),
    );
    const failed = runs.filter((run) => run.code !== 0);
    assert.deepEqual(failed, [], `a contender process did not exit cleanly in round ${String(round)}`);

    const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    const kinds = lines.map((line) => line.split(" ")[0]);
    // Every contender is accounted for. Counting only the ones that succeeded would pass a lock
    // that let one run through and wedged the other seven.
    assert.deepEqual(
      kinds.filter((kind) => kind === "error"),
      [],
      `a contender failed to take the lock in round ${String(round)}: ${lines.join(" | ")}`,
    );
    assert.deepEqual(
      kinds.filter((kind) => kind === "overlap"),
      [],
      `two contenders were inside the critical section at once in round ${String(round)}: ${lines.join(" | ")}`,
    );
    assert.equal(
      kinds.filter((kind) => kind === "enter").length,
      contenders,
      `not every contender entered in round ${String(round)}: ${lines.join(" | ")}`,
    );
    assert.equal(
      kinds.filter((kind) => kind === "exit").length,
      contenders,
      `not every contender left its section in round ${String(round)}: ${lines.join(" | ")}`,
    );

    const spans = new Map();
    for (const line of lines) {
      const [kind, token, at] = line.split(" ");
      if (kind === "enter") spans.set(token, { enter: Number(at) });
      if (kind === "exit" && spans.has(token)) spans.get(token).exit = Number(at);
    }
    assert.equal(spans.size, contenders, `contenders shared a token in round ${String(round)}`);
    const ordered = [...spans.values()]
      .filter((span) => span.exit !== undefined)
      .sort((left, right) => left.enter - right.enter);
    assert.equal(ordered.length, contenders, `a contender never finished in round ${String(round)}`);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.ok(
        ordered[index].enter >= ordered[index - 1].exit,
        `two runs were inside the lock at once in round ${String(round)}: ${JSON.stringify(ordered)}`,
      );
    }

    assert.deepEqual(
      await lockResidue(scratch),
      [],
      `the lock directory still names an owner after round ${String(round)}`,
    );
    assert.equal(
      await criticalSectionResidue(scratch),
      false,
      `the critical-section marker outlived round ${String(round)}`,
    );
  }
});
