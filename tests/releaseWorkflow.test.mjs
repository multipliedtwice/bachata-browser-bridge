import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github", "workflows", "release-artifact.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

const lineOf = (needle) => {
  const index = workflow.indexOf(needle);
  assert.ok(index >= 0, `release-artifact.yml does not contain ${JSON.stringify(needle)}`);
  return workflow.slice(0, index).split("\n").length;
};

// BB-AUD-05. An `upload-artifact` step makes its artifact downloadable the moment it
// finishes. A gate placed after the uploads cannot withdraw what it rejects: the failing run
// still leaves a complete, fetchable artifact set behind, and a consumer that only asks for a
// run id would take it.

test("source drift is refused before the first artifact is published", () => {
  const drift = lineOf("Refuse source drift from packaging");
  const firstUpload = lineOf("actions/upload-artifact@v4");
  assert.ok(
    drift < firstUpload,
    `the drift gate is at line ${String(drift)}, after the first upload at ${String(firstUpload)}`,
  );
});

test("every upload happens after the drift gate", () => {
  const drift = lineOf("Refuse source drift from packaging");
  const uploads = [];
  let cursor = workflow.indexOf("actions/upload-artifact@v4");
  while (cursor >= 0) {
    uploads.push(workflow.slice(0, cursor).split("\n").length);
    cursor = workflow.indexOf("actions/upload-artifact@v4", cursor + 1);
  }
  assert.ok(uploads.length >= 3, `expected three uploads, saw ${String(uploads.length)}`);
  for (const upload of uploads) {
    assert.ok(upload > drift, `an upload at line ${String(upload)} precedes the drift gate`);
  }
});

test("the gates this repository has all run before packaging", () => {
  const packaged = lineOf("run: npm run package");
  for (const gate of [
    "run: npm run check-types",
    "run: npm run lint",
    "run: npm run format:check",
    "run: npm run test:coverage",
  ]) {
    assert.ok(
      lineOf(gate) < packaged,
      `${gate} runs after packaging, so the archive is not covered by it`,
    );
  }
});

test("the published set carries the archive, its digest, the contract, the fixtures and the build", () => {
  for (const needed of [
    ".sha256",
    "protocol/browser-protocol-v9.contract.json",
    "protocol/source-export.fixtures.json",
    "protocol/asset-name.fixtures.json",
    "path: dist",
  ]) {
    assert.ok(workflow.includes(needed), `the workflow never publishes ${needed}`);
  }
  // Without the build, the Extension's `verifyBridgeArchive` cannot compare the archive
  // against what it was packaged from and fails on a missing build directory.
  assert.match(workflow, /browser-bridge-dist-\$\{\{ steps\.archive\.outputs\.version \}\}/u);
});

test("a missing artifact fails the upload rather than publishing nothing", () => {
  const uploads = workflow.split("actions/upload-artifact@v4").slice(1);
  for (const [index, block] of uploads.entries()) {
    assert.match(
      block.slice(0, 500),
      /if-no-files-found: error/u,
      `upload ${String(index + 1)} would silently publish an empty artifact`,
    );
  }
});
