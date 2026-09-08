import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createStoreZip, inspectStoreZip } from "./zip.mjs";
import {
  collectFiles,
  expectedPackageEntries,
  packagedEntryProblems,
} from "./packageContents.mjs";

const version = JSON.parse(await readFile(path.resolve("package.json"), "utf8")).version;
const output = path.resolve(process.env.BACHATA_BRIDGE_PACKAGE_OUTPUT ?? `bachata-browser-bridge-${version}.zip`);
await mkdir(path.dirname(output), { recursive: true });
const staging = path.join(path.dirname(output), `.${path.basename(output)}.staging-${process.pid}-${randomUUID()}`);
await createStoreZip(staging, await collectFiles(path.resolve("dist")));
try {
  const entries = await inspectStoreZip(staging);
  // Every problem at once: a candidate that is wrong in three ways should say so once, and a
  // manifest that cannot be read is one of those problems rather than the end of the verdict.
  const problems = packagedEntryProblems({
    entries,
    expected: await expectedPackageEntries(),
    version,
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));

  for (const name of ["background/index.js", "popup/index.js", "generic-content.js"]) {
    const result = spawnSync(process.execPath, ["--check", path.resolve("dist", name)], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Module smoke failed for ${name}: ${result.stderr}`);
  }
  await rename(staging, output);
  console.log(`Verified ${path.basename(output)} (${String(entries.size)} files)`);
} catch (error) {
  await rm(staging, { force: true });
  throw error;
}
