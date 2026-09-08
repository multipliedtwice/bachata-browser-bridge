import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { removeScratch, scratchRoot } from "./support/scratch.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exporter = path.join(root, "scripts", "source-distribution.mjs");
const { collectMaintainedSourceFiles } = await import("../scripts/source-distribution.mjs");

const doesNotExist = async (candidate) => {
  await assert.rejects(access(candidate));
};

test("source exporter emits maintained source only and validator rejects artifacts", async () => {
  const parent = await scratchRoot("bachata-browser-source-");
  const output = path.join(parent, "export");
  try {
    const exported = await execFileAsync(
      process.execPath,
      [exporter, "export", output],
      { cwd: root, timeout: 30_000 },
    );
    assert.match(exported.stdout, /maintained source files/u);
    assert.equal(
      JSON.parse(await readFile(path.join(output, "package.json"), "utf8")).name,
      "bachata-browser-bridge",
    );
    await access(path.join(output, "src", "background", "index.ts"));
    // Continuous integration installs the exported tree with npm ci, so the lockfile is
    // part of the distribution.
    await access(path.join(output, "package-lock.json"));
    await access(path.join(output, "media", "readme-header.png"));
    await doesNotExist(path.join(output, "dist"));
    await doesNotExist(path.join(output, "generic-browser-verification.json"));

    await mkdir(path.join(output, "dist"));
    await writeFile(path.join(output, "dist", "generated.js"), "generated\n", "utf8");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [exporter, "verify", output],
        { cwd: root, timeout: 30_000 },
      ),
      /Source distribution validation failed/u,
    );
  } finally {
    await removeScratch(parent);
  }
});

test("source exporter refuses targets inside the source package", async () => {
  const candidate = path.join(root, `.bachata-source-export-${process.pid}-${Date.now()}`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [exporter, "export", candidate],
      { cwd: root, timeout: 30_000 },
    ),
    /outside the source package/u,
  );
  await doesNotExist(candidate);
});

test("source verification rejects packages missing required build inputs", async () => {
  const parent = await scratchRoot("bachata-browser-source-required-");
  const output = path.join(parent, "export");
  try {
    await execFileAsync(process.execPath, [exporter, "export", output], { cwd: root, timeout: 60_000 });
    await rm(path.join(output, "manifest.json"));
    await assert.rejects(
      execFileAsync(process.execPath, [exporter, "verify", output], { cwd: root, timeout: 60_000 }),
      /required maintained source entry is missing/u,
    );

    await rm(path.join(output, "src", "popup", "index.html"));
    await assert.rejects(
      execFileAsync(process.execPath, [exporter, "verify", output], { cwd: root, timeout: 60_000 }),
      /required build input is missing/u,
    );
  } finally {
    await removeScratch(parent);
  }
});

// Shared lexical-exclusion matrix. The same fixture file, byte for byte, lives in the
// Extension repository; the digest assertion below fails if either copy is edited alone.
const fixtures = JSON.parse(
  await readFile(path.join(root, "protocol", "source-export.fixtures.json"), "utf8"),
);

const SHARED_EXPORT_FIXTURE_SHA256 =
  "4bee20465b81f4d053ed3d25745a41ece0488625b740f3f10ba6f9f448bfa039";

test("the shared source-export fixture table cannot drift on one side", async () => {
  const bytes = await readFile(path.join(root, "protocol", "source-export.fixtures.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHARED_EXPORT_FIXTURE_SHA256);
  assert.equal(fixtures.id, "bachata-source-export-exclusion-v1");
});

const buildCaseTree = async (base, outside, testCase) => {
  const target = path.join(base, testCase.path);
  await mkdir(path.dirname(target), { recursive: true });
  if (testCase.type === "directory") {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "carried.txt"), "carried\n");
    return;
  }
  if (testCase.type === "file") {
    await writeFile(target, "carried\n");
    return;
  }
  // The link target lives outside the package, as a hoisted `node_modules` link does.
  const linkTarget = path.join(outside, "link-target");
  if (testCase.type === "symlink") {
    await mkdir(linkTarget, { recursive: true });
    await writeFile(path.join(linkTarget, "carried.txt"), "carried\n");
    await symlink(linkTarget, target);
    return;
  }
  await symlink(path.join(base, "absent-target"), target);
};

test("the exporter applies every shared exclusion case by name before type", async () => {
  for (const testCase of fixtures.cases) {
    const parent = await scratchRoot("bachata-browser-export-case-");
    const source = path.join(parent, "package");
    try {
      await mkdir(path.join(source, "src"), { recursive: true });
      await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "bachata-browser-bridge" }));
      await writeFile(path.join(source, "README.md"), "# fixture\n");
      await writeFile(path.join(source, "src", "index.ts"), "export const value = 1;\n");
      await buildCaseTree(source, parent, testCase);

      const collected = collectMaintainedSourceFiles(source);
      if (testCase.rejected) {
        await assert.rejects(
          collected,
          /symbolic links/u,
          `${testCase.name}: a carried symbolic link must be rejected`,
        );
        continue;
      }
      const files = await collected;
      const carried = files.some((relative) =>
        relative === testCase.path || relative.startsWith(`${testCase.path}/`));
      assert.equal(
        carried,
        !testCase.excluded,
        `${testCase.name}: expected excluded=${String(testCase.excluded)} for ${testCase.path}`,
      );
    } finally {
      await removeScratch(parent);
    }
  }
});

// Mirror of the Extension assertion. Each repository checks its own exporter, so neither
// suite needs to read across a sibling checkout.
test("this exporter declares only the package it belongs to", async () => {
  const bridge = await readFile(path.join(root, "scripts", "source-distribution.mjs"), "utf8");
  assert.match(bridge, /"bachata-browser-bridge": \{/u);
  assert.equal(
    /"bachata-vscode": \{/u.test(bridge),
    false,
    "the Browser Bridge exporter must not carry an unused bachata-vscode profile",
  );
});
