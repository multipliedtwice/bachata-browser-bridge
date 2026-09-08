import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { byCodeUnit } from "./lib/ordinal.mjs";
import { npmInvocation } from "./lib/npmCommand.mjs";

// Every distribution of this package carries its own root lockfile, and `npm ci` — the
// only install continuous integration performs — requires one. A missing lockfile is
// therefore a defect in the tree, not a supported lockless mode.
const lockfile = path.join(process.cwd(), "package-lock.json");
if (!existsSync(lockfile)) {
  console.error(
    "No package-lock.json is present. The maintained-source distribution ships the root "
    + "lockfile so that npm ci installs the recorded closure; regenerate it with "
    + "`npm install --package-lock-only`.",
  );
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const sections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const inexact = sections.flatMap((section) => Object.entries(packageJson[section] ?? {})
  .filter(([, value]) => typeof value !== "string" || !exactVersion.test(value))
  .map(([name, value]) => `${section}.${name}=${String(value)}`));
if (inexact.length > 0) {
  console.error(`every declared dependency version must be exact:\n${inexact.join("\n")}`);
  process.exit(1);
}

// npm writes the root entry's object keys in its own order, so equality is compared on
// canonical key order rather than on raw text.
const canonical = (value) =>
  JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => byCodeUnit(left, right))));

// The lockfile's own root entry must describe this package, or `npm ci` installs a
// closure recorded for something else.
const lock = JSON.parse(readFileSync(lockfile, "utf8"));
const rootEntry = lock.packages?.[""] ?? {};
const mismatched = [
  ["name", lock.name, packageJson.name],
  ["version", lock.version, packageJson.version],
  ["packages[\"\"].name", rootEntry.name, packageJson.name],
  ["packages[\"\"].version", rootEntry.version, packageJson.version],
  ["packages[\"\"].license", rootEntry.license, packageJson.license],
  [
    "packages[\"\"].engines",
    canonical(rootEntry.engines),
    canonical(packageJson.engines),
  ],
].filter(([, recorded, declared]) => recorded !== declared);
if (mismatched.length > 0) {
  console.error(
    "package-lock.json root metadata does not match package.json; regenerate it with "
    + `\`npm install --package-lock-only\`:\n${
      mismatched.map(([field, recorded, declared]) => `${field}: lock ${String(recorded)} vs package ${String(declared)}`).join("\n")
    }`,
  );
  process.exit(1);
}

const invocation = npmInvocation(["ls", "--all", "--package-lock-only"]);
const result = spawnSync(invocation.command, invocation.args, {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
