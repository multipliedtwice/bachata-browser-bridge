import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectFiles,
  expectedPackageEntries,
  manifestReferences,
  packageProblems,
  packagedEntryProblems,
  packagedManifestShapeProblems,
  requiredNoticePackages,
} from "../scripts/packageContents.mjs";
import { createStoreZip, inspectStoreZip } from "../scripts/zip.mjs";
import { generateThirdPartyNotices } from "../scripts/third-party-notices.mjs";
import { genericBundleOptions, buildGenericBundle } from "../scripts/build-generic.mjs";
import { cleanGenerated, generatedDirectories, generatedTargets } from "../scripts/clean-dist.mjs";
import {
  exportSourceDistribution,
  verifySourceDistribution,
} from "../scripts/source-distribution.mjs";
import {
  candidateFiles,
  candidateSummary,
  containedReader,
  inspectCandidates,
  symlinkRefusalIsAtomic,
  trackedDeletions,
} from "../scripts/lib/candidateFiles.mjs";
import { containmentStatement, escapesRoot, symlinkAncestorProblem } from "../scripts/lib/containment.mjs";
import {
  makeScratchChild,
  removeScratch,
  scratchBase,
  scratchChild,
  scratchContainmentProblem,
  scratchPrefixProblem,
  scratchProblem,
  scratchRoot,
  scratchTraversalProblem,
} from "./support/scratch.mjs";

// REVIEW-11 / BB-5. The release and packaging scripts decide what ships and what is deleted, and
// nothing exercised them. Maintained logic is tested by behaviour here; generated output is
// tested by its reproducibility, its contents and its binding to the source it came from, not by
// covering the bundle text it produces.
//
// Every test works in a scratch directory. Nothing here writes the repository, and the last test
// in the file checks that.

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const scratch = async () => await scratchRoot("bachata-release-");

const write = async (root, relative, contents) => {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  return target;
};

/**
 * REVIEW-11. What the repository looked like before this file ran a single test.
 *
 * Three sentinel paths said nothing about a dirty tree, which is the tree this suite actually
 * runs in. Git's own answer is the comparison: the working-tree status including untracked
 * files, and digests of the unstaged and staged diffs. Captured here, before the first test, and
 * compared at the end. Nothing is normalized: dirty state that was dirty before must be dirty
 * afterwards, in exactly the same way.
 */
const gitState = () => {
  // BR-20. A maintained-source export carries no VCS metadata, and running this suite is part
  // of the documented validation for an extracted distribution. Git's answer stays mandatory
  // wherever there is a checkout to ask; where there is none, that is reported as an absent
  // answer rather than as an empty one, so the comparison below refuses instead of passing
  // over a tree it never read.
  const git = (args) => spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = git(["status", "--porcelain=v1", "-uall"]);
  const worktree = git(["diff"]);
  const index = git(["diff", "--cached"]);
  if ([status, worktree, index].some((result) => result.status !== 0 || typeof result.stdout !== "string")) {
    return undefined;
  }
  return {
    status: status.stdout,
    worktree: createHash("sha256").update(worktree.stdout).digest("hex"),
    index: createHash("sha256").update(index.stdout).digest("hex"),
  };
};

/**
 * `dist` is generated and Git ignores it, so `git status` says nothing about it. A build
 * redirected into a scratch directory must leave it exactly as it found it — including not
 * creating it at all when it was absent.
 */
const treeSnapshot = async (directory) => {
  if (!existsSync(directory)) return null;
  const entries = [];
  const walk = async (base, prefix) => {
    for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else {
        const info = await stat(full);
        entries.push(`${name} ${String(info.size)} ${String(info.mtimeMs)}`);
      }
    }
  };
  await walk(directory, "");
  return entries;
};

const repositoryDist = path.join(repositoryRoot, "dist");
const repositoryBefore = gitState();
const repositoryDistBefore = await treeSnapshot(repositoryDist);

// --- package contents -------------------------------------------------------------------

test("a release package enumerates regular files in one deterministic order", async () => {
  const root = await scratch();
  try {
    await write(root, "b.js", "b");
    await write(root, "a.js", "a");
    await write(root, "nested/z.js", "z");
    await write(root, "nested/a.js", "a");
    const names = (await collectFiles(root)).map((entry) => entry.name);
    assert.deepEqual(names, ["a.js", "b.js", "nested/a.js", "nested/z.js"]);
    // Deterministic: the same tree enumerates the same way every time, which is what makes a
    // rebuilt ZIP comparable to the one before it.
    assert.deepEqual((await collectFiles(root)).map((entry) => entry.name), names);
  } finally {
    await removeScratch(root);
  }
});

test("a symbolic link is refused rather than followed into a release", async () => {
  const root = await scratch();
  try {
    await write(root, "real.js", "real");
    await symlink(path.join(root, "real.js"), path.join(root, "link.js"));
    await assert.rejects(
      () => collectFiles(root),
      /do not permit symbolic links: link\.js/u,
    );
  } finally {
    await removeScratch(root);
  }
});

test("expected entries are the compiled sources plus the generated assets, and nothing else", async () => {
  const root = await scratch();
  try {
    await write(root, "background/index.ts", "");
    await write(root, "popup/index.ts", "");
    await write(root, "chrome.d.ts", "");
    await write(root, "notes.md", "");
    const expected = await expectedPackageEntries(root);
    assert.equal(expected.has("background/index.js"), true);
    assert.equal(expected.has("popup/index.js"), true);
    // A declaration file compiles to nothing, and a note is not source.
    assert.equal(expected.has("chrome.d.js"), false);
    assert.equal(expected.has("chrome.js"), false);
    assert.equal(expected.has("notes.js"), false);
    for (const asset of ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.txt", "popup/index.html", "generic-content.js"]) {
      assert.equal(expected.has(asset), true, asset);
    }
  } finally {
    await removeScratch(root);
  }
});

test("manifest references are the concrete paths Chrome will load", () => {
  assert.deepEqual(
    manifestReferences({
      icons: { "128": "icon.png" },
      background: { service_worker: "background/index.js" },
      action: { default_popup: "popup/index.html" },
      content_scripts: [{ js: ["a.js", "b.js"], css: ["a.css"] }],
      web_accessible_resources: [{ resources: ["asset.png", "images/*"] }],
    }),
    ["icon.png", "background/index.js", "popup/index.html", "a.js", "b.js", "a.css", "asset.png"],
  );
  // A pattern names no single file, so it cannot be checked against the ZIP; a manifest with
  // nothing declared references nothing rather than throwing.
  assert.deepEqual(manifestReferences({}), []);
});

// --- packager verdict -------------------------------------------------------------------

const goodPackage = (overrides = {}) => ({
  entries: ["manifest.json", "background/index.js", "THIRD_PARTY_NOTICES.txt"],
  expected: ["manifest.json", "background/index.js", "THIRD_PARTY_NOTICES.txt"],
  manifestVersion: "1.2.3",
  version: "1.2.3",
  manifestReferences: ["background/index.js"],
  notices: requiredNoticePackages.map((name) => `${name}@1.0.0`).join("\n"),
  ...overrides,
});

test("a package that is exactly what the sources say ships has no problems", () => {
  assert.deepEqual(packageProblems(goodPackage()), []);
});

test("a missing file and an unexpected file are both refusals", () => {
  assert.match(
    packageProblems(goodPackage({ entries: ["manifest.json", "THIRD_PARTY_NOTICES.txt"] })).join("\n"),
    /missing background\/index\.js/u,
  );
  assert.match(
    packageProblems(goodPackage({ entries: [...goodPackage().entries, "stray.js"] })).join("\n"),
    /unexpected files: stray\.js/u,
  );
});

test("a packaged manifest that names another version is refused", () => {
  assert.match(
    packageProblems(goodPackage({ manifestVersion: "1.2.2" })).join("\n"),
    /manifest version 1\.2\.2 does not match package version 1\.2\.3/u,
  );
});

test("a manifest reference the ZIP does not carry is refused by name", () => {
  assert.match(
    packageProblems(goodPackage({ manifestReferences: ["popup/index.html"] })).join("\n"),
    /missing manifest reference popup\/index\.html/u,
  );
});

test("a notice naming a package without a version does not cover it", () => {
  const problems = packageProblems(goodPackage({ notices: requiredNoticePackages.join("\n") }));
  for (const name of requiredNoticePackages) {
    assert.ok(problems.some((problem) => problem === `Notices are missing ${name}`), name);
  }
});

test("every problem with one candidate is reported together, not one per rebuild", () => {
  const problems = packageProblems(goodPackage({
    entries: ["manifest.json", "stray.js"],
    manifestVersion: "9.9.9",
    notices: "",
  }));
  assert.ok(problems.length >= 4, problems.join(" | "));
  assert.ok(problems.some((problem) => problem.includes("missing")));
  assert.ok(problems.some((problem) => problem.includes("unexpected")));
  assert.ok(problems.some((problem) => problem.includes("does not match package version")));
  assert.ok(problems.some((problem) => problem.includes("Notices are missing")));
});

test("problem lists are deterministic, whatever order the entries arrive in", () => {
  const forwards = packageProblems(goodPackage({ entries: ["manifest.json", "z.js", "a.js"] }));
  const backwards = packageProblems(goodPackage({ entries: ["a.js", "z.js", "manifest.json"] }));
  assert.deepEqual(forwards, backwards);
});

// --- the packager's inspection of a real archive -----------------------------------------

// REVIEW-11. `packageProblems` is fed values; the packager is fed an archive. The runner used to
// read `manifest.json` and `THIRD_PARTY_NOTICES.txt` out of the entries and `JSON.parse` the
// first before any verdict existed, so a candidate missing either — or carrying a manifest that
// is not JSON, or is JSON but not an object — died on `undefined.toString()` or a raw
// `SyntaxError`, and every unrelated file problem died with it, unreported. These drive the
// inspection the runner now performs, over bytes that went through a real ZIP.

const goodNotices = requiredNoticePackages.map((name) => `${name}@1.0.0`).join("\n");

const goodManifest = JSON.stringify({
  version: "1.2.3",
  background: { service_worker: "background/index.js" },
});

const packagedFiles = (overrides = {}) => {
  const files = {
    "manifest.json": goodManifest,
    "background/index.js": "export {};",
    "THIRD_PARTY_NOTICES.txt": goodNotices,
    ...overrides,
  };
  for (const [name, contents] of Object.entries(files)) {
    if (contents === undefined) delete files[name];
  }
  return files;
};

/** Zip the given files, read them back the way the packager does, and take its verdict. */
const packagedVerdict = async (files, options = {}) => {
  const root = await scratch();
  try {
    const staged = path.join(root, "staged");
    await mkdir(staged, { recursive: true });
    for (const [name, contents] of Object.entries(files)) await write(staged, name, contents);
    const archive = path.join(root, "candidate.zip");
    await createStoreZip(archive, await collectFiles(staged));
    return packagedEntryProblems({
      entries: await inspectStoreZip(archive),
      expected: options.expected ?? Object.keys(packagedFiles()),
      version: options.version ?? "1.2.3",
      ...(options.requiredNotices === undefined ? {} : { requiredNotices: options.requiredNotices }),
    });
  } finally {
    await removeScratch(root);
  }
};

test("an archive that is exactly what the sources say ships is inspected without problems", async () => {
  assert.deepEqual(await packagedVerdict(packagedFiles()), []);
});

test("an archive with no manifest is a package problem, not a thrown TypeError", async () => {
  const problems = await packagedVerdict(packagedFiles({ "manifest.json": undefined }));
  assert.ok(problems.some((problem) => problem === "Release ZIP has no manifest.json to verify"), problems.join(" | "));
  // The file check still runs: a candidate missing a manifest is also a candidate missing a file.
  assert.ok(problems.some((problem) => problem.includes("missing manifest.json")), problems.join(" | "));
});

// REVIEW-11. A manifest that parses is still archive-controlled data. Its shape is whatever the
// archive holds, and the packager reads four of its fields as lists of objects. Each of the
// shapes below used to reach `flatMap` or a spread and leave the packager throwing a raw
// `TypeError` from inside itself — which is not a verdict about a candidate, and takes every
// unrelated file and notice problem down with it.

test("a manifest whose reference lists are not lists is a package problem, not a TypeError", async () => {
  const cases = [
    [{ content_scripts: "background/index.js" }, "content_scripts is not an array"],
    [{ web_accessible_resources: {} }, "web_accessible_resources is not an array"],
    [{ content_scripts: [null] }, "content_scripts[0] is not an object"],
    [{ content_scripts: ["background/index.js"] }, "content_scripts[0] is not an object"],
    [{ content_scripts: [{ js: "background/index.js" }] }, "content_scripts[0].js is not an array"],
    [{ content_scripts: [{ css: 7 }] }, "content_scripts[0].css is not an array"],
    [{ web_accessible_resources: [null] }, "web_accessible_resources[0] is not an object"],
    [{ web_accessible_resources: [{ resources: "x" }] }, "web_accessible_resources[0].resources is not an array"],
    [{ background: "background/index.js" }, "background is not an object"],
    [{ background: [] }, "background is not an object"],
    [{ action: 7 }, "action is not an object"],
  ];
  for (const [overrides, expected] of cases) {
    const problems = await packagedVerdict(
      packagedFiles({
        "manifest.json": JSON.stringify({ version: "1.2.3", ...overrides }),
      }),
    );
    assert.ok(
      problems.some((problem) => problem === `Packaged manifest.json ${expected}`),
      `${JSON.stringify(overrides)} -> ${problems.join(" | ")}`,
    );
  }
});

test("a malformed manifest shape does not stop the file and notice checks from reporting", async () => {
  const problems = await packagedVerdict(
    packagedFiles({
      "manifest.json": JSON.stringify({ version: "9.9.9", content_scripts: "no" }),
      "THIRD_PARTY_NOTICES.txt": "nothing useful",
      "unaccounted.js": "export {};",
    }),
  );
  assert.ok(problems.some((problem) => problem === "Packaged manifest.json content_scripts is not an array"), problems.join(" | "));
  assert.ok(problems.some((problem) => problem.includes("unexpected files: unaccounted.js")), problems.join(" | "));
  assert.ok(problems.some((problem) => problem.includes("does not match package version")), problems.join(" | "));
  assert.ok(problems.some((problem) => problem.startsWith("Notices are missing ")), problems.join(" | "));
});

test("a manifest whose lists are well formed still has every reference checked", async () => {
  const problems = await packagedVerdict(
    packagedFiles({
      "manifest.json": JSON.stringify({
        version: "1.2.3",
        background: { service_worker: "background/index.js" },
        action: { default_popup: "popup/index.html" },
        content_scripts: [{ js: ["content/one.js"], css: ["content/one.css"] }, {}],
        web_accessible_resources: [{ resources: ["assets/*", "assets/logo.png"] }, {}],
      }),
    }),
  );
  assert.deepEqual(packagedManifestShapeProblems(JSON.parse(goodManifest)), []);
  for (const reference of ["popup/index.html", "content/one.js", "content/one.css", "assets/logo.png"]) {
    assert.ok(
      problems.some((problem) => problem === `Release ZIP is missing manifest reference ${reference}`),
      `${reference}: ${problems.join(" | ")}`,
    );
  }
  // A wildcard resource names no single file, so it is not checked as one.
  assert.equal(problems.some((problem) => problem.includes("assets/*")), false);
});

test("an archive whose manifest is not JSON is a package problem naming the parse failure", async () => {
  const problems = await packagedVerdict(packagedFiles({ "manifest.json": "{ not json" }));
  assert.ok(
    problems.some((problem) => problem.startsWith("Packaged manifest.json is not valid JSON:")),
    problems.join(" | "),
  );
  // And the version check it could not perform is absent rather than reported against undefined.
  assert.equal(problems.some((problem) => problem.includes("does not match package version")), false);
});

test("an archive whose manifest is JSON but not an object is refused by name", async () => {
  for (const contents of ["[]", "null", "7", '"a manifest"', "true"]) {
    const problems = await packagedVerdict(packagedFiles({ "manifest.json": contents }));
    assert.ok(
      problems.some((problem) => problem === "Packaged manifest.json is not a JSON object"),
      `${contents}: ${problems.join(" | ")}`,
    );
  }
});

test("an archive with no notices is a package problem, and every notice it owed is still named", async () => {
  const problems = await packagedVerdict(packagedFiles({ "THIRD_PARTY_NOTICES.txt": undefined }));
  assert.ok(
    problems.some((problem) => problem === "Release ZIP has no THIRD_PARTY_NOTICES.txt to verify"),
    problems.join(" | "),
  );
  for (const name of requiredNoticePackages) {
    assert.ok(problems.includes(`Notices are missing ${name}`), name);
  }
});

test("an archive whose manifest names another version is refused through the inspection path", async () => {
  const problems = await packagedVerdict(packagedFiles({
    "manifest.json": JSON.stringify({ version: "9.9.9", background: { service_worker: "background/index.js" } }),
  }));
  assert.ok(
    problems.some((problem) => problem.includes("manifest version 9.9.9 does not match package version 1.2.3")),
    problems.join(" | "),
  );
});

test("an archive missing a file its manifest references is refused by that reference", async () => {
  const problems = await packagedVerdict(packagedFiles({
    "manifest.json": JSON.stringify({
      version: "1.2.3",
      background: { service_worker: "background/index.js" },
      action: { default_popup: "popup/index.html" },
    }),
  }));
  assert.ok(
    problems.some((problem) => problem === "Release ZIP is missing manifest reference popup/index.html"),
    problems.join(" | "),
  );
});

test("a manifest that cannot be read never hides the file problems around it", async () => {
  // The case the old runner could not report at all: it threw on the manifest and said nothing
  // about the file that was missing or the file that should not have been there.
  const problems = await packagedVerdict(
    packagedFiles({ "manifest.json": "{ not json", "background/index.js": undefined, "stray.js": "stray" }),
  );
  assert.ok(problems.some((problem) => problem.startsWith("Packaged manifest.json is not valid JSON:")));
  assert.ok(problems.some((problem) => problem.includes("missing background/index.js")), problems.join(" | "));
  assert.ok(problems.some((problem) => problem.includes("unexpected files: stray.js")), problems.join(" | "));
});

test("the packager refuses a broken candidate with its own words rather than a runtime error", async () => {
  // The runner itself, run as `npm run package` runs it, over a candidate whose manifest is
  // missing. Before this it exited on `Cannot read properties of undefined (reading 'toString')`.
  const root = await scratch();
  try {
    await write(root, "package.json", JSON.stringify({ name: "candidate", version: "1.2.3" }));
    await write(root, "src/background/index.ts", "export {};");
    await write(root, "dist/background/index.js", "export {};");
    await write(root, "dist/THIRD_PARTY_NOTICES.txt", goodNotices);
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/package.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BACHATA_BRIDGE_PACKAGE_OUTPUT: path.join(root, "out.zip") },
    });
    assert.notEqual(result.status, 0, "a candidate with no manifest was packaged");
    assert.match(result.stderr, /Release ZIP has no manifest\.json to verify/u);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/u, result.stderr);
    // A refused candidate leaves no archive and no staging file behind.
    assert.equal(existsSync(path.join(root, "out.zip")), false);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes("staging")), []);
  } finally {
    await removeScratch(root);
  }
});

test("the packager refuses a malformed manifest with its own words rather than a JSON error", async () => {
  const root = await scratch();
  try {
    await write(root, "package.json", JSON.stringify({ name: "candidate", version: "1.2.3" }));
    await write(root, "src/background/index.ts", "export {};");
    await write(root, "dist/background/index.js", "export {};");
    await write(root, "dist/manifest.json", "{ not json");
    await write(root, "dist/THIRD_PARTY_NOTICES.txt", goodNotices);
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/package.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BACHATA_BRIDGE_PACKAGE_OUTPUT: path.join(root, "out.zip") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Packaged manifest\.json is not valid JSON/u);
    assert.equal(existsSync(path.join(root, "out.zip")), false);
  } finally {
    await removeScratch(root);
  }
});

// --- ZIP round trip ---------------------------------------------------------------------

test("a written package reads back with the same names and bytes", async () => {
  const root = await scratch();
  try {
    await write(root, "manifest.json", '{"version":"1.0.0"}');
    await write(root, "nested/file.js", "contents");
    const archive = path.join(root, "out.zip");
    await createStoreZip(archive, await collectFiles(path.join(root)));
    const entries = await inspectStoreZip(archive);
    assert.equal(entries.get("manifest.json").toString("utf8"), '{"version":"1.0.0"}');
    assert.equal(entries.get("nested/file.js").toString("utf8"), "contents");
  } finally {
    await removeScratch(root);
  }
});

// --- third-party notices ----------------------------------------------------------------

test("the notices name every redistributed package with its version and licence", async () => {
  const root = await scratch();
  try {
    const output = path.join(root, "NOTICES.txt");
    await generateThirdPartyNotices(output);
    const notices = await readFile(output, "utf8");
    for (const name of requiredNoticePackages) {
      assert.ok(notices.includes(`${name}@`), name);
      assert.match(notices, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}@\\d`, "u"), name);
    }
    assert.match(notices, /License: /u);
    assert.match(notices, /--- LICENSE/iu);
  } finally {
    await removeScratch(root);
  }
});

test("the notices are byte-identical when generated twice", async () => {
  const root = await scratch();
  try {
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await generateThirdPartyNotices(first);
    await generateThirdPartyNotices(second);
    assert.equal(await readFile(first, "utf8"), await readFile(second, "utf8"));
  } finally {
    await removeScratch(root);
  }
});

test("notice sections are ordered by package name, not by discovery order", async () => {
  const root = await scratch();
  try {
    const output = path.join(root, "NOTICES.txt");
    await generateThirdPartyNotices(output);
    const notices = await readFile(output, "utf8");
    const positions = requiredNoticePackages
      .map((name) => ({ name, at: notices.indexOf(`${name}@`) }))
      .filter((entry) => entry.at >= 0);
    const sorted = [...positions].sort((left, right) => (left.name < right.name ? -1 : 1));
    assert.deepEqual(positions.map((entry) => entry.name), sorted.map((entry) => entry.name));
  } finally {
    await removeScratch(root);
  }
});

// --- generic bundle ---------------------------------------------------------------------

test("the Generic bundle is built from the content entry Chrome injects", () => {
  const options = genericBundleOptions();
  assert.deepEqual(options.entryPoints, ["src/content/generic/index.ts"]);
  assert.equal(options.outfile, "dist/generic-content.js");
  assert.equal(options.bundle, true);
  // An IIFE, because a content script has no module loader; browser platform, because it runs
  // in a page rather than in the service worker.
  assert.equal(options.format, "iife");
  assert.equal(options.platform, "browser");
  assert.deepEqual(options.target, ["chrome114", "firefox115"]);
});

test("the bundle output can be redirected without changing what is bundled", () => {
  const options = genericBundleOptions("/tmp/elsewhere.js");
  assert.equal(options.outfile, "/tmp/elsewhere.js");
  assert.deepEqual(options.entryPoints, genericBundleOptions().entryPoints);
});

test("a Generic bundle built into a scratch file carries the entry's own guard", async () => {
  const root = await scratch();
  try {
    const outfile = path.join(root, "generic-content.js");
    await buildGenericBundle(outfile);
    const bundled = await readFile(outfile, "utf8");
    assert.match(bundled, /__BACHATA_GENERIC_CONTENT_INSTALLED__/u);
    // Bundled, not merely transpiled: a dependency the entry imports is inside the output.
    assert.match(bundled, /turndown|Readability/u);
  } finally {
    await removeScratch(root);
  }
});

test("a bundle whose entry does not exist fails instead of writing an empty output", async () => {
  const root = await scratch();
  const outfile = path.join(root, "nothing.js");
  try {
    const { build } = await import("esbuild");
    await assert.rejects(() => build({
      ...genericBundleOptions(outfile),
      entryPoints: [path.join(root, "no-such-entry.ts")],
      logLevel: "silent",
    }));
    assert.equal(existsSync(outfile), false, "a failed build left an output behind");
  } finally {
    await removeScratch(root);
  }
});

/**
 * REVIEW-11. Run the real `buildGenericBundle` with a given working directory.
 *
 * esbuild resolves the entry against the working directory its service started in, so this has
 * to be a child process rather than a `chdir`. What runs is the production module, imported by
 * path and called with an output the caller chooses.
 */
const buildInDirectory = async (cwd, outfile) => {
  const runner = path.join(cwd, "run-build.mjs");
  await writeFile(
    runner,
    `const { buildGenericBundle } = await import(${JSON.stringify(new URL("../scripts/build-generic.mjs", import.meta.url).href)});\n`
      + "await buildGenericBundle(process.argv[2]);\n",
    "utf8",
  );
  return spawnSync(process.execPath, [runner, outfile], { cwd, encoding: "utf8" });
};

test("a bundle redirected into a scratch directory creates that directory and no other", async () => {
  // `buildGenericBundle` used to `mkdir("dist")` whatever the output was, so a build aimed at a
  // scratch file still created `dist` in whatever directory it ran from — the repository, when
  // the suite ran there. The output's own parent is what it creates now.
  const root = await scratch();
  try {
    await write(root, "src/content/generic/index.ts", 'export const marker = "scratch-entry";\n');
    const outfile = path.join(root, "out", "generic-content.js");
    const result = await buildInDirectory(root, outfile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(outfile), true, "the redirected output was not written");
    assert.equal(existsSync(path.join(root, "dist")), false, "a redirected build created dist anyway");
    assert.match(await readFile(outfile, "utf8"), /scratch-entry/u);
  } finally {
    await removeScratch(root);
  }
});

test("a bundle redirected several directories deep creates the whole path", async () => {
  const root = await scratch();
  try {
    await write(root, "src/content/generic/index.ts", 'export const marker = "nested-entry";\n');
    const outfile = path.join(root, "a", "b", "c", "generic-content.js");
    const result = await buildInDirectory(root, outfile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(outfile), true);
    assert.equal(existsSync(path.join(root, "dist")), false);
  } finally {
    await removeScratch(root);
  }
});

test("the default output is still the one the build script has always written", async () => {
  const root = await scratch();
  try {
    await write(root, "src/content/generic/index.ts", 'export const marker = "default-entry";\n');
    const runner = path.join(root, "run-default.mjs");
    await writeFile(
      runner,
      `const { buildGenericBundle } = await import(${JSON.stringify(new URL("../scripts/build-generic.mjs", import.meta.url).href)});
`
        + "await buildGenericBundle();\n",
      "utf8",
    );
    const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    // The default runner still targets `dist/generic-content.js` relative to where it runs.
    assert.equal(existsSync(path.join(root, "dist", "generic-content.js")), true);
  } finally {
    await removeScratch(root);
  }
});

test("the repository's built output is untouched by a redirected build", async () => {
  const before = await treeSnapshot(repositoryDist);
  const root = await scratch();
  try {
    await buildGenericBundle(path.join(root, "generic-content.js"));
    assert.equal(existsSync(path.join(root, "generic-content.js")), true);
    assert.deepEqual(await treeSnapshot(repositoryDist), before, "a redirected build wrote dist");
  } finally {
    await removeScratch(root);
  }
});

test("a build that fails writes no output where its output would have gone", async () => {
  const root = await scratch();
  try {
    // No entry exists in this working directory, so the build fails after the output directory
    // has been created. What must not survive is a partial or empty output file.
    const outfile = path.join(root, "out", "generic-content.js");
    const result = await buildInDirectory(root, outfile);
    assert.notEqual(result.status, 0, "a build with no entry succeeded");
    assert.equal(existsSync(outfile), false, "a failed build left an output behind");
    assert.equal(existsSync(path.join(root, "dist")), false);
  } finally {
    await removeScratch(root);
  }
});

// --- clean ------------------------------------------------------------------------------

test("clean deletes one generated directory inside the package root and no other", () => {
  const targets = generatedTargets("/somewhere/pkg");
  assert.deepEqual(targets, [path.resolve("/somewhere/pkg/dist")]);
});

test("a clean target can never resolve to or above the package root", () => {
  // The guard is what stops a target list edit from turning `clean` into a repository delete, so
  // it is driven with the names such an edit would introduce rather than reproduced here: a
  // reproduction would prove this file's copy of the rule and nothing about the script's.
  for (const escape of ["", ".", "..", "../..", "../outside", "/elsewhere", "/pkg-other", "../pkg-other"]) {
    assert.throws(
      () => generatedTargets("/somewhere/pkg", [escape]),
      /escapes the package root/u,
      escape,
    );
  }
  // Prefix confusion is the case a naive `startsWith` gets wrong: a sibling whose name begins
  // with the root's name is outside the root, and is refused like anything else outside it.
  assert.throws(() => generatedTargets("/somewhere/pkg", ["../pkg-other"]), /escapes the package root/u);
  // And the guard refuses escapes rather than nesting: a name that does resolve inside is kept.
  assert.deepEqual(
    generatedTargets("/somewhere/pkg", ["build/out"]),
    [path.resolve("/somewhere/pkg/build/out")],
  );
  // The real list is the default, so the production resolver under test is the production one.
  assert.deepEqual(generatedDirectories, ["dist"]);
  assert.deepEqual(generatedTargets("/somewhere/pkg", generatedDirectories), generatedTargets("/somewhere/pkg"));
});

test("clean refuses an escaping target before it removes anything at all", async () => {
  // SAFETY. The refusal is proved against a recorder, not against the filesystem. A test that
  // called the real remover with an escaping list would be the escape it claims to forbid: the
  // question is which targets a run reaches, and a recorder answers it exactly and removes
  // nothing. The production guard is the one under test either way — only the remover is
  // substituted.
  const removed = [];
  const record = (target) => {
    removed.push(target);
  };
  await assert.rejects(
    () => cleanGenerated("/somewhere/pkg", ["dist", ".."], record),
    /escapes the package root/u,
  );
  assert.deepEqual(removed, [], "clean removed before it checked the whole list");

  // Every name in the list is checked, not only the first, and the position of the bad name in
  // the list does not change that.
  for (const list of [["..", "dist"], ["dist", "/elsewhere"], ["dist", "", "dist"], ["dist", "."]]) {
    removed.length = 0;
    await assert.rejects(() => cleanGenerated("/somewhere/pkg", list, record), /escapes the package root/u);
    assert.deepEqual(removed, [], `clean removed something from ${JSON.stringify(list)}`);
  }

  // An accepted list reaches the remover in order, and reaches it with resolved absolute paths
  // rather than with the names it was given.
  removed.length = 0;
  const targets = await cleanGenerated("/somewhere/pkg", ["dist", "build/out"], record);
  assert.deepEqual(removed, [path.resolve("/somewhere/pkg/dist"), path.resolve("/somewhere/pkg/build/out")]);
  assert.deepEqual(removed, targets);
});

test("clean leaves an owned tree untouched when one name in its list escapes", async () => {
  const root = await scratch();
  // The package root is a level below the scratch root on purpose: were the guard ever removed,
  // the escaping target resolves to a directory this test owns rather than to whatever the
  // temporary directory's parent happens to be. The recorder above proves nothing is removed;
  // this proves the same run against real files that a real `clean` would have deleted.
  const pkg = scratchChild(root, "pkg");
  try {
    await write(pkg, "dist/built.js", "built");
    await write(pkg, "src/kept.ts", "kept");
    await write(root, "outside.txt", "not this test's to delete");
    await assert.rejects(() => cleanGenerated(pkg, ["dist", ".."]), /escapes the package root/u);
    assert.equal(existsSync(path.join(pkg, "dist/built.js")), true, "clean deleted before it checked");
    assert.equal(existsSync(path.join(pkg, "src/kept.ts")), true);
    assert.equal(existsSync(path.join(root, "outside.txt")), true);
  } finally {
    await removeScratch(root);
  }
});

test("a test cleanup target can never escape the directory the run created", async () => {
  // SAFETY. This suite's own cleanup is the destructive operation with the widest reach in the
  // repository: it runs `rm -r` in a `finally` on a path a test computed. `removeScratch` is the
  // only place that runs, and it refuses every shape that has ever turned a cleanup into an
  // incident. Proved against a recorder so the refusals cost nothing and the acceptance is
  // observed rather than inferred from a directory having disappeared.
  const root = await scratch();
  const removed = [];
  const record = (target) => {
    removed.push(target);
  };
  try {
    const base = path.resolve(path.dirname(root));
    const refused = [
      "",
      ".",
      "..",
      "dist",
      "relative/path",
      base,
      path.dirname(base),
      path.join(base, ".."),
      `${root}-sibling`,
      `${base}/bachata-release-not-this-run`,
      path.join(root, ".."),
      path.join(root, "..", "..", "elsewhere"),
      process.cwd(),
      repositoryRoot,
      path.join(repositoryRoot, "src"),
      String(process.env.HOME ?? "/"),
      "$TMPDIR",
      "${TMPDIR}",
      path.join("$TMPDIR", "bachata-release-x"),
    ];
    for (const target of refused) {
      removed.length = 0;
      await assert.rejects(() => removeScratch(target, record), /scratch target/u, JSON.stringify(target));
      assert.deepEqual(removed, [], `cleanup reached the remover for ${JSON.stringify(target)}`);
    }

    // Prefix confusion is the case a naive `startsWith` gets wrong twice over: a sibling whose
    // name begins with this run's directory name is not inside it, and neither is a sibling of
    // the temporary directory whose name begins with the temporary directory's name.
    assert.match(
      String(scratchProblem(`${root}x`, base)),
      /this run created/u,
    );
    assert.equal(scratchProblem(`${base}x/bachata-release-y`, base) !== undefined, true);

    // What is accepted: the exact directory the run created, and a descendant of it.
    const child = scratchChild(root, "pkg", "dist");
    assert.equal(scratchProblem(root, base), undefined);
    assert.equal(scratchProblem(child, base), undefined);
    removed.length = 0;
    await removeScratch(child, record);
    assert.deepEqual(removed, [child]);

    // And a child path that would climb out of its root is refused where it is built, before any
    // caller can hand it to a remover.
    assert.throws(() => scratchChild(root, ".."), /escapes its root/u);
    assert.throws(() => scratchChild(root, "..", "elsewhere"), /escapes its root/u);
    assert.throws(() => scratchChild(root, "/elsewhere"), /escapes its root/u);
  } finally {
    await removeScratch(root);
  }
});

test("a scratch directory reached through a symlink is refused, and the link is not followed", async () => {
  // SAFETY. A symlink is how a checked path becomes an unchecked one between the check and the
  // removal. The link itself lives inside a directory this run created, so it is an accepted
  // target; what must not happen is that removing it removes what it points at.
  const root = await scratch();
  const outside = await scratch();
  try {
    await write(outside, "kept.txt", "not this test's to delete");
    const link = scratchChild(root, "link");
    await symlink(outside, link);

    // The link's own path is inside the run's directory, so it is accepted — and `rm` on a
    // symlink removes the link.
    await removeScratch(link);
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(path.join(outside, "kept.txt")), true, "removal followed a symlink out");

    // A path that climbs out lexically is refused, which is the case the string half of the
    // guard answers. The symlink-ancestor case it cannot answer is the test below.
    const escaped = await scratch();
    const bridge = scratchChild(root, "bridge");
    await symlink(escaped, bridge);
    await assert.rejects(
      () => removeScratch(path.join(bridge, "..", "..", "elsewhere")),
      /scratch target/u,
    );
    await removeScratch(escaped);
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

test("a descendant reached through a symlink ancestor is refused before any removal", async () => {
  // SAFETY. The case a lexical guard gets wrong. `root/link/victim` starts with `root` as a
  // string and resolves to itself, while naming a file in a directory this run does not own.
  // Telling those apart needs the filesystem, and the proof is that the recorder stays empty
  // and the file outside is still byte-for-byte what it was.
  const root = await scratch();
  const outside = await scratch();
  try {
    const sentinel = path.join(outside, "sentinel.txt");
    await write(outside, "sentinel.txt", "not this run's to delete");
    const before = await readFile(sentinel);

    const link = scratchChild(root, "link");
    await symlink(outside, link);

    const base = await scratchBase();
    // The lexical half accepts it: that is what made the escape reachable.
    assert.equal(scratchProblem(path.join(link, "sentinel.txt"), base), undefined);
    assert.equal(
      scratchContainmentProblem(path.join(link, "sentinel.txt"), base),
      `a scratch target is reached through a symlink: ${link}`,
    );

    const removed = [];
    const record = (target) => {
      removed.push(target);
    };
    // An existing descendant, and one that does not exist: neither may be reached through a link.
    for (const victim of ["sentinel.txt", "never-created", path.join("never-created", "deeper")]) {
      removed.length = 0;
      await assert.rejects(
        () => removeScratch(path.join(link, victim), record),
        /reached through a symlink/u,
        victim,
      );
      assert.deepEqual(removed, [], `cleanup reached the remover for ${victim}`);
    }

    assert.deepEqual(await readFile(sentinel), before, "the file outside the owned root changed");
    assert.equal(existsSync(link), true, "the refusal removed the link it refused to traverse");
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

test("a symlink ancestor cannot redirect where a scratch child is created", async () => {
  // SAFETY. `mkdir` with `recursive` follows a link ancestor exactly as `rm` does, so a child
  // built under one would be written outside the owned root — and handed to a later cleanup.
  const root = await scratch();
  const outside = await scratch();
  try {
    const link = scratchChild(root, "link");
    await symlink(outside, link);
    await assert.rejects(() => makeScratchChild(root, "link", "storage"), /reached through a symlink/u);
    assert.equal(existsSync(path.join(outside, "storage")), false, "a scratch child was written outside its root");
    const real = await makeScratchChild(root, "storage", "runs");
    assert.equal(existsSync(real), true);
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

/** A filesystem error the way Node raises one: the classification is the `code`, not the text. */
const fsError = (code) => Object.assign(new Error(`${code}: simulated`), code === "" ? {} : { code });

test("an inspection that fails refuses, and only ENOENT or ENOTDIR means genuinely missing", () => {
  // The refusal is decided from `lstat` and `realpath`, so both are parameters and the walk is
  // driven from a table rather than from a filesystem shaped to match.
  //
  // SAFETY. This is the half of the guard that used to fail open. Every `lstat` failure was read
  // as "this ancestor does not exist", so a directory that could not be read because of a
  // permission or an I/O error ended the walk with the same answer a genuinely absent directory
  // gives — and that answer authorizes a recursive removal. Only `ENOENT` and `ENOTDIR` state
  // that a path is not there; everything else states that the question was not answered.
  const root = path.join(path.sep, "owned", "root");
  const link = { isSymbolicLink: () => true };
  const directory = { isSymbolicLink: () => false };
  const roots = new Set([root]);
  const walk = (entries, target, real = (entry) => entry) =>
    scratchTraversalProblem(
      target,
      roots,
      (entry) => {
        const found = entries[entry];
        if (found === undefined) throw fsError("ENOENT");
        if (found instanceof Error) throw found;
        return found;
      },
      real,
    );
  const linked = path.join(root, "link");
  assert.match(walk({ [linked]: link }, path.join(linked, "victim")), /reached through a symlink/u);

  // Missing, both ways a path can be missing: absent, and present-but-not-a-directory.
  assert.equal(walk({}, path.join(root, "absent", "victim")), undefined);
  assert.equal(
    walk({ [path.join(root, "file")]: fsError("ENOTDIR") }, path.join(root, "file", "victim")),
    undefined,
  );

  // Unreadable: refused, and the refusal names the path and the code it failed with.
  for (const code of ["EACCES", "EIO", "ELOOP", "ENAMETOOLONG", "EPERM"]) {
    assert.equal(
      walk({ [path.join(root, "opaque")]: fsError(code) }, path.join(root, "opaque", "victim")),
      `a scratch target's ancestor could not be inspected (${code}): ${path.join(root, "opaque")}`,
      code,
    );
  }
  assert.equal(
    walk({ [path.join(root, "opaque")]: fsError("") }, path.join(root, "opaque", "victim")),
    `a scratch target's ancestor could not be inspected (no error code): ${path.join(root, "opaque")}`,
  );

  // A real chain is accepted, and the target's own last segment is never stat-ed — that is what
  // keeps a link removable as a link.
  assert.equal(walk({ [path.join(root, "real")]: directory }, path.join(root, "real", "victim")), undefined);
  assert.equal(walk({}, linked), undefined);
  assert.equal(walk({ [linked]: link }, linked), undefined, "the target's own segment was inspected");

  // And the root's own identity, read the same way.
  assert.match(
    walk({}, path.join(root, "victim"), () => path.join(path.sep, "elsewhere")),
    /root is reached through a symlink/u,
  );
  for (const code of ["EACCES", "EIO", "ELOOP"]) {
    assert.equal(
      walk({}, path.join(root, "victim"), () => {
        throw fsError(code);
      }),
      `a scratch target's root could not be inspected (${code}): ${root}`,
      code,
    );
  }
  assert.equal(
    walk({}, path.join(root, "victim"), () => {
      throw fsError("");
    }),
    `a scratch target's root could not be inspected (no error code): ${root}`,
  );
  // A root that is not there has nothing under it to traverse and nothing under it to remove.
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(
      walk({}, path.join(root, "victim"), () => {
        throw fsError(code);
      }),
      undefined,
      code,
    );
  }
});

test("the containment primitive names what was in the way and why", () => {
  // The primitive `clean` and the scratch guard share, read directly: both callers word their own
  // refusal from it, so what it returns is part of the contract rather than an implementation
  // detail of either one.
  const root = path.join(path.sep, "owned", "root");
  const stats = (isLink) => ({ isSymbolicLink: () => isLink });
  const linkAt = (entry) => (candidate) => {
    if (candidate === entry) return stats(true);
    return stats(false);
  };
  assert.deepEqual(
    symlinkAncestorProblem(root, path.join(root, "link", "victim"), linkAt(path.join(root, "link")), (value) => value),
    { kind: "ancestor", reason: "symlink", path: path.join(root, "link") },
  );
  assert.deepEqual(
    symlinkAncestorProblem(root, path.join(root, "a", "victim"), () => {
      throw fsError("EACCES");
    }, (value) => value),
    { kind: "ancestor", reason: "unreadable", path: path.join(root, "a"), code: "EACCES" },
  );
  assert.deepEqual(
    symlinkAncestorProblem(root, path.join(root, "victim"), () => stats(false), () => {
      throw fsError("EIO");
    }),
    { kind: "root", reason: "unreadable", path: root, code: "EIO" },
  );
  assert.deepEqual(
    symlinkAncestorProblem(root, path.join(root, "victim"), () => stats(false), () => path.sep),
    { kind: "root", reason: "symlink", path: root },
  );
  assert.equal(
    containmentStatement({ kind: "ancestor", reason: "unreadable", path: "/x", code: "EIO" }),
    "an ancestor could not be inspected (EIO): /x",
  );
  assert.equal(
    containmentStatement({ kind: "root", reason: "symlink", path: "/x" }),
    "the owned root is a symbolic link: /x",
  );
  assert.equal(
    containmentStatement({ kind: "root", reason: "unreadable", path: "/x", code: "" }),
    "the owned root could not be inspected (no error code): /x",
  );
  // A target outside the root is not this primitive's question, and neither is the root itself.
  assert.equal(symlinkAncestorProblem(root, path.join(path.sep, "elsewhere"), () => stats(true), (value) => value), undefined);
  assert.equal(symlinkAncestorProblem(root, root, () => stats(true), (value) => value), undefined);
});

test("a target that is not already its own canonical path is refused before any removal", async () => {
  // SAFETY. `path.resolve(target) !== path.normalize(target)` detected a trailing separator and
  // nothing else: both functions collapse `.` and `..` and both fold repeated separators, so a
  // target written with a climb in the middle compared equal and was accepted — and the path the
  // remover was then handed was not the path the caller wrote. The rule is now exact equality
  // with the canonical absolute path.
  const root = await scratch();
  const base = await scratchBase();
  const removed = [];
  const record = (target) => {
    removed.push(target);
  };
  try {
    const victim = await makeScratchChild(root, "victim");
    for (const shape of [
      `${root}${path.sep}a${path.sep}..${path.sep}victim`,
      `${root}${path.sep}.${path.sep}victim`,
      `${root}${path.sep}${path.sep}victim`,
      `${root}${path.sep}victim${path.sep}`,
      `${root}${path.sep}`,
      `${root}${path.sep}.`,
    ]) {
      removed.length = 0;
      assert.match(
        String(scratchProblem(shape, base)),
        /must be its own canonical absolute path/u,
        JSON.stringify(shape),
      );
      await assert.rejects(() => removeScratch(shape, record), /canonical absolute path/u, JSON.stringify(shape));
      assert.deepEqual(removed, [], `cleanup reached the remover for ${JSON.stringify(shape)}`);
      assert.equal(existsSync(victim), true, `a refused shape removed ${victim}`);
    }
    // The canonical spelling of the same directory is accepted, so the rule refuses spellings
    // rather than paths.
    removed.length = 0;
    await removeScratch(victim, record);
    assert.deepEqual(removed, [victim]);
  } finally {
    await removeScratch(root);
  }
});

test("clean refuses a target whose ancestor could not be inspected", async () => {
  // SAFETY. `clean` deletes recursively. A `dist` whose parent could not be read is not a `dist`
  // known to be inside the package root, and the cost of refusing an unreadable path is a failed
  // build while the cost of accepting one is a deletion outside the package. Proved against a
  // recorder: the question is which targets a run reaches, and nothing is removed to answer it.
  const removed = [];
  const record = (target) => {
    removed.push(target);
  };
  const refusing = (code) => (root, target) =>
    symlinkAncestorProblem(root, target, () => {
      throw fsError(code);
    }, (value) => value);
  assert.throws(
    () => generatedTargets("/somewhere/pkg", ["build/out"], refusing("EACCES")),
    /escapes the package root: build\/out — an ancestor could not be inspected \(EACCES\)/u,
  );
  assert.throws(
    () => generatedTargets("/somewhere/pkg", ["build/out"], refusing("EIO")),
    /an ancestor could not be inspected \(EIO\)/u,
  );
  // ENOENT is the one failure that states something: nothing is there to traverse.
  assert.deepEqual(
    generatedTargets("/somewhere/pkg", ["build/out"], refusing("ENOENT")),
    [path.resolve("/somewhere/pkg/build/out")],
  );
  assert.deepEqual(removed, []);
});

test("a scratch prefix that would create a directory somewhere else is refused", async () => {
  // `mkdtemp` appends to whatever it is handed: a separator moves the result, and an absolute
  // prefix ignores the base outright.
  for (const prefix of ["", "/absolute-", `a${path.sep}b-`, "a/b-", "a\\b-", ".", ".."]) {
    assert.equal(typeof scratchPrefixProblem(prefix), "string", JSON.stringify(prefix));
    await assert.rejects(() => scratchRoot(prefix), /scratch prefix/u, JSON.stringify(prefix));
  }
  assert.equal(scratchPrefixProblem("bachata-release-ok-"), undefined);
});

test("clean removes the generated directory and leaves maintained source alone", async () => {
  const root = await scratch();
  try {
    await write(root, "dist/built.js", "built");
    await write(root, "src/kept.ts", "kept");
    await write(root, "package.json", "{}");
    await cleanGenerated(root);
    assert.equal(existsSync(path.join(root, "dist")), false);
    assert.equal(existsSync(path.join(root, "src/kept.ts")), true);
    assert.equal(existsSync(path.join(root, "package.json")), true);
  } finally {
    await removeScratch(root);
  }
});

test("clean refuses a generated name reached through a symlink, and keeps what it points at", async () => {
  // SAFETY. `rm` unlinks a symbolic link rather than following it, so a `dist` that is a link is
  // removed as a link. What a lexical guard misses is a name *under* a link — `build/out` where
  // `build` points elsewhere is inside the package root as a string and outside it on disk.
  const root = await scratch();
  try {
    const pkg = await makeScratchChild(root, "pkg");
    const outside = await makeScratchChild(root, "outside");
    await write(outside, "keep.txt", "not clean's to delete");
    await symlink(outside, path.join(pkg, "build"));

    assert.throws(
      () => generatedTargets(pkg, ["build/out"]),
      /escapes the package root: build\/out — an ancestor is a symbolic link/u,
    );
    const removed = [];
    await assert.rejects(
      () => cleanGenerated(pkg, ["build/out"], (target) => {
        removed.push(target);
        return Promise.resolve();
      }),
      /escapes the package root: build\/out — an ancestor is a symbolic link/u,
    );
    assert.deepEqual(removed, [], "clean removed before it checked containment");
    assert.equal(existsSync(path.join(outside, "keep.txt")), true);

    // The link named directly is still removable, and removing it leaves what it points at.
    await write(root, "pkg/dist-link-target/built.js", "built");
    await symlink(path.join(root, "pkg/dist-link-target"), path.join(pkg, "dist"));
    await cleanGenerated(pkg);
    assert.equal(existsSync(path.join(pkg, "dist")), false);
    assert.equal(existsSync(path.join(root, "pkg/dist-link-target/built.js")), true);
  } finally {
    await removeScratch(root);
  }
});

test("cleaning a tree with nothing generated is not an error", async () => {
  const root = await scratch();
  try {
    await write(root, "src/kept.ts", "kept");
    await cleanGenerated(root);
    assert.equal(existsSync(path.join(root, "src/kept.ts")), true);
  } finally {
    await removeScratch(root);
  }
});

// --- which files the gates are answerable for --------------------------------------------
//
// `lint` and `format:check` enumerated `git ls-files -z`, which is tracked files and nothing
// else. Every file that had been written but not yet added was outside both gates — which is
// every file at the moment it is most likely to carry the mistake the gate exists to catch. The
// proof below runs the real script text over a real Git repository: a test that restated the
// enumeration would prove its own copy of the rule instead.

const gateGit = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const gateRepository = async (root) => {
  const repository = await makeScratchChild(root, "repository");
  gateGit(repository, "init", ".");
  gateGit(repository, "config", "user.name", "Test");
  gateGit(repository, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(repository, "scripts", "lib"), { recursive: true });
  for (const relative of [
    "lint.mjs",
    "format-check.mjs",
    path.join("lib", "candidateFiles.mjs"),
    path.join("lib", "containment.mjs"),
  ]) {
    await writeFile(
      path.join(repository, "scripts", relative),
      await readFile(path.join(repositoryRoot, "scripts", relative), "utf8"),
      "utf8",
    );
  }
  await write(repository, ".gitignore", "generated/\n");
  return repository;
};

const runGate = (repository, script) => {
  const result = spawnSync(process.execPath, [path.join("scripts", script)], {
    cwd: repository,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

test("both gates cover tracked and unignored untracked files, and no ignored ones", async () => {
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    // Untracked and clean, including names a newline-separated listing would quote and
    // re-encode — the files a gate that parsed quoted output would silently skip.
    await write(repository, "src/untracked.mjs", "export const untracked = 1;\n");
    await write(repository, "src/with space.mjs", "export const spaced = 1;\n");
    await write(repository, 'src/na\u00efve-"quoted".mjs', "export const unusual = 1;\n");
    // Ignored generated output, carrying both violations.
    await write(repository, "generated/ignored.mjs", "// @ts-ignore  \nexport const ignored = 1;\n");

    const enumerated = candidateFiles(repository);
    assert.ok(enumerated.includes("src/tracked.mjs"), JSON.stringify(enumerated));
    assert.ok(enumerated.includes("src/untracked.mjs"), JSON.stringify(enumerated));
    assert.ok(enumerated.includes("src/with space.mjs"), JSON.stringify(enumerated));
    assert.ok(enumerated.includes('src/na\u00efve-"quoted".mjs'), JSON.stringify(enumerated));
    assert.equal(enumerated.includes("generated/ignored.mjs"), false, "an ignored file was enumerated");
    assert.deepEqual(candidateFiles(repository), enumerated, "the enumeration is not deterministic");
    assert.equal(new Set(enumerated).size, enumerated.length, "the enumeration repeated a path");

    // Each gate says exactly how many eligible files it read out of how many candidates it
    // enumerated, rather than reporting the enumeration as the thing it checked.
    const lint = runGate(repository, "lint.mjs");
    assert.equal(lint.status, 0, lint.output);
    assert.match(lint.output, /Lint checked 8 of 8 eligible file\(s\), out of 9 candidates \(tracked and unignored untracked\), 1 skipped as ineligible and found no problems\./u);
    const format = runGate(repository, "format-check.mjs");
    assert.equal(format.status, 0, format.output);
    assert.match(format.output, /Format check passed for 8 of 8 eligible file\(s\), out of 9 candidates \(tracked and unignored untracked\), 1 skipped as ineligible\./u);
  } finally {
    await removeScratch(root);
  }
});

test("a lint violation in a file that was never added fails the gate", async () => {
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "lint.mjs").status, 0);

    await write(repository, "src/untracked.mjs", "// @ts-ignore\nexport const untracked = 1;\n");
    const failed = runGate(repository, "lint.mjs");
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /src\/untracked\.mjs:1: no-ts-ignore/u);
  } finally {
    await removeScratch(root);
  }
});

// BB-A4-N09. The code projection blanks a string's delimiters along with its contents, and the
// unconditional-skip rule then required one of those erased delimiters immediately after
// `.skip(`. The guard meant to prohibit a silently skipped case accepted one.
test("an unconditional skipped case fails the lint gate", async () => {
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "lint.mjs").status, 0);

    await write(
      repository,
      "tests/release.test.mjs",
      'test.skip("critical release scenario", () => {\n  throw new Error("failure");\n});\n',
    );
    const failed = runGate(repository, "lint.mjs");
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /tests\/release\.test\.mjs:1: no-unconditional-test-skip/u);
  } finally {
    await removeScratch(root);
  }
});

// The rule reads code, not prose: a skipped case named inside a comment or quoted in a string is
// not a skipped case.
test("the unconditional-skip rule ignores a mention inside a comment or a string", async () => {
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(
      repository,
      "tests/release.test.mjs",
      [
        '// test.skip("documented, not performed", () => {});',
        'const sample = \'test.skip("quoted", () => {});\';',
        "export const value = sample.length;",
        "",
      ].join("\n"),
    );
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    const passed = runGate(repository, "lint.mjs");
    assert.equal(passed.status, 0, passed.output);
  } finally {
    await removeScratch(root);
  }
});

test("a format violation in a file that was never added fails the gate", async () => {
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "format-check.mjs").status, 0);

    await write(repository, "src/untracked.mjs", "export const untracked = 1;   \n");
    const failed = runGate(repository, "format-check.mjs");
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /src\/untracked\.mjs: trailing whitespace on line 1/u);
  } finally {
    await removeScratch(root);
  }
});

test("a gate outside a Git checkout refuses rather than reporting nothing to check", async () => {
  const root = await scratch();
  try {
    const failing = () => ({ status: 128, stdout: "", stderr: "not a git repository" });
    assert.equal(candidateFiles(root, failing), undefined);
    // The deletion listing refuses the same way: a gate that could not ask Git which absent
    // files are meant to be absent cannot classify its own read failures.
    assert.equal(trackedDeletions(root, failing), undefined);
    // A run that produced no stdout at all is a failure too, not an empty tree.
    assert.equal(candidateFiles(root, () => ({ status: 0 })), undefined);
    assert.equal(trackedDeletions(root, () => ({ status: 0 })), undefined);
    assert.deepEqual([...trackedDeletions(root, () => ({ status: 0, stdout: "" }))], []);
  } finally {
    await removeScratch(root);
  }
});

test("the enumeration primitive carries no literal NUL byte", async () => {
  // The separator this module parses is a NUL. Writing it as a literal byte made the file itself
  // binary: `file` reported `data`, `grep` reported "binary file matches" instead of the line,
  // and a diff would not show a change to it. The escape is six ASCII characters and parses to
  // the same code unit.
  const modulePath = path.join(repositoryRoot, "scripts", "lib", "candidateFiles.mjs");
  const bytes = await readFile(modulePath);
  assert.equal(bytes.includes(0), false, "the module source contains a literal NUL byte");
  assert.match(bytes.toString("utf8"), /split\(NUL\)/u, "the module no longer splits on the NUL constant");
  const control = [...bytes].filter((byte) => byte < 9 || (byte > 10 && byte < 32) || byte === 127);
  assert.deepEqual(control, [], "the module source contains control bytes");
});

test("a gate counts what it read, not what it enumerated", async () => {
  // `candidateSummary(files)` reported every enumerated path as checked, so "Lint checked 537
  // candidate files" was false in two directions at once: neither gate checks every extension,
  // and both used to skip silently over any file they could not open. The counts close
  // arithmetically — eligible is exactly checked plus tracked deletions plus unreadable — so a
  // file cannot leave the accounting without being named.
  const eligible = (relative) => relative.endsWith(".mjs");
  const rejecting = (code) => Promise.reject(Object.assign(new Error(code), { code }));
  const result = await inspectCandidates({
    files: ["a.mjs", "b.mjs", "c.json", "gone.mjs", "opaque.mjs"],
    deletions: new Set(["gone.mjs"]),
    eligible,
    read: (relative) =>
      relative === "gone.mjs"
        ? rejecting("ENOENT")
        : relative === "opaque.mjs"
          ? rejecting("EACCES")
          : Promise.resolve(`// ${relative}\n`),
  });
  assert.deepEqual(result.counts, {
    enumerated: 5,
    eligible: 4,
    checked: 2,
    ineligible: 1,
    trackedDeletions: 1,
    unreadable: 1,
    refused: 0,
  });
  assert.equal(
    result.counts.eligible,
    result.counts.checked +
      result.counts.trackedDeletions +
      result.counts.unreadable +
      result.counts.refused,
    "the accounting does not close",
  );
  assert.deepEqual(result.inspected.map((entry) => entry.relative), ["a.mjs", "b.mjs"]);
  assert.deepEqual(result.problems, ["opaque.mjs: could not be read (EACCES)"]);
  assert.match(candidateSummary(result.counts), /^2 of 4 eligible file\(s\)/u);
  assert.match(candidateSummary(result.counts), /1 tracked deletion\(s\) skipped/u);
  assert.match(candidateSummary(result.counts), /1 unreadable/u);

  // A candidate that is absent and that Git does not record as a deleted tracked file is a third
  // thing: the tree changed while the gate was running. It is reported, not skipped.
  const raced = await inspectCandidates({
    files: ["gone.mjs"],
    deletions: new Set(),
    eligible,
    read: () => rejecting("ENOENT"),
  });
  assert.equal(raced.counts.trackedDeletions, 0);
  assert.equal(raced.counts.unreadable, 1);
  assert.match(raced.problems[0], /the tree changed while the gate was running/u);
  const codeless = await inspectCandidates({
    files: ["odd.mjs"],
    deletions: new Set(),
    eligible,
    read: () => Promise.reject(new Error("no code")),
  });
  assert.deepEqual(codeless.problems, ["odd.mjs: could not be read (no error code)"]);
});

test("an eligible file a gate cannot read fails the gate instead of vanishing from it", async () => {
  const root = await scratch();
  let opaque;
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "lint.mjs").status, 0);

    opaque = await write(repository, "src/opaque.mjs", "export const opaque = 1;\n");
    await chmod(opaque, 0o000);
    const lint = runGate(repository, "lint.mjs");
    assert.equal(lint.status, 1, lint.output);
    assert.match(lint.output, /src\/opaque\.mjs: could not be read \(EACCES\) — not checked/u);
    const format = runGate(repository, "format-check.mjs");
    assert.equal(format.status, 1, format.output);
    assert.match(format.output, /src\/opaque\.mjs: could not be read \(EACCES\) — not checked/u);
  } finally {
    if (opaque) await chmod(opaque, 0o600);
    await removeScratch(root);
  }
});

test("a tracked file deleted from the working tree is accounted for, not treated as checked", async () => {
  // `git ls-files --cached` lists index entries, so a deleted tracked file is still a candidate
  // and still fails to open. Git is the only thing that can say the absence is intended.
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    await write(repository, "src/removed.mjs", "export const removed = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    await rm(path.join(repository, "src/removed.mjs"));

    assert.ok(candidateFiles(repository).includes("src/removed.mjs"), "a deleted tracked file left the candidate set");
    assert.deepEqual([...trackedDeletions(repository)], ["src/removed.mjs"]);

    const lint = runGate(repository, "lint.mjs");
    assert.equal(lint.status, 0, lint.output);
    assert.match(lint.output, /1 tracked deletion\(s\) skipped/u);
    const format = runGate(repository, "format-check.mjs");
    assert.equal(format.status, 0, format.output);
    assert.match(format.output, /1 tracked deletion\(s\) skipped/u);
  } finally {
    await removeScratch(root);
  }
});

test("a filename cannot write a line of the gate's own output", async () => {
  // A newline is a legal byte in a path. A gate that prints one finding per line and interpolates
  // the path raw lets a filename append lines that read like the gate's own — including a line
  // that reads like a passing result, or one that blames a file that is fine.
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    const forged = "src/inject\n- src/decoy.mjs:1: no-ts-ignore: forged.mjs";
    await write(repository, forged, "// @ts-ignore\nexport const injected = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");

    assert.ok(candidateFiles(repository).includes(forged), "the NUL-separated listing lost the path");

    const lint = runGate(repository, "lint.mjs");
    assert.equal(lint.status, 1, lint.output);
    assert.equal(lint.output.match(/^- /gmu).length, 1, lint.output);
    assert.match(lint.output, /^- "src\/inject\\n- src\/decoy\.mjs:1: no-ts-ignore: forged\.mjs":1: no-ts-ignore/mu);
    assert.equal(
      /^- src\/decoy\.mjs:1: no-ts-ignore: forged$/mu.test(lint.output),
      false,
      "a filename wrote a line of the gate's output",
    );
    assert.equal(lint.output.includes("Lint found 1 problem(s):"), true, lint.output);
  } finally {
    await removeScratch(root);
  }
});

// --- source distribution ----------------------------------------------------------------

test("an exported source tree verifies as the package it came from", async () => {
  const root = await scratch();
  try {
    const target = path.join(root, "export");
    await exportSourceDistribution(target, repositoryRoot);
    assert.equal(await verifySourceDistribution(target), "bachata-browser-bridge");
  } finally {
    await removeScratch(root);
  }
});

test("an export is reproducible: two exports of one tree agree file for file", async () => {
  const root = await scratch();
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await exportSourceDistribution(first, repositoryRoot);
    await exportSourceDistribution(second, repositoryRoot);
    const names = async (base) => (await collectFiles(base)).map((entry) => entry.name);
    const firstNames = await names(first);
    assert.deepEqual(firstNames, await names(second));
    for (const name of firstNames) {
      assert.equal(
        await readFile(path.join(first, name), "utf8"),
        await readFile(path.join(second, name), "utf8"),
        name,
      );
    }
  } finally {
    await removeScratch(root);
  }
});

test("an exported tree is bound to its source: every file matches the repository byte for byte", async () => {
  const root = await scratch();
  try {
    const target = path.join(root, "export");
    await exportSourceDistribution(target, repositoryRoot);
    for (const entry of await collectFiles(target)) {
      assert.equal(
        await readFile(entry.path, "utf8"),
        await readFile(path.join(repositoryRoot, entry.name), "utf8"),
        entry.name,
      );
    }
  } finally {
    await removeScratch(root);
  }
});

test("an exported tree carries no build output, so verification is of source alone", async () => {
  const root = await scratch();
  try {
    const target = path.join(root, "export");
    await exportSourceDistribution(target, repositoryRoot);
    const names = (await collectFiles(target)).map((entry) => entry.name);
    assert.equal(names.some((name) => name.startsWith("dist/")), false);
    assert.equal(names.some((name) => name.startsWith("node_modules/")), false);
    // And it carries what a build needs, the lockfile included: an export that could not run
    // `npm ci` reproducibly would not be a source distribution of this package.
    assert.equal(names.includes("package.json"), true);
    assert.equal(names.includes("package-lock.json"), true);
    assert.equal(names.includes("manifest.json"), true);
  } finally {
    await removeScratch(root);
  }
});

test("an export that grew a file nothing accounts for fails verification by name", async () => {
  const root = await scratch();
  try {
    const target = path.join(root, "export");
    await exportSourceDistribution(target, repositoryRoot);
    await write(target, "stowaway.txt", "not maintained source");
    await assert.rejects(
      () => verifySourceDistribution(target),
      /stowaway\.txt: unknown top-level file/u,
    );
  } finally {
    await removeScratch(root);
  }
});

test("an export missing a required build input fails verification by name", async () => {
  const root = await scratch();
  try {
    const target = path.join(root, "export");
    await exportSourceDistribution(target, repositoryRoot);
    await rm(scratchChild(root, path.relative(root, path.join(target, "manifest.json"))));
    await assert.rejects(() => verifySourceDistribution(target), /manifest\.json/u);
  } finally {
    await removeScratch(root);
  }
});

test("an export carrying build output fails verification rather than being accepted", async () => {
  const root = await scratch();
  try {
    const target = path.join(root, "export");
    await exportSourceDistribution(target, repositoryRoot);
    await write(target, "dist/built.js", "built");
    await assert.rejects(() => verifySourceDistribution(target), /dist/u);
  } finally {
    await removeScratch(root);
  }
});

test("an export target inside the source package is refused before anything is written", async () => {
  const inside = path.join(repositoryRoot, "would-be-inside-export");
  await assert.rejects(
    () => exportSourceDistribution(inside, repositoryRoot),
    /(?:resolves )?inside the source package|must be outside the source package/u,
  );
  assert.equal(existsSync(inside), false, "a refused export created its target anyway");
});

test("an export with no target named is refused rather than defaulting somewhere", async () => {
  await assert.rejects(
    () => exportSourceDistribution(undefined, repositoryRoot),
    /requires an output directory/u,
  );
});

// --- the repository itself ---------------------------------------------------------------

test("nothing in this suite changed the repository, dirty state included", async () => {
  // Every test above works in a scratch directory or asserts a refusal. Three sentinel paths
  // could not see a suite that edited a tracked file, and this suite runs in a dirty tree where
  // "clean" is not the expected state. Git's own before-and-after answer is the check: the same
  // working-tree status, the same unstaged diff, the same staged diff. Nothing is normalized —
  // whatever was modified or untracked before is still modified or untracked, identically.
  const after = gitState();
  // BR-20. In an extracted distribution there is no checkout to compare against. The Git half
  // of this guard is checkout-only and `docs/DEVELOPMENT.md` names it as such; the halves below
  // it need no VCS and still run. An answer at only one end is a suite that acquired or lost a
  // checkout mid-run, which is neither state and fails.
  assert.equal(
    after === undefined,
    repositoryBefore === undefined,
    "Git answered for only one end of the comparison",
  );
  if (after !== undefined && repositoryBefore !== undefined) {
    assert.equal(after.status, repositoryBefore.status, "the working tree gained or lost a change");
    assert.equal(after.worktree, repositoryBefore.worktree, "an unstaged diff changed");
    assert.equal(after.index, repositoryBefore.index, "the index changed");
  }
  // `dist` is ignored, so Git says nothing about it: a redirected build must have left it byte
  // for byte, mtime for mtime, as it found it — including absent if it was absent.
  assert.deepEqual(await treeSnapshot(repositoryDist), repositoryDistBefore, "the built output changed");
  // And the named refusals really refused rather than writing and then failing.
  assert.equal(existsSync(path.join(repositoryRoot, "would-be-inside-export")), false);
  assert.equal(existsSync(path.join(repositoryRoot, "stowaway.txt")), false);
  assert.equal(existsSync(path.join(repositoryRoot, "NOTICES.txt")), false);
});


// CONTAINMENT OF THE CANDIDATE GATES. Separate from the release-package containment above: that
// governs what a ZIP may carry, this governs what `lint` and `format:check` may read. Both gates
// joined the repository root to an enumerated path and read it, so a tracked or unignored symbolic
// link pointing outside made the gate read and report on a file outside the tree it is answerable
// for. Reproduced before the fix in a scratch repository, where `format-check.mjs` reported the
// OUTSIDE target's trailing whitespace under the in-repository name.

test("an eligible symbolic link is refused by both gates rather than followed out of the repository", async () => {
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    const outside = await makeScratchChild(root, "outside");
    const target = path.join(outside, "outside.mjs");
    // The target carries both gates' violations, so following it is visible in either gate's
    // findings and not only in a count.
    await writeFile(target, "// @ts-ignore\nexport const outside = 1;   \n", "utf8");
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    await symlink(target, path.join(repository, "src", "linked.mjs"));
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    assert.equal(gateGit(repository, "ls-files", "-s", "src/linked.mjs").split(/\s+/u)[0], "120000");
    await symlink(target, path.join(repository, "src", "untracked_link.mjs"));

    for (const script of ["lint.mjs", "format-check.mjs"]) {
      const result = runGate(repository, script);
      assert.equal(result.status, 1, `${script} did not fail: ${result.output}`);
      assert.match(result.output, /src\/linked\.mjs: is a symbolic link/u);
      assert.match(result.output, /src\/untracked_link\.mjs: is a symbolic link/u);
      // The decisive assertion: nothing about the outside CONTENTS was reported. A gate that
      // followed the link reported `trailing whitespace on line 1` or `no-ts-ignore` against the
      // in-repository name.
      assert.equal(/linked\.mjs: trailing whitespace/u.test(result.output), false, result.output);
      assert.equal(/linked\.mjs:\d+: no-ts-ignore/u.test(result.output), false, result.output);
      assert.equal(result.output.match(/is a symbolic link/gu).length, 2, result.output);
    }
  } finally {
    await removeScratch(root);
  }
});

test("a link to an in-repository file is refused by the same one rule", async () => {
  // ONE POLICY. Every symbolic link is refused, whatever it points at. Resolving the target and
  // allowing links that stay inside would need a realpath comparison that is itself racy, and
  // would read the same bytes twice under two names. An in-repository target is already a
  // candidate under its own name, so refusing the link loses no coverage.
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/real.mjs", "export const real = 1;\n");
    await symlink(path.join(repository, "src", "real.mjs"), path.join(repository, "src", "alias.mjs"));
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");

    const result = runGate(repository, "format-check.mjs");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /src\/alias\.mjs: is a symbolic link/u);
    assert.equal(/src\/real\.mjs/u.test(result.output), false, result.output);
    assert.equal(result.output.match(/is a symbolic link/gu).length, 1, result.output);
  } finally {
    await removeScratch(root);
  }
});

test("the candidate reader never opens the path a link points at", async () => {
  // A recorder over the real `open`, so "the outside file was not read" is recorded rather than
  // inferred from the gate's output.
  const root = await scratch();
  try {
    const repository = await makeScratchChild(root, "repository");
    const outside = await makeScratchChild(root, "outside");
    const target = path.join(outside, "outside.mjs");
    await writeFile(target, "export const outside = 1;\n", "utf8");
    await mkdir(path.join(repository, "src"), { recursive: true });
    await writeFile(path.join(repository, "src", "real.mjs"), "export const real = 1;\n", "utf8");
    await symlink(target, path.join(repository, "src", "linked.mjs"));

    const opened = [];
    const { open } = await import("node:fs/promises");
    const read = containedReader({
      root: repository,
      open: (file, flags) => {
        opened.push(file);
        return open(file, flags);
      },
    });

    assert.equal(await read("src/real.mjs"), "export const real = 1;\n");
    await assert.rejects(() => read("src/linked.mjs"), /is a symbolic link/u);
    assert.equal(opened.includes(target), false, `the reader opened the outside target: ${JSON.stringify(opened)}`);
    assert.deepEqual(opened, [path.join(repository, "src", "real.mjs")]);
    // What the module claims about its own guarantee: on POSIX the open itself refuses the link,
    // so the refusal is race-free; on Windows the flag degrades to zero and the preceding `lstat`
    // is the only link defence, leaving a window this does not close.
    assert.equal(symlinkRefusalIsAtomic, process.platform !== "win32");
  } finally {
    await removeScratch(root);
  }
});

test("an eligible candidate that is not a regular file is refused, not silently checked", async () => {
  const root = await scratch();
  try {
    const repository = await makeScratchChild(root, "repository");
    // A directory carrying an eligible extension opens successfully on POSIX and is caught by the
    // `fstat` on the handle, not by anything about its name.
    await mkdir(path.join(repository, "src", "looks-like.mjs"), { recursive: true });
    const read = containedReader({ root: repository });
    await assert.rejects(() => read("src/looks-like.mjs"), /is a directory, and a gate reads regular files/u);

    // A FIFO is the case that would otherwise hang instead of failing: opening one for reading
    // blocks until a writer arrives, and `O_NONBLOCK` is what turns that into a refusal.
    const made = spawnSync("mkfifo", [path.join(repository, "src", "pipe.mjs")], { encoding: "utf8" });
    if (made.status === 0) {
      await assert.rejects(() => read("src/pipe.mjs"), /is a FIFO, and a gate reads regular files/u);
    }
  } finally {
    await removeScratch(root);
  }
});

test("a refusal is counted apart from a read, a deletion and an unexpected failure", async () => {
  const eligible = (relative) => relative.endsWith(".mjs");
  const failing = (code) => Object.assign(new Error(code || "no code"), ...(code ? [{ code }] : []));
  const reader = (stats, openBehaviour) =>
    containedReader({
      root: "/repository",
      lstat: () => (stats instanceof Error ? Promise.reject(stats) : Promise.resolve(stats)),
      open: openBehaviour,
    });
  const unreachable = () => Promise.reject(new Error("unreachable"));

  await assert.rejects(() => reader({ isSymbolicLink: () => true }, unreachable)("a.mjs"), /is a symbolic link/u);
  // An unexpected `lstat` or `open` failure is NOT converted into a refusal: it is an unexpected
  // error and has to fail the gate as one.
  for (const code of ["EACCES", "EIO", ""]) {
    await assert.rejects(
      () => reader(failing(code), unreachable)("a.mjs"),
      (error) => error.candidateRefusal === undefined,
      `an ${code || "codeless"} lstat failure was turned into a refusal`,
    );
    await assert.rejects(
      () => reader({ isSymbolicLink: () => false }, () => Promise.reject(failing(code)))("a.mjs"),
      (error) => error.candidateRefusal === undefined,
      `an ${code || "codeless"} open failure was turned into a refusal`,
    );
  }

  const refuse = (reason) => Promise.reject(Object.assign(new Error(reason), { candidateRefusal: reason }));
  const result = await inspectCandidates({
    files: ["read.mjs", "link.mjs", "dir.mjs", "gone.mjs", "opaque.mjs", "skip.json"],
    deletions: new Set(["gone.mjs"]),
    eligible,
    read: (relative) =>
      relative === "link.mjs"
        ? refuse("is a symbolic link, and a gate does not read through one to bytes outside the tree it is answerable for")
        : relative === "dir.mjs"
          ? refuse("is a directory, and a gate reads regular files")
          : relative === "gone.mjs"
            ? Promise.reject(failing("ENOENT"))
            : relative === "opaque.mjs"
              ? Promise.reject(failing("EACCES"))
              : Promise.resolve("export const read = 1;\n"),
  });
  assert.deepEqual(result.counts, {
    enumerated: 6,
    eligible: 5,
    checked: 1,
    ineligible: 1,
    trackedDeletions: 1,
    unreadable: 1,
    refused: 2,
  });
  assert.equal(
    result.counts.eligible,
    result.counts.checked +
      result.counts.trackedDeletions +
      result.counts.unreadable +
      result.counts.refused,
    "the accounting does not close",
  );
  assert.match(candidateSummary(result.counts), /2 refused/u);
  assert.equal(result.problems.length, 3);
  assert.match(result.problems.join("\n"), /link\.mjs: is a symbolic link/u);
  assert.match(result.problems.join("\n"), /dir\.mjs: is a directory/u);
  assert.match(result.problems.join("\n"), /opaque\.mjs: could not be read \(EACCES\)/u);

  // A tracked deletion still reads as a deletion when the reader is what reports ENOENT, and an
  // absent candidate with no tracked deletion behind it still reads as a changing tree.
  const raced = await inspectCandidates({
    files: ["gone.mjs"],
    deletions: new Set(),
    eligible,
    read: () => Promise.reject(failing("ENOENT")),
  });
  assert.equal(raced.counts.refused, 0);
  assert.equal(raced.counts.unreadable, 1);
  assert.match(raced.problems[0], /the tree changed while the gate was running/u);
});

// A stat answer for a named entry kind, with every predicate the reader's `entryKind` consults.
const kindStats = (kind) => ({
  isSymbolicLink: () => kind === "symlink",
  isFile: () => kind === "file",
  isDirectory: () => kind === "directory",
  isFIFO: () => kind === "fifo",
  isSocket: () => kind === "socket",
  isBlockDevice: () => kind === "block",
  isCharacterDevice: () => kind === "character",
});

test("a tracked file under a symbolic-link ancestor is refused, not read from outside the repository", async () => {
  // `git ls-files --cached` reads names out of the index, so Git never descends the working tree
  // for a tracked path to be enumerated: a directory replaced by a link after the fact still
  // yields every tracked name under it, with no link on the final component for `O_NOFOLLOW` to
  // catch. Against the reader that inspected the final component only, the format gate reported
  // the outside file's trailing whitespace under the in-repository name.
  const root = await scratch();
  try {
    const repository = await gateRepository(root);
    await write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    gateGit(repository, "add", "--all");
    gateGit(repository, "commit", "-m", "initial");
    const outside = await makeScratchChild(root, "outside");
    await writeFile(path.join(outside, "tracked.mjs"), "// @ts-ignore\nexport const outside = 1;   \n", "utf8");
    await rename(path.join(repository, "src"), path.join(repository, "src.real"));
    await symlink(outside, path.join(repository, "src"));
    assert.equal(gateGit(repository, "ls-files", "-s", "src/tracked.mjs").split(/\s+/u)[0], "100644");

    for (const script of ["lint.mjs", "format-check.mjs"]) {
      const result = runGate(repository, script);
      assert.equal(result.status, 1, `${script} did not fail: ${result.output}`);
      assert.match(result.output, /src\/tracked\.mjs: an ancestor is a symbolic link/u);
      assert.equal(
        /src\/tracked\.mjs: trailing whitespace/u.test(result.output),
        false,
        `${script} read through the ancestor: ${result.output}`,
      );
      assert.equal(
        /src\/tracked\.mjs:\d+: no-ts-ignore/u.test(result.output),
        false,
        `${script} read through the ancestor: ${result.output}`,
      );
    }
  } finally {
    await removeScratch(root);
  }
});

test("a repository root reached through a symbolic link is refused before any candidate is opened", async () => {
  const root = await scratch();
  try {
    const repository = await makeScratchChild(root, "repository");
    await mkdir(path.join(repository, "src"), { recursive: true });
    await writeFile(path.join(repository, "src", "real.mjs"), "export const real = 1;\n", "utf8");
    const linkedRoot = path.join(root, "linked-root");
    await symlink(repository, linkedRoot);

    const opened = [];
    const { open } = await import("node:fs/promises");
    const read = containedReader({
      root: linkedRoot,
      open: (file, flags) => {
        opened.push(file);
        return open(file, flags);
      },
    });
    await assert.rejects(() => read("src/real.mjs"), /the owned root is a symbolic link/u);
    assert.deepEqual(opened, []);
    assert.equal(await containedReader({ root: repository })("src/real.mjs"), "export const real = 1;\n");
  } finally {
    await removeScratch(root);
  }
});

test("an unanswerable containment question is a refusal, and a genuinely absent component is not", async () => {
  const failing = (code) => Object.assign(new Error(code || "no code"), ...(code ? [{ code }] : []));
  const reader = (overrides) =>
    containedReader({
      root: "/repository",
      resolveReal: (value) => value,
      inspectAncestor: () => kindStats("directory"),
      lstat: () => Promise.resolve(kindStats("file")),
      open: () => Promise.reject(new Error("unreachable")),
      ...overrides,
    });

  for (const code of ["EACCES", "EIO", "ELOOP", ""]) {
    await assert.rejects(
      () => reader({ resolveReal: () => { throw failing(code); } })("src/a.mjs"),
      (error) =>
        typeof error.candidateRefusal === "string" &&
        /the owned root could not be inspected/u.test(error.candidateRefusal),
      `an ${code || "codeless"} root inspection failure did not refuse`,
    );
    await assert.rejects(
      () => reader({ inspectAncestor: () => { throw failing(code); } })("src/a.mjs"),
      (error) =>
        typeof error.candidateRefusal === "string" &&
        /an ancestor could not be inspected/u.test(error.candidateRefusal),
      `an ${code || "codeless"} ancestor inspection failure did not refuse`,
    );
  }

  for (const code of ["ENOENT", "ENOTDIR"]) {
    await assert.rejects(
      () =>
        reader({
          inspectAncestor: () => { throw failing(code); },
          lstat: () => Promise.reject(failing("ENOENT")),
        })("src/a.mjs"),
      (error) => error.candidateRefusal === undefined && error.code === "ENOENT",
      `an ${code} ancestor turned into a refusal instead of an absence`,
    );
  }

  await assert.rejects(
    () => reader({})("../outside.mjs"),
    /resolves outside the repository the gate is answerable for/u,
  );

  // The lexical half of the same question, asked directly: one definition, used by the walk and
  // by the reader alike.
  assert.equal(escapesRoot("/repository", "/repository/src/a.mjs"), false);
  assert.equal(escapesRoot("/repository", "/repository"), false);
  assert.equal(escapesRoot("/repository", "/elsewhere/a.mjs"), true);
});

test("an ancestor link and a named non-regular entry are refused before any byte is read", async () => {
  const opened = [];
  const reader = (overrides) =>
    containedReader({
      root: "/repository",
      resolveReal: (value) => value,
      inspectAncestor: () => kindStats("directory"),
      lstat: () => Promise.resolve(kindStats("file")),
      open: (file) => {
        opened.push(file);
        return Promise.reject(new Error("unreachable"));
      },
      ...overrides,
    });

  await assert.rejects(
    () => reader({ inspectAncestor: () => kindStats("symlink") })("src/a.mjs"),
    /an ancestor is a symbolic link/u,
  );
  for (const [kind, expected] of [["directory", /is a directory/u], ["fifo", /is a FIFO/u], ["socket", /is a socket/u], ["block", /is a block device/u], ["character", /is a character device/u]]) {
    await assert.rejects(() => reader({ lstat: () => Promise.resolve(kindStats(kind)) })("src/a.mjs"), expected);
  }
  assert.deepEqual(opened, [], `a refused entry was opened: ${JSON.stringify(opened)}`);

  let closed = 0;
  await assert.rejects(
    () =>
      reader({
        open: () =>
          Promise.resolve({
            stat: () => Promise.resolve(kindStats("directory")),
            readFile: () => Promise.reject(new Error("a refused handle was read")),
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          }),
      })("src/a.mjs"),
    /is a directory, and a gate reads regular files/u,
  );
  assert.equal(closed, 1);
});
