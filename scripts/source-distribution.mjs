import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { byCodeUnit, byCodeUnitOn } from "./lib/ordinal.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const profiles = {
  "bachata-browser-bridge": {
    files: new Set([
      ".gitattributes",
      ".gitignore",
      "CHANGELOG.md",
      "LICENSE",
      "NO_TELEMETRY.md",
      "README.md",
      "TODO.md",
      "manifest.json",
      "package-lock.json",
      "package.json",
      "tsconfig.json",
    ]),
    directories: new Set([".github", "docs", "media", "protocol", "scripts", "src", "tests"]),
    required: new Set([
      "CHANGELOG.md",
      "LICENSE",
      "NO_TELEMETRY.md",
      "README.md",
      "manifest.json",
      "package-lock.json",
      "package.json",
      "tsconfig.json",
      "docs",
      "protocol",
      "scripts",
      "src",
      "tests",
    ]),
    requiredFiles: new Set([
      "media/readme-header.png",
      // BB-A4-F08. `tests/releaseWorkflow.test.mjs` reads this file unconditionally, so an
      // export without it cannot run the suite it ships. The export carries it; requiring it
      // is what stops a future export losing it and still verifying clean.
      ".github/workflows/release-artifact.yml",
      "protocol/browser-protocol-v9.contract.json",
      "scripts/package.mjs",
      "scripts/zip.mjs",
      "src/background/index.ts",
      "src/popup/index.html",
      "src/popup/index.ts",
      "src/protocol/types.ts",
    ]),
  },
};

const forbiddenDirectoryNames = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nyc_output",
  ".parcel-cache",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const forbiddenFileNames = new Set([
  ".DS_Store",
  "Thumbs.db",
  "VALIDATION.txt",
  "generic-browser-verification.json",
  "managed-fallback-verification.json",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const forbiddenSuffixes = [
  ".bak",
  ".db",
  ".db-shm",
  ".db-wal",
  ".log",
  ".map",
  ".orig",
  ".rej",
  ".sqlite",
  ".sqlite3",
  ".swo",
  ".swp",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tsbuildinfo",
  ".vsix",
  ".zip",
];

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

const normalizeRelative = (value) => value.split(path.sep).join("/");

// Only the package root lockfile is maintained source. A lockfile anywhere below it
// belongs to a nested install and is never part of the distribution.
const rootOnlyFileNames = new Set(["package-lock.json"]);

const isForbiddenFile = (name) => {
  if (forbiddenFileNames.has(name)) {
    return true;
  }
  const lower = name.toLowerCase();
  if (
    lower === ".env"
    || (lower.startsWith(".env.") && lower !== ".env.example")
    // Worktree lock files and the reclaim intents beside them are run state, never source.
    || lower.startsWith(".bachata-worktree.")
    || lower.endsWith(".lock")
    || lower.endsWith(".lock.json")
  ) {
    return true;
  }
  return forbiddenSuffixes.some((suffix) => lower.endsWith(suffix));
};

// Exclusion is lexical: it is decided from the path segments alone, before any lstat,
// Dirent type test or realpath. A managed worktree keeps `.git` as a file and links
// `node_modules`, and a symbolic link reports neither file nor directory, so gating the
// name check on a resolved type let exactly those layouts past it and into the symlink
// rejection below. A forbidden name is excluded at every depth, so a nested `.git` is
// never exported. Symlink rejection still applies to every entry the manifest carries.
const isForbiddenRelativePath = (relativePath) => {
  const normalized = normalizeRelative(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  const name = segments.at(-1) ?? "";
  if (segments.length === 1 && rootOnlyFileNames.has(name)) {
    return false;
  }
  if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
    return true;
  }
  if (
    segments.includes("cypress")
    && (segments.includes("screenshots") || segments.includes("videos") || segments.includes("downloads"))
  ) {
    return true;
  }
  return isForbiddenFile(name);
};

const readProfile = async (root) => {
  let packageValue;
  try {
    packageValue = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Source distribution root has no readable package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const profile = profiles[packageValue?.name];
  if (!profile) {
    throw new Error(`Unsupported source distribution package: ${String(packageValue?.name ?? "unknown")}`);
  }
  return { profile, packageName: packageValue.name };
};

const assertTopLevelAllowed = (profile, name, directory) => {
  if (directory) {
    if (!profile.directories.has(name)) {
      throw new Error(`Unknown top-level directory is not maintained source: ${name}`);
    }
    return;
  }
  if (!profile.files.has(name)) {
    throw new Error(`Unknown top-level file is not maintained source: ${name}`);
  }
};

const collectDirectory = async (rootReal, directory, relativeDirectory, files) => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort(byCodeUnitOn((entry) => entry.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? path.join(relativeDirectory, entry.name)
      : entry.name;
    const absolutePath = path.join(directory, entry.name);
    // Same lexical gate as the root walker, and for the same reason: a nested `node_modules`
    // link or `.git` entry must be skipped by name before its type is ever consulted.
    if (isForbiddenRelativePath(relativePath)) {
      continue;
    }
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Source distributions do not permit symbolic links: ${normalizeRelative(relativePath)}`);
    }
    if (info.isDirectory()) {
      const resolved = await realpath(absolutePath);
      if (!isInside(rootReal, resolved)) {
        throw new Error(`Source directory resolves outside the package root: ${normalizeRelative(relativePath)}`);
      }
      await collectDirectory(rootReal, resolved, relativePath, files);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Source entry is not a regular file: ${normalizeRelative(relativePath)}`);
    }
    const resolved = await realpath(absolutePath);
    if (!isInside(rootReal, resolved)) {
      throw new Error(`Source file resolves outside the package root: ${normalizeRelative(relativePath)}`);
    }
    files.push(normalizeRelative(relativePath));
  }
};

export const collectMaintainedSourceFiles = async (root = scriptRoot) => {
  const rootReal = await realpath(root);
  const { profile } = await readProfile(rootReal);
  const entries = await readdir(rootReal, { withFileTypes: true });
  entries.sort(byCodeUnitOn((entry) => entry.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = path.join(rootReal, entry.name);
    if (isForbiddenRelativePath(relativePath)) {
      continue;
    }
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Source distributions do not permit symbolic links: ${relativePath}`);
    }
    if (info.isDirectory()) {
      assertTopLevelAllowed(profile, entry.name, true);
      const resolved = await realpath(absolutePath);
      if (!isInside(rootReal, resolved)) {
        throw new Error(`Source directory resolves outside the package root: ${relativePath}`);
      }
      await collectDirectory(rootReal, resolved, relativePath, files);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Source entry is not a regular file: ${relativePath}`);
    }
    assertTopLevelAllowed(profile, entry.name, false);
    files.push(relativePath);
  }
  return files.sort(byCodeUnit);
};

const existingAncestor = async (candidate) => {
  let current = candidate;
  for (;;) {
    try {
      return { lexical: current, real: await realpath(current) };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Cannot resolve an existing parent for ${candidate}`);
      }
      current = parent;
    }
  }
};

const assertSafeExportTarget = async (sourceRootReal, target) => {
  const absolute = path.resolve(target);
  if (isInside(sourceRootReal, absolute)) {
    throw new Error("Source export target must be outside the source package");
  }
  try {
    await lstat(absolute);
    throw new Error(`Source export target already exists: ${absolute}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const parent = path.dirname(absolute);
  const ancestor = await existingAncestor(parent);
  const tail = path.relative(ancestor.lexical, absolute);
  const projected = path.resolve(ancestor.real, tail);
  if (isInside(sourceRootReal, projected)) {
    throw new Error("Source export target resolves inside the source package");
  }
  return absolute;
};

export const verifySourceDistribution = async (root) => {
  const rootReal = await realpath(root);
  const { profile, packageName } = await readProfile(rootReal);
  const violations = [];
  const required = profile.required ?? new Set(["package.json", "README.md", "src"]);
  const requiredFiles = profile.requiredFiles ?? new Set();
  const seenTopLevel = new Set();
  const seenFiles = new Set();

  const visit = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(byCodeUnitOn((entry) => entry.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const normalized = normalizeRelative(relativePath);
      if (!relativeDirectory) {
        seenTopLevel.add(entry.name);
      }
      const absolutePath = path.join(directory, entry.name);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        violations.push(`${normalized}: cannot stat (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (info.isSymbolicLink()) {
        violations.push(`${normalized}: symbolic link`);
        continue;
      }
      if (info.isDirectory()) {
        if (isForbiddenRelativePath(relativePath)) {
          violations.push(`${normalized}/: generated/artifact directory`);
          continue;
        }
        if (!relativeDirectory && !profile.directories.has(entry.name)) {
          violations.push(`${normalized}/: unknown top-level directory`);
          continue;
        }
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile()) {
        violations.push(`${normalized}: not a regular file`);
        continue;
      }
      if (isForbiddenRelativePath(relativePath)) {
        violations.push(`${normalized}: generated/artifact/lock file`);
        continue;
      }
      seenFiles.add(normalized);
      if (!relativeDirectory && !profile.files.has(entry.name)) {
        violations.push(`${normalized}: unknown top-level file`);
      }
    }
  };

  await visit(rootReal);
  for (const requiredName of required) {
    if (!seenTopLevel.has(requiredName)) {
      violations.push(`${requiredName}: required maintained source entry is missing`);
    }
  }
  for (const requiredFile of requiredFiles) {
    if (!seenFiles.has(requiredFile)) {
      violations.push(`${requiredFile}: required build input is missing`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Source distribution validation failed for ${packageName}:\n${violations.map((value) => `- ${value}`).join("\n")}`,
    );
  }
  return packageName;
};

export const exportSourceDistribution = async (target, root = scriptRoot) => {
  if (!target) {
    throw new Error("Source export requires an output directory");
  }
  const rootReal = await realpath(root);
  const targetPath = await assertSafeExportTarget(rootReal, target);
  const files = await collectMaintainedSourceFiles(rootReal);
  const temporaryPath = `${targetPath}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  await mkdir(temporaryPath, { recursive: false });
  try {
    for (const relativePath of files) {
      const source = path.join(rootReal, relativePath);
      const destination = path.join(temporaryPath, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error(`Source entry changed while exporting: ${relativePath}`);
      }
      const resolved = await realpath(source);
      if (!isInside(rootReal, resolved)) {
        throw new Error(`Source entry escaped the package while exporting: ${relativePath}`);
      }
      await copyFile(resolved, destination);
      await chmod(destination, sourceInfo.mode & 0o777);
    }
    await verifySourceDistribution(temporaryPath);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { targetPath, files };
};

const main = async () => {
  const [command, target] = process.argv.slice(2);
  if (command === "export") {
    const result = await exportSourceDistribution(target);
    console.log(`Exported ${String(result.files.length)} maintained source files to ${result.targetPath}`);
    return;
  }
  if (command === "verify") {
    if (!target) {
      throw new Error("Source verification requires a directory");
    }
    const packageName = await verifySourceDistribution(path.resolve(target));
    console.log(`Source distribution is clean: ${packageName}`);
    return;
  }
  throw new Error(
    "Usage: node scripts/source-distribution.mjs export <empty-output-dir> | verify <source-export-dir>",
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
