// Deterministic format check. Whitespace only, and only the properties that change how a
// file is read or diffed: no carriage returns, no tab indentation, no trailing whitespace,
// exactly one terminating newline. It rewrites nothing and depends on nothing outside Node,
// so it produces the same verdict on every machine and in CI.
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  candidateFiles,
  candidateSummary,
  containedReader,
  displayPath,
  inspectCandidates,
  trackedDeletions,
} from "./lib/candidateFiles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkedExtensions = /\.(?:ts|mts|cts|mjs|cjs|js|json|yml|yaml)$/u;

const problems = (contents) => {
  const found = [];
  if (contents.length === 0) return found;
  if (contents.includes("\r")) found.push("carriage return");
  if (!contents.endsWith("\n")) found.push("no terminating newline");
  if (/\n\n+$/u.test(contents)) found.push("blank line at end of file");
  contents.split("\n").forEach((line, index) => {
    if (/[ \t]+$/u.test(line)) found.push(`trailing whitespace on line ${String(index + 1)}`);
    if (/^\t/u.test(line)) found.push(`tab indentation on line ${String(index + 1)}`);
  });
  return found;
};

const files = candidateFiles(root);
if (!files) {
  throw new Error("format check requires a Git checkout to enumerate the files it is answerable for");
}
// A tracked file deleted from the working tree is still an index entry, so it is still a
// candidate and still fails to open. Git is what separates that from a file that vanished while
// the gate was running, and a gate that could not ask is a gate that cannot classify its own
// read failures — so it refuses rather than guessing.
const deletions = trackedDeletions(root);
if (!deletions) {
  throw new Error("format check requires a Git checkout to tell a tracked deletion from a candidate that vanished mid-run");
}

const { counts, problems: unreadable, inspected } = await inspectCandidates({
  files,
  deletions,
  eligible: (relative) => checkedExtensions.test(relative),
  read: containedReader({ root }),
});

// A file this gate could not read is a finding, not a silence.
const findings = unreadable.map((problem) => `${problem} — not checked`);
for (const { relative, contents } of inspected) {
  // At most a few per file: a file with one systemic problem should not bury the others.
  for (const problem of problems(contents).slice(0, 5)) {
    findings.push(`${displayPath(relative)}: ${problem}`);
  }
}

if (findings.length > 0) {
  console.error(`Format check found ${String(findings.length)} problem(s):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Format check passed for ${candidateSummary(counts)}.`);
}
