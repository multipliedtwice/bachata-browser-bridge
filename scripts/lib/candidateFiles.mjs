import { spawnSync } from "node:child_process";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat as lstatEntry, open as openEntry } from "node:fs/promises";
import path from "node:path";

import { containmentStatement, escapesRoot, symlinkAncestorProblem } from "./containment.mjs";

/**
 * NUL is written as an escape and never as a literal byte.
 *
 * A literal NUL in a source file makes that file binary to everything that sniffs content:
 * `file` reports `data`, `grep` reports "binary file matches" instead of the matching line, `git
 * diff` refuses to show it, and an editor may offer to open it as a hex dump. The separator this
 * module parses is a NUL byte; the six characters that express it in source are the escape below.
 */
const NUL = "\u0000";

const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * One `git ls-files` listing, deduplicated and sorted by code unit so two runs over one tree
 * report the same paths in the same order.
 *
 * `-z` is not optional. A newline-separated listing quotes and re-encodes any path with a space,
 * a quote or a non-ASCII byte in it, and a gate that read those back as literal filenames would
 * skip exactly the files whose names it could not parse. NUL-separated output is the raw byte
 * path, and NUL is the one byte a path may not contain.
 *
 * `undefined` means Git could not answer. It is never an empty listing: a gate that treated a
 * failure as "nothing to check" would report success over a tree it never read.
 */
const gitListing = (root, args, run) => {
  const result = run("git", ["ls-files", ...args, "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const seen = new Set(result.stdout.split(NUL).filter((entry) => entry.length > 0));
  return [...seen].sort(byCodeUnit);
};

/**
 * Which files a gate is answerable for.
 *
 * `git ls-files` alone lists what is tracked, and nothing else. A gate built on it passes over
 * every file that has been written but not yet added — which is every file at the moment it is
 * most likely to carry the mistake the gate exists to catch. So the candidate set is the tracked
 * files plus the untracked files Git does not ignore: `--cached` for the first, `--others` for
 * the second, `--exclude-standard` so generated output under `.gitignore` stays out.
 *
 * `run` is a parameter so the enumeration can be driven against a scratch repository, or against
 * a failing `git`, without a checkout arranged to match.
 */
export const candidateFiles = (root, run = spawnSync) =>
  gitListing(root, ["--cached", "--others", "--exclude-standard"], run);

/**
 * The paths Git records as tracked but absent from the working tree.
 *
 * `--cached` lists index entries, so a file deleted from the working tree and not yet staged is
 * still enumerated as a candidate and still fails to open. That is an ordinary working state, not
 * a gate failure — but "a tracked file that was deleted" and "a file that vanished while the gate
 * was running" produce the same `ENOENT`, and only Git can tell them apart. Reading this set is
 * what makes the difference statable instead of assumed.
 */
export const trackedDeletions = (root, run = spawnSync) => {
  const listed = gitListing(root, ["--deleted"], run);
  return listed === undefined ? undefined : new Set(listed);
};

const errorCode = (error) =>
  typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * A path as it may be printed.
 *
 * A path is a byte string, and a newline is a legal byte in one. A gate that prints one finding
 * per line and interpolates the path raw lets a filename write further lines of the gate's own
 * output — including a line that reads like a passing result. Any path carrying a control
 * character is therefore quoted and escaped; every ordinary path, spaces, quotes and non-ASCII
 * characters included, is printed as it is so a person can paste it back.
 */
export const displayPath = (relative) =>
  CONTROL_CHARACTER.test(relative) ? JSON.stringify(relative) : relative;

/**
 * Reading a candidate without leaving the repository.
 *
 * Both gates joined `root` to the enumerated path and read it. A path Git enumerates is a name in
 * the repository, but the bytes behind that name need not be, and there are two separate ways for
 * it to leave the tree.
 *
 * THE FINAL COMPONENT. A tracked symbolic link is an index entry of mode 120000 whose content is
 * a target path, and `readFile` follows it. A tracked or merely unignored `src/linked.mjs`
 * pointing at `../../outside.mjs` therefore made a gate read, report on and quote a file outside
 * the tree it is answerable for — proved by a scratch repository in which the format gate
 * reported the outside target's trailing whitespace under the in-repository name.
 *
 * AN ANCESTOR OF IT. `git ls-files --cached` reads names out of the index, so Git never descends
 * the working tree for a tracked path to be enumerated. Replace the real `src/` directory with a
 * symbolic link to somewhere else and `src/tracked.mjs` is still listed, still opens, and now
 * names a file outside the repository — with no link on the final component for `O_NOFOLLOW` to
 * catch. This was reproduced against the version of this module that inspected the final
 * component only, in the same way and with the same result. That `--others` does not descend a
 * linked directory is true and is not sufficient: `--cached` does not have to.
 *
 * So containment is answered for the whole path — the owned root, then every existing component
 * between it and the candidate, then the candidate itself — and a refusal is named rather than
 * silent: a candidate the gate declined to read is a finding, exactly as an unreadable one
 * already was. The root-and-ancestor half of the question is the one `scripts/lib/containment.mjs`
 * already answers for this repository's cleanup paths, and it is asked through that module rather
 * than restated here, so "outside the owned root" has one definition and not a second.
 *
 * ATOMICITY, STATED EXACTLY, BECAUSE IT DIFFERS BY COMPONENT AND BY PLATFORM.
 *
 * Four defences apply in order, and only the third is atomic:
 *
 *   1. The owned root is resolved and required to be its own canonical path, and every existing
 *      component between it and the candidate is `lstat`ed and refused if it is a link. Node
 *      exposes no `openat`, so this walk cannot be fused to the open that follows it: it is a
 *      check separate from the use, and an ancestor swapped for a link after the walk and before
 *      the open is NOT caught. Ancestor containment is best-effort on every platform, and is not
 *      claimed to be race-free.
 *   2. `lstat` describes the candidate's own name without following it, and a symbolic link — or
 *      any other entry that is not a regular file — is refused there. Same separate-check window
 *      as 1, and on Windows it is the only final-component link defence.
 *   3. The open passes `O_NOFOLLOW`, so a final-component symlink fails the open itself with
 *      `ELOOP`. There is no window here, because there is no separate check to race — this closes
 *      the window left by 2, for the final component only. `O_NOFOLLOW` is POSIX and is NOT
 *      defined on Windows, where the flag degrades to zero and the `lstat` of 2 stands alone.
 *   4. `fstat` on the returned handle describes the object actually opened rather than a path, so
 *      whatever the name resolved to, an entry that is not a regular file is refused before a
 *      byte of it is read. This holds on every platform.
 *
 * So: final-component symlink refusal is race-free on POSIX and best-effort on Windows; ancestor
 * and root refusal is best-effort everywhere; non-regular refusal at 4 is race-free everywhere.
 *
 * 2 is not a duplicate of 4. An `fstat` refusal requires the open to have succeeded and to have
 * behaved the same way everywhere, and a directory, a FIFO or a device node does not open
 * identically on Windows and on POSIX. Naming the type from the `lstat` refuses it without
 * depending on that.
 *
 * `O_NONBLOCK` is not decoration. Opening a FIFO for reading blocks until a writer arrives, so a
 * single named pipe anywhere in the candidate set would hang the gate forever rather than fail
 * it; with the flag the open returns, `fstat` names the entry a FIFO and it is refused.
 *
 * A component that is genuinely absent is not a containment problem and is not reported as one:
 * the walk answers nothing, the open fails with `ENOENT`, and `inspectCandidates` separates a
 * tracked deletion from a tree that changed mid-run exactly as it did before. Every other
 * inspection failure — `EACCES`, `EIO`, `ELOOP`, an error carrying no code at all — leaves the
 * containment question unanswered, and an unanswered question is a refusal.
 */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/**
 * Whether the open itself refuses a symbolic link, which is what makes the final component's
 * refusal race-free. False on Windows, where the preceding `lstat` is the only link defence.
 * Ancestor containment is a separate check on every platform and this says nothing about it.
 */
export const symlinkRefusalIsAtomic = NO_FOLLOW !== 0;

/**
 * A refusal is a decision, not a failure to read. It carries its own reason so `inspectCandidates`
 * counts it apart from an unexpected error and from a tracked deletion.
 */
const refusal = (reason) => Object.assign(new Error(reason), { candidateRefusal: reason });

const refusalReason = (error) =>
  typeof error === "object" && error !== null && typeof error.candidateRefusal === "string"
    ? error.candidateRefusal
    : "";

const SYMBOLIC_LINK = "is a symbolic link, and a gate does not read through one to bytes outside the tree it is answerable for";

const OUTSIDE_ROOT = "resolves outside the repository the gate is answerable for";

const entryKind = (stats) =>
  stats.isDirectory()
    ? "a directory"
    : stats.isFIFO()
      ? "a FIFO"
      : stats.isSocket()
        ? "a socket"
        : stats.isBlockDevice()
          ? "a block device"
          : stats.isCharacterDevice()
            ? "a character device"
            : "not a regular file";

/**
 * The `read` a gate hands to `inspectCandidates`: the contents of an enumerated path, or a refusal.
 *
 * `open`, `lstat`, `inspectAncestor` and `resolveReal` are parameters so every step of the
 * containment can be driven against injected failures without a filesystem arranged to produce
 * them.
 */
export const containedReader = ({
  root,
  open = openEntry,
  lstat = lstatEntry,
  inspectAncestor = lstatSync,
  resolveReal = realpathSync,
}) =>
  async (relative) => {
    const absolute = path.join(root, relative);
    if (escapesRoot(root, absolute)) throw refusal(OUTSIDE_ROOT);
    const contained = symlinkAncestorProblem(root, absolute, inspectAncestor, resolveReal);
    if (contained) throw refusal(containmentStatement(contained));
    const named = await lstat(absolute);
    if (named.isSymbolicLink()) throw refusal(SYMBOLIC_LINK);
    if (!named.isFile()) throw refusal(`is ${entryKind(named)}, and a gate reads regular files`);
    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw refusal(SYMBOLIC_LINK);
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw refusal(`is ${entryKind(stats)}, and a gate reads regular files`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  };

/**
 * What a gate actually read, counted rather than assumed.
 *
 * The count a gate reported used to be the length of the enumeration, which is neither the number
 * of files it was answerable for nor the number it read: each gate checks one set of extensions,
 * and each gate skipped, silently, every file it could not open. So "Lint checked 537 candidate
 * files" was false in both directions at once, and an unreadable file — the one most likely to be
 * carrying the problem — disappeared from the result entirely.
 *
 * The counts close arithmetically: `enumerated` is the whole candidate set, `ineligible` is what
 * this gate does not check by extension, and `eligible` is the rest, which is exactly `checked`
 * plus `trackedDeletions` plus `unreadable` plus `refused`.
 *
 * Failures are returned as problems rather than swallowed. An unexpected read error fails the
 * gate; a tracked deletion does not, because Git states that the file is meant to be absent; a
 * candidate that vanished with no tracked deletion behind it is reported as a tree that changed
 * mid-run, which is a third fact and not either of the first two; and a candidate the reader
 * declined to open — a symbolic link, or an entry that is not a regular file — is a fourth, named
 * as a refusal rather than counted as something the gate read.
 */
export const inspectCandidates = async ({ files, deletions, eligible, read }) => {
  const counts = {
    enumerated: files.length,
    eligible: 0,
    checked: 0,
    ineligible: 0,
    trackedDeletions: 0,
    unreadable: 0,
    refused: 0,
  };
  const problems = [];
  const inspected = [];
  for (const relative of files) {
    if (!eligible(relative)) {
      counts.ineligible += 1;
      continue;
    }
    counts.eligible += 1;
    let contents;
    try {
      contents = await read(relative);
    } catch (error) {
      const declined = refusalReason(error);
      if (declined) {
        counts.refused += 1;
        problems.push(`${displayPath(relative)}: ${declined}`);
        continue;
      }
      const code = errorCode(error);
      if (code === "ENOENT" && deletions.has(relative)) {
        counts.trackedDeletions += 1;
        continue;
      }
      counts.unreadable += 1;
      problems.push(
        code === "ENOENT"
          ? `${displayPath(relative)}: enumerated as a candidate and then absent, and Git records no tracked deletion for it — the tree changed while the gate was running`
          : `${displayPath(relative)}: could not be read (${code || "no error code"})`,
      );
      continue;
    }
    counts.checked += 1;
    inspected.push({ relative, contents });
  }
  return { counts, problems, inspected };
};

/** What a gate says it covered, in the terms it can actually stand behind. */
export const candidateSummary = (counts) =>
  [
    `${String(counts.checked)} of ${String(counts.eligible)} eligible file(s)`,
    `out of ${String(counts.enumerated)} candidates (tracked and unignored untracked)`,
    `${String(counts.ineligible)} skipped as ineligible`,
    ...(counts.trackedDeletions > 0 ? [`${String(counts.trackedDeletions)} tracked deletion(s) skipped`] : []),
    ...(counts.unreadable > 0 ? [`${String(counts.unreadable)} unreadable`] : []),
    ...(counts.refused > 0 ? [`${String(counts.refused)} refused`] : []),
  ].join(", ");
