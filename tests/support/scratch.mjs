import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { nonCanonicalTarget, symlinkAncestorProblem } from "../../scripts/lib/containment.mjs";

/**
 * SAFETY. Where a test is allowed to delete.
 *
 * Every scratch directory in this suite is created here and removed here. A test that resolved
 * its own cleanup target could delete the temporary directory itself, or its parent, or the
 * working tree, by one wrong join — `path.join(root, "..")` is one character away from correct
 * and reads as correct. So the only removal a test performs goes through `removeScratch`, and
 * `removeScratch` refuses anything that is not a directory this module handed out or a checked
 * descendant of one.
 *
 * The rule is deliberately not "inside the temporary directory". The temporary directory is
 * shared with every other process on the machine, and `os.tmpdir()` itself, its parent and an
 * unresolved environment variable are the three targets that turn a cleanup into an incident.
 *
 * SAFETY. Lexical containment is not containment. `path.resolve` collapses `..` and nothing
 * else: if `root/link` is a symlink to somewhere else, `root/link/victim` stays lexically inside
 * `root` while naming a file outside it, and a guard built from string prefixes hands that path
 * to a recursive remover. Comparing `path.resolve(target)` with `path.normalize(target)` does not
 * close that hole either — the two agree on every absolute path that has no trailing separator,
 * and they agree on `/root/a/../victim` and `/root/./victim` too, because both collapse those. So
 * the guard reads the filesystem: every directory between an owned root and the target must be a
 * real directory, not a link, and the owned root must itself be canonical. The target's own final
 * segment is exempt, because removing a symlink removes the link.
 *
 * SAFETY. The check and the removal are separate calls, so an interval remains between them in
 * which the filesystem could change. Nothing here closes it. What is closed is a target that
 * already named something outside the owned root when it was checked; the threat model is this
 * suite's own symlink fixtures and a cleanup that would follow one out, not a racing adversary.
 */

const owned = new Set();

const tmpBase = async () => await realpath(os.tmpdir());

/**
 * SAFETY. `mkdtemp` appends six characters to whatever it is handed and creates the result. A
 * prefix carrying a separator therefore creates a directory somewhere other than the base it was
 * joined to, and an absolute prefix ignores the base outright.
 */
export const scratchPrefixProblem = (prefix) => {
  if (typeof prefix !== "string" || prefix.length === 0) return "a scratch prefix must be a non-empty string";
  if (path.isAbsolute(prefix)) return `a scratch prefix must not be absolute: ${prefix}`;
  if (prefix.includes("/") || prefix.includes("\\") || prefix.includes(path.sep)) {
    return `a scratch prefix must not contain a path separator: ${prefix}`;
  }
  if (prefix === "." || prefix === "..") return `a scratch prefix must not be a directory reference: ${prefix}`;
  return undefined;
};

const owningRoot = (resolved, roots) =>
  [...roots].find((candidate) => resolved === candidate || resolved.startsWith(`${candidate}${path.sep}`));

/**
 * SAFETY. The target must already be what it resolves to.
 *
 * The rule is exact equality with `path.resolve(target)`, not agreement between `resolve` and
 * `normalize`. Those two agree on `/root/a/../victim`, on `/root/./victim` and on `/root//victim`,
 * so the old comparison only ever caught a trailing separator. Requiring the caller's own string
 * to be the canonical absolute path means the path the guard reasons about and the path the
 * remover is handed are the same characters.
 *
 * Trailing separator policy, stated rather than implied: a trailing separator is refused.
 * `path.resolve` strips it, so a root written with one and a root written without one would be
 * checked as a single path and written as two different strings, and a rule that silently
 * accepted one spelling of a path would have to be trusted to accept every other spelling too.
 */
export const scratchProblem = (target, base, roots = owned) => {
  if (typeof target !== "string" || target.length === 0) return "a scratch target must be a non-empty path";
  if (!path.isAbsolute(target)) return `a scratch target must be absolute: ${target}`;
  if (nonCanonicalTarget(target)) {
    return `a scratch target must be its own canonical absolute path, with no ".", "..", repeated or trailing separator: ${target}`;
  }
  const resolved = path.resolve(target);
  if (resolved === base || resolved === path.dirname(base)) return `a scratch target may not be the temporary directory: ${target}`;
  if (!resolved.startsWith(`${base}${path.sep}`)) return `a scratch target must be inside the temporary directory: ${target}`;
  if (!owningRoot(resolved, roots)) return `a scratch target must be a directory this run created: ${target}`;
  return undefined;
};

/**
 * SAFETY. The half of the check that a string cannot answer, delegated to the one primitive the
 * repository has for it — the same one `scripts/clean-dist.mjs` uses, so a cleanup and a build
 * answer "is this inside the root" the same way.
 *
 * An inspection that failed is a refusal, not a pass: only `ENOENT` and `ENOTDIR` mean the path
 * is genuinely not there, and every other failure leaves the question unanswered.
 */
export const scratchTraversalProblem = (
  target,
  roots = owned,
  lstat = lstatSync,
  resolveReal = realpathSync,
) => {
  const resolved = path.resolve(target);
  const root = owningRoot(resolved, roots);
  if (root === undefined) return undefined;
  const problem = symlinkAncestorProblem(root, resolved, lstat, resolveReal);
  if (problem === undefined) return undefined;
  if (problem.reason === "unreadable") {
    return problem.kind === "root"
      ? `a scratch target's root could not be inspected (${problem.code || "no error code"}): ${problem.path}`
      : `a scratch target's ancestor could not be inspected (${problem.code || "no error code"}): ${problem.path}`;
  }
  return problem.kind === "root"
    ? `a scratch target's root is reached through a symlink: ${problem.path}`
    : `a scratch target is reached through a symlink: ${problem.path}`;
};

export const scratchContainmentProblem = (
  target,
  base,
  roots = owned,
  lstat = lstatSync,
  resolveReal = realpathSync,
) => scratchProblem(target, base, roots) ?? scratchTraversalProblem(target, roots, lstat, resolveReal);

export const scratchRoot = async (prefix) => {
  const prefixProblem = scratchPrefixProblem(prefix);
  if (prefixProblem) throw new Error(prefixProblem);
  const base = await tmpBase();
  const root = await mkdtemp(path.join(base, prefix));
  owned.add(root);
  return root;
};

export const scratchChild = (root, ...segments) => {
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`a scratch child escapes its root: ${segments.join("/")}`);
  }
  return target;
};

/**
 * SAFETY. Creation is checked the same way removal is. `mkdir` with `recursive` follows a symlink
 * ancestor exactly as `rm` does, so a scratch child built under a redirected directory would write
 * outside the owned root — and a later cleanup would then be asked to delete what it wrote.
 */
export const makeScratchChild = async (root, ...segments) => {
  const target = scratchChild(root, ...segments);
  const problem = scratchTraversalProblem(target, new Set([path.resolve(root)]));
  if (problem) throw new Error(problem);
  await mkdir(target, { recursive: true });
  return target;
};

/**
 * SAFETY. The removal a test is allowed to perform. The target is checked against the roots this
 * module created before the remover is called even once, and the remover is a parameter so the
 * refusal path can be proved without a filesystem behind it.
 */
export const removeScratch = async (target, remove = (entry) => rm(entry, { recursive: true, force: true })) => {
  const base = await tmpBase();
  const problem = scratchContainmentProblem(target, base);
  if (problem) throw new Error(problem);
  await remove(target);
  owned.delete(path.resolve(target));
};

export const scratchBase = tmpBase;
export const ownedRoots = () => new Set(owned);
