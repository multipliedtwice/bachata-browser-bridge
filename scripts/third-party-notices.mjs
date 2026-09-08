import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { byCodeUnit } from "./lib/ordinal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = (name) => path.join(root, "node_modules", ...name.split("/"));

const collectPackages = async (roots) => {
  const pending = [...roots];
  const packages = new Map();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || packages.has(name)) continue;
    const directory = packageRoot(name);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    packages.set(name, { directory, manifest });
    pending.push(...Object.keys(manifest.dependencies ?? {}));
  }
  return [...packages.entries()].sort(([left], [right]) => byCodeUnit(left, right));
};

export const generateThirdPartyNotices = async (output) => {
  const roots = [
    "@medv/finder",
    "@mozilla/readability",
    "dom-accessibility-api",
    "jsonrepair",
    "turndown",
    "turndown-plugin-gfm",
  ];
  const sections = [];
  for (const [name, value] of await collectPackages(roots)) {
    const files = (await readdir(value.directory))
      .filter((file) => /^(?:license|notice)(?:[-._].*)?$/iu.test(file))
      .sort(byCodeUnit);
    if (files.length === 0) throw new Error(`No license file found for ${name}`);
    const repository = typeof value.manifest.repository === "string"
      ? value.manifest.repository
      : value.manifest.repository?.url;
    const texts = await Promise.all(files.map(async (file) =>
      `--- ${file} ---\n${(await readFile(path.join(value.directory, file), "utf8")).trim()}`));
    sections.push([
      `${name}@${String(value.manifest.version)}`,
      `License: ${String(value.manifest.license ?? "see included text")}`,
      repository ? `Source: ${repository}` : undefined,
      "",
      texts.join("\n\n"),
    ].filter((line) => line !== undefined).join("\n"));
  }
  await writeFile(output, [
    "Bachata Browser Bridge third-party notices",
    "",
    "The following components are redistributed in generic-content.js.",
    "",
    sections.join("\n\n============================================================\n\n"),
    "",
  ].join("\n"), "utf8");
};
