// Minimal correctness lint. It is deliberately not a general style engine: every rule below
// is a correctness or policy rule this repository already states in prose, made checkable.
// No new dependency is introduced, because a gate that cannot run offline from the committed
// lockfile is not a gate this project can rely on.
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

// Rules match code, not prose. A repository that documents its own policy in strings — and
// this one sends "avoid `as any`" to agents as instruction text — would otherwise report its
// own documentation as a violation. Comments and string bodies are blanked to spaces first,
// which keeps every offset, and therefore every reported line number, exact.
const project = (source, keep) => {
  const out = source.split("");
  let index = 0;
  // `keep` names which half survives: "code" blanks comments and string bodies, "comments"
  // blanks everything else. Offsets are preserved either way, so reported line numbers stay
  // exact.
  const blankRange = (start, end) => {
    for (let cursor = start; cursor < end && cursor < out.length; cursor += 1) {
      if (out[cursor] !== "\n") out[cursor] = " ";
    }
  };
  const blankComment = (end) => {
    if (keep === "comments") return;
    blankRange(index, end);
  };
  if (keep === "comments") {
    // Start from a fully blank sheet and let the comment branches below restore nothing —
    // instead everything that is *not* a comment is blanked as it is passed.
  }
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      blankComment(stop);
      index = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      blankComment(stop);
      index = stop;
      continue;
    }
    // A regular expression literal is code, but its body is data: the rule table below
    // stores each marker as a pattern, and a scanner that did not blank those literals
    // reported the linter's own rules as violations. A `/` begins a literal only where a
    // value may begin — after an operator, a comma, an opening bracket — never after an
    // identifier, a closing bracket or a number, which is division.
    if (character === "/") {
      let back = index - 1;
      while (back >= 0 && /\s/u.test(source[back])) back -= 1;
      const previous = back >= 0 ? source[back] : "";
      if (previous === "" || "(,=:[!&|?{};+-*%~^".includes(previous)) {
        let cursor = index + 1;
        let inClass = false;
        while (cursor < source.length) {
          const current = source[cursor];
          if (current === "\\") { cursor += 2; continue; }
          if (current === "\n") break;
          if (current === "[") inClass = true;
          else if (current === "]") inClass = false;
          else if (current === "/" && !inClass) { cursor += 1; break; }
          cursor += 1;
        }
        blankRange(index, cursor);
        index = cursor;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") { cursor += 2; continue; }
        if (source[cursor] === character) { cursor += 1; break; }
        cursor += 1;
      }
      // BB-A4-N09. A string's contents are data, but its delimiters are code: they are the only
      // thing that tells `test.skip("name", fn)` — a case that will never run — apart from
      // `test.skip(condition)`. Blanking them too left the unconditional-skip rule looking for a
      // quote that had just been erased, so it could never match the input it exists to reject.
      blankRange(index + 1, Math.max(index + 1, cursor - 1));
      index = cursor;
      continue;
    }
    if (keep === "comments" && out[index] !== "\n") out[index] = " ";
    index += 1;
  }
  return out.join("");
};

const blankNonCode = (source) => project(source, "code");
const commentsOnly = (source) => project(source, "comments");

const isTypeScript = (relative) => /\.(?:ts|mts|cts)$/u.test(relative);
const isTest = (relative) =>
  /(?:^|\/)tests?\//u.test(relative) || /\.test\.[cm]?[jt]s$/u.test(relative);
const always = () => true;

const rules = [
  [
    "no-as-any",
    isTypeScript,
    /\bas\s+any\b/gu,
    "`as any` erases the type system at the one place a mistake becomes invisible",
  ],
  [
    // Read from the comment projection: this marker only ever appears in a comment, so a
    // rule reading the code projection could never fire — as this one could not until the
    // linter's own tracked file made the dead rule visible.
    "no-ts-ignore",
    always,
    /@ts-ignore\b/gu,
    "@ts-ignore hides an error without recording why; @ts-expect-error states it",
  ],
  [
    "no-test-only",
    isTest,
    /\b(?:test|describe|it)\.only\s*\(/gu,
    "`.only` silently reduces the suite to one case and still exits zero",
  ],
  [
    "no-unconditional-test-skip",
    isTest,
    /\b(?:test|describe|it)\.skip\s*\(\s*["'`]/gu,
    "an unconditional `.skip` hides a case; the runner's `skip` option records a reason",
  ],
];

const files = candidateFiles(root);
if (!files) {
  throw new Error("lint requires a Git checkout to enumerate the files it is answerable for");
}
// A tracked file deleted from the working tree is still an index entry, so it is still a
// candidate and still fails to open. Git is what separates that from a file that vanished while
// the gate was running, and a gate that could not ask is a gate that cannot classify its own
// read failures — so it refuses rather than guessing.
const deletions = trackedDeletions(root);
if (!deletions) {
  throw new Error("lint requires a Git checkout to tell a tracked deletion from a candidate that vanished mid-run");
}

// Which files this gate is answerable for, as opposed to which ones it enumerated: rules are
// written against JavaScript and TypeScript, and a `.json` candidate is skipped on purpose
// rather than skipped silently.
const isEligible = (relative) => /\.(?:ts|mts|cts|mjs|cjs|js)$/u.test(relative);

const { counts, problems, inspected } = await inspectCandidates({
  files,
  deletions,
  eligible: isEligible,
  read: containedReader({ root }),
});

// A file this gate could not read is a finding, not a silence. The file most likely to be
// unreadable is the file most likely to be the problem.
const findings = problems.map((problem) => `${problem} — not checked`);
for (const { relative, contents } of inspected) {
  const code = blankNonCode(contents);
  const comments = commentsOnly(contents);
  for (const [id, applies, matcher, message] of rules) {
    if (!applies(relative)) continue;
    const haystack = id === "no-ts-ignore" ? comments : code;
    matcher.lastIndex = 0;
    for (const match of haystack.matchAll(matcher)) {
      const line = haystack.slice(0, match.index).split("\n").length;
      findings.push(`${displayPath(relative)}:${String(line)}: ${id}: ${message}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`Lint found ${String(findings.length)} problem(s):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Lint checked ${candidateSummary(counts)} and found no problems.`);
}
