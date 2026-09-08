import { rm } from "node:fs/promises";
import path from "node:path";

import { containmentStatement, symlinkAncestorProblem } from "./lib/containment.mjs";

/**
 * REVIEW-11. What `clean` is allowed to delete.
 *
 * One generated directory, resolved against the package root and never outside it. Named and
 * checked rather than inlined because this is the only script in the repository whose whole job
 * is to remove files: a target that escaped the root would delete maintained source, and the
 * check that it cannot is worth more than the line it costs.
 *
 * REVIEW-11. The name list is a parameter with the real default, so the guard can be driven with
 * the names a bad edit would introduce instead of being reproduced in a test — a reproduction
 * proves the test's copy of the rule, not this one.
 */
export const generatedDirectories = ["dist"];

export const generatedTargets = (
  root = path.resolve(),
  names = generatedDirectories,
  contained = symlinkAncestorProblem,
) => {
  const rootReal = path.resolve(root);
  return names.map((name) => {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`Clean target escapes the package root: ${String(name)}`);
    }
    const target = path.resolve(rootReal, name);
    if (target === rootReal || !target.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`Clean target escapes the package root: ${name}`);
    }
    // SAFETY. A name may name a directory under a symbolic link — `build/out` where `build`
    // points elsewhere — and that target is lexically inside the package root while naming
    // something outside it. The link `dist` itself stays removable, because `rm` unlinks a
    // symbolic link rather than following it; what is refused is deleting *through* one.
    //
    // SAFETY. An inspection that failed is refused as well. A `dist` whose parent could not be
    // read is not a `dist` this script knows to be inside the package root, and `clean` deletes
    // recursively: the cost of refusing an unreadable path is a failed build, and the cost of
    // accepting one is a deletion outside the package.
    const problem = contained(rootReal, target);
    if (problem) {
      throw new Error(
        `Clean target escapes the package root: ${name} — ${containmentStatement(problem)}`,
      );
    }
    return target;
  });
};

/**
 * SAFETY. The remover is a parameter so that the guard can be proved against a recorder rather
 * than against the filesystem. A test that disabled the guard and then called the real `rm` would
 * be a real deletion with a real blast radius; a test that passes a recorder observes exactly
 * which targets a run would have removed, and in which order, without removing anything.
 */
const removeRecursively = (target) => rm(target, { recursive: true, force: true });

export const cleanGenerated = async (root, names, remove = removeRecursively) => {
  // Every name is resolved and checked before the first removal, so one bad name stops the run
  // instead of stopping it halfway through a list.
  const targets = generatedTargets(root, names);
  for (const target of targets) {
    await remove(target);
  }
  return targets;
};

// Running this file cleans; importing it does not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await cleanGenerated();
}
