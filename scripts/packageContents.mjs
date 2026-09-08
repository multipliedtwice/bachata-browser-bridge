import { readdir } from "node:fs/promises";
import path from "node:path";
import { byCodeUnitOn } from "./lib/ordinal.mjs";

export const collectFiles = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Release packages do not permit symbolic links: ${name}`);
    }
    if (entry.isDirectory()) files.push(...await collectFiles(path.join(directory, entry.name), name));
    else if (entry.isFile()) files.push({ name, path: path.join(directory, entry.name) });
    else throw new Error(`Release package entry is not a regular file: ${name}`);
  }
  return files.sort(byCodeUnitOn((entry) => entry.name));
};

export const generatedAssets = [
  "manifest.json",
  "icon.png",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "popup/index.html",
  "generic-content.js",
];

export const expectedPackageEntries = async (sourceRoot = path.resolve("src")) => {
  const sources = await collectFiles(sourceRoot);
  const compiled = sources
    .filter((file) => file.name.endsWith(".ts") && !file.name.endsWith(".d.ts"))
    .map((file) => `${file.name.slice(0, -3)}.js`);
  return new Set([...compiled, ...generatedAssets]);
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value) => (Array.isArray(value) ? value : []);

/**
 * REVIEW-11. Every path a manifest points at, read from a manifest nothing has validated.
 *
 * The manifest comes out of a release archive, so its shape is whatever that archive holds. A
 * reader that spread `content_scripts` or `js` without checking would leave a candidate whose
 * manifest is a JSON object with a string where an array belongs failing as a raw `TypeError`
 * from inside the packager, rather than as a package-validation problem naming the field. So
 * every list is read as a list only when it is one, and what is not a list is reported by
 * `packagedManifestShapeProblems` rather than crashed on here.
 */
export const manifestReferences = (manifest) => [
  ...Object.values(isObject(manifest.icons) ? manifest.icons : {}),
  isObject(manifest.background) ? manifest.background.service_worker : undefined,
  isObject(manifest.action) ? manifest.action.default_popup : undefined,
  ...stringList(manifest.content_scripts)
    .filter(isObject)
    .flatMap((script) => [...stringList(script.js), ...stringList(script.css)]),
  ...stringList(manifest.web_accessible_resources)
    .filter(isObject)
    .flatMap((resource) => stringList(resource.resources)),
].filter((value) => typeof value === "string" && !value.includes("*"));

/**
 * REVIEW-11. What is wrong with a packaged manifest's own shape.
 *
 * These are the fields the packager reads to decide what a release refers to. A field of the
 * wrong shape is not a manifest that refers to nothing — it is a manifest whose references
 * cannot be read at all, so the check that every reference is present would silently pass on a
 * candidate nobody can verify. Each is named separately, and none of them stops the file and
 * notice checks from reporting what they found.
 */
export const packagedManifestShapeProblems = (manifest) => {
  const problems = [];
  const listField = (name, value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`Packaged manifest.json ${name} is not an array`);
      return [];
    }
    return value;
  };
  const objectField = (name, value) => {
    if (value !== undefined && !isObject(value)) {
      problems.push(`Packaged manifest.json ${name} is not an object`);
    }
  };
  objectField("background", manifest.background);
  objectField("icons", manifest.icons);
  objectField("action", manifest.action);
  listField("content_scripts", manifest.content_scripts).forEach((script, index) => {
    if (!isObject(script)) {
      problems.push(`Packaged manifest.json content_scripts[${String(index)}] is not an object`);
      return;
    }
    listField(`content_scripts[${String(index)}].js`, script.js);
    listField(`content_scripts[${String(index)}].css`, script.css);
  });
  listField("web_accessible_resources", manifest.web_accessible_resources).forEach((resource, index) => {
    if (!isObject(resource)) {
      problems.push(`Packaged manifest.json web_accessible_resources[${String(index)}] is not an object`);
      return;
    }
    listField(`web_accessible_resources[${String(index)}].resources`, resource.resources);
  });
  return problems;
};

// The packages whose notices must survive into the release ZIP. They are redistributed inside
// generic-content.js, so a ZIP without their notices is a ZIP that ships their code without
// their licence.
export const requiredNoticePackages = [
  "@medv/finder",
  "@mozilla/readability",
  "dom-accessibility-api",
  "jsonrepair",
  "turndown",
  "turndown-plugin-gfm",
];

/**
 * REVIEW-11. Everything the packager checks about a built ZIP, decided in one place so it can be
 * exercised without building one.
 *
 * Both directions are refused, not just one: a missing file means the build did not produce what
 * the sources say it should, and an unexpected file means something reached the release that
 * nothing accounts for. Neither is safe to ship, and only the second was ever cheap to notice.
 *
 * Every problem is collected rather than thrown at the first, so one run names everything wrong
 * with a candidate instead of one thing per rebuild. The three groups below are separate because
 * a candidate whose manifest cannot be parsed still has file problems worth naming, and a
 * verdict that stopped at the parse would hide them.
 */
export const packageFileProblems = (input) => {
  const problems = [];
  const present = new Set(input.entries);
  const expected = new Set(input.expected);
  const missing = [...expected].filter((name) => !present.has(name)).sort(byCodeUnitOn((name) => name));
  if (missing.length > 0) problems.push(`Release ZIP is missing ${missing.join(", ")}`);
  const unexpected = [...present].filter((name) => !expected.has(name)).sort(byCodeUnitOn((name) => name));
  if (unexpected.length > 0) problems.push(`Release ZIP contains unexpected files: ${unexpected.join(", ")}`);
  return problems;
};

export const packageManifestProblems = (input) => {
  const problems = [];
  const present = new Set(input.entries);
  if (input.manifestVersion !== input.version) {
    problems.push(
      `Packaged manifest version ${String(input.manifestVersion)} does not match package version ${String(input.version)}`,
    );
  }
  for (const reference of input.manifestReferences ?? []) {
    if (!present.has(reference)) problems.push(`Release ZIP is missing manifest reference ${reference}`);
  }
  return problems;
};

export const packageNoticeProblems = (input) => {
  const problems = [];
  for (const name of input.requiredNotices ?? requiredNoticePackages) {
    // The version matters: a notice naming the package without a version does not say which
    // code it covers.
    if (!String(input.notices ?? "").includes(`${name}@`)) problems.push(`Notices are missing ${name}`);
  }
  return problems;
};

export const packageProblems = (input) => [
  ...packageFileProblems(input),
  ...packageManifestProblems(input),
  ...packageNoticeProblems(input),
];

/**
 * REVIEW-11. The packager's verdict over the bytes a built ZIP actually contains.
 *
 * The runner used to read `manifest.json` and `THIRD_PARTY_NOTICES.txt` out of the archive and
 * parse the first of them before any verdict existed, so a candidate missing either one, or
 * carrying a manifest that is not JSON or not an object, died on a `TypeError` or a raw
 * `SyntaxError` instead of being reported as the invalid package it is — and took every
 * unrelated missing or unexpected file down with it, unreported.
 *
 * Reading the archive is the caller's job; deciding what its contents mean is this function's.
 * A manifest that cannot be read yields its own named problem and suppresses only the checks
 * that need a manifest, so the file-level and notice problems still arrive in the same verdict.
 */
export const packagedEntryProblems = (input) => {
  const entries = new Map(input.entries);
  const problems = [];
  let manifest;
  const manifestBytes = entries.get("manifest.json");
  if (manifestBytes === undefined) {
    problems.push("Release ZIP has no manifest.json to verify");
  } else {
    let parsed;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch (cause) {
      problems.push(
        `Packaged manifest.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (parsed !== undefined) {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push("Packaged manifest.json is not a JSON object");
      } else {
        manifest = parsed;
      }
    }
  }
  const noticeBytes = entries.get("THIRD_PARTY_NOTICES.txt");
  if (noticeBytes === undefined) problems.push("Release ZIP has no THIRD_PARTY_NOTICES.txt to verify");

  const names = [...entries.keys()];
  return [
    ...problems,
    ...packageFileProblems({ entries: names, expected: input.expected }),
    ...(manifest === undefined ? [] : packagedManifestShapeProblems(manifest)),
    ...(manifest === undefined
      ? []
      : packageManifestProblems({
          entries: names,
          manifestVersion: manifest.version,
          version: input.version,
          manifestReferences: manifestReferences(manifest),
        })),
    ...packageNoticeProblems({
      notices: noticeBytes === undefined ? "" : noticeBytes.toString("utf8"),
      ...(input.requiredNotices === undefined ? {} : { requiredNotices: input.requiredNotices }),
    }),
  ];
};
