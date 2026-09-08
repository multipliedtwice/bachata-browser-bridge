import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * SAFETY. Lexical containment is not containment.
 *
 * `path.resolve` collapses `..` and nothing else. If `root/link` is a symbolic link to somewhere
 * else, `root/link/victim` starts with `root` as a string while naming a file outside it, so a
 * guard built from string prefixes hands that path to whatever removes or writes it. Comparing
 * `path.resolve(target)` with `path.normalize(target)` does not close that hole either: the two
 * agree on every absolute path without a trailing separator, symlink or not, and they agree on
 * `/root/a/../victim` and `/root/./victim` as well, because both functions collapse those.
 *
 * So the containment question is answered from the filesystem. Every directory between the owned
 * root and the target must be a real directory rather than a link, and the root must itself be
 * canonical. The target's own last segment is never inspected, because removing a symbolic link
 * removes the link, and refusing that would forbid a legitimate cleanup.
 *
 * SAFETY. An inspection that fails answers nothing, and an unanswered containment question is a
 * refusal. `ENOENT` and `ENOTDIR` are the only two failures that state something: the path is
 * not there, so nothing below it can be traversed and nothing below it exists to remove. Every
 * other failure — `EACCES`, `EIO`, `ELOOP`, `ENAMETOOLONG`, a malformed path, an error carrying
 * no code at all — means the walk could not see what is there, and a walk that cannot see refuses
 * rather than authorizing a removal. Treating those as "missing" is what made permission and I/O
 * errors authorize deletion.
 *
 * SAFETY. This is not race-free. Between the inspection here and the mutation a caller performs
 * there is an interval in which the filesystem can change, and nothing in this module closes it —
 * `lstat` and `rm` are separate calls. What it does close is the case where the path a caller
 * computed already named something outside the owned root at the moment it was checked. The
 * threat model is a local test scratch tree whose own fixtures create symbolic links, and a
 * cleanup that would otherwise follow one out of the directory the run created; it is not an
 * adversary racing the process.
 *
 * `lstat` and `realpath` are parameters so a caller can drive the walk from a table instead of
 * from a filesystem shaped to match.
 *
 * The answer is `undefined`, or a named problem: `kind` says whether the root or an ancestor was
 * at fault, `reason` says whether it was a link or an inspection that failed, `path` names it,
 * and an `unreadable` problem carries the `code` the failure reported. Callers word their own
 * refusal, because "a scratch target" and "a clean target" are not the same sentence.
 */

/** The two failures that mean "not there" rather than "could not look". */
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

const errorCode = (error) =>
  typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "";

const isMissing = (error) => MISSING_CODES.has(errorCode(error));

/** The one shape a target may take: its own canonical absolute path, trailing separator included. */
export const nonCanonicalTarget = (target) =>
  typeof target !== "string" || target.length === 0 || !path.isAbsolute(target)
    ? true
    : path.resolve(target) !== target;

/**
 * Whether a target lies outside the owned root by name alone.
 *
 * The one place this repository decides what "outside" means, so the walk below and any caller
 * that needs only the lexical answer cannot drift apart. It is a name comparison and nothing
 * more: a path inside the root by name may still resolve outside it through a link, which is what
 * the walk is for. A relative path that is itself absolute is the Windows case of two different
 * volumes, where no relative name from one reaches the other.
 */
export const escapesRoot = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.startsWith("..") || path.isAbsolute(relative);
};

export const symlinkAncestorProblem = (
  root,
  target,
  lstat = lstatSync,
  resolveReal = realpathSync,
) => {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(target);
  let rootReal;
  try {
    rootReal = resolveReal(rootResolved);
  } catch (error) {
    // A root that is not there has nothing under it to traverse and nothing under it to remove.
    // Any other failure left the question unanswered.
    if (isMissing(error)) return undefined;
    return { kind: "root", reason: "unreadable", path: rootResolved, code: errorCode(error) };
  }
  if (rootReal !== rootResolved) return { kind: "root", reason: "symlink", path: rootResolved };
  if (escapesRoot(rootResolved, resolved)) return undefined;
  const segments = path.relative(rootResolved, resolved).split(path.sep);
  let current = rootResolved;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = lstat(current);
    } catch (error) {
      if (isMissing(error)) return undefined;
      return { kind: "ancestor", reason: "unreadable", path: current, code: errorCode(error) };
    }
    if (stats.isSymbolicLink()) return { kind: "ancestor", reason: "symlink", path: current };
  }
  return undefined;
};

/** One sentence for a problem, for callers with nothing more specific to say. */
export const containmentStatement = (problem) =>
  problem.reason === "symlink"
    ? `${problem.kind === "root" ? "the owned root" : "an ancestor"} is a symbolic link: ${problem.path}`
    : `${problem.kind === "root" ? "the owned root" : "an ancestor"} could not be inspected (${problem.code || "no error code"}): ${problem.path}`;
