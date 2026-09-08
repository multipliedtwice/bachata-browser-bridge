import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createStoreZip, inspectStoreZip } from "../scripts/zip.mjs";
import packageJson from "../package.json" with { type: "json" };
import { collectFiles, expectedPackageEntries, manifestReferences } from "../scripts/packageContents.mjs";
import { removeScratch, scratchRoot } from "./support/scratch.mjs";

const withTempDirectory = async (run) => {
  const directory = await scratchRoot("bachata-bridge-zip-");
  try {
    return await run(directory);
  } finally {
    await removeScratch(directory);
  }
};

const sampleArchive = async (directory, files = { "a.js": "export const a = 1;\n", "popup/index.html": "<!doctype html>\n" }) => {
  const entries = [];
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    entries.push({ name, path: target });
  }
  const archive = path.join(directory, "archive.zip");
  await createStoreZip(archive, entries);
  return archive;
};

const centralOffsetOf = (data) => {
  const endOffset = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return data.readUInt32LE(endOffset + 16);
};

test("store archives round-trip through the verifier", async () => {
  await withTempDirectory(async (directory) => {
    const archive = await sampleArchive(directory);
    const entries = await inspectStoreZip(archive);
    assert.deepEqual([...entries.keys()].sort(), ["a.js", "popup/index.html"]);
    assert.equal(entries.get("a.js").toString("utf8"), "export const a = 1;\n");
  });
});

test("the verifier rejects a compressed entry", async () => {
  await withTempDirectory(async (directory) => {
    const archive = await sampleArchive(directory);
    const data = await readFile(archive);
    data.writeUInt16LE(8, centralOffsetOf(data) + 10);
    await writeFile(archive, data);
    await assert.rejects(inspectStoreZip(archive), /not stored uncompressed/u);
  });
});

test("the verifier rejects corrupted entry data", async () => {
  await withTempDirectory(async (directory) => {
    const archive = await sampleArchive(directory);
    const data = await readFile(archive);
    const contentOffset = 30 + Buffer.byteLength("a.js");
    data[contentOffset] = data[contentOffset] ^ 0xff;
    await writeFile(archive, data);
    await assert.rejects(inspectStoreZip(archive), /CRC mismatch/u);
  });
});

test("the verifier rejects declared sizes that disagree", async () => {
  await withTempDirectory(async (directory) => {
    const archive = await sampleArchive(directory);
    const data = await readFile(archive);
    data.writeUInt32LE(data.readUInt32LE(centralOffsetOf(data) + 24) + 1, centralOffsetOf(data) + 24);
    await writeFile(archive, data);
    await assert.rejects(inspectStoreZip(archive), /sizes disagree/u);
  });
});

test("the verifier rejects trailing bytes after the end record", async () => {
  await withTempDirectory(async (directory) => {
    const archive = await sampleArchive(directory);
    await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from("residue")]));
    await assert.rejects(inspectStoreZip(archive), /end record not found/u);
  });
});

test("the verifier rejects duplicate and unsafe entry names", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "a.js");
    await writeFile(file, "export const a = 1;\n", "utf8");
    const duplicate = path.join(directory, "duplicate.zip");
    await createStoreZip(duplicate, [{ name: "a.js", path: file }, { name: "a.js", path: file }]);
    await assert.rejects(inspectStoreZip(duplicate), /Duplicate ZIP entry/u);

    const traversal = path.join(directory, "traversal.zip");
    await createStoreZip(traversal, [{ name: "../a.js", path: file }]);
    await assert.rejects(inspectStoreZip(traversal), /Unsafe ZIP entry/u);
  });
});

test("packaged entries are derived from sources plus generated assets", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "background"), { recursive: true });
    await writeFile(path.join(directory, "background", "index.ts"), "export const run = () => undefined;\n", "utf8");
    await writeFile(path.join(directory, "notes.md"), "ignored\n", "utf8");
    const expected = await expectedPackageEntries(directory);
    assert.equal(expected.has("background/index.js"), true);
    assert.equal(expected.has("notes.md"), false);
    assert.equal(expected.has("manifest.json"), true);
    assert.equal(expected.has("generic-content.js"), true);
  });
});

test("package collection rejects included symbolic links", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "target.js");
    await writeFile(target, "export const value = 1;\n", "utf8");
    await symlink(target, path.join(directory, "linked.js"));
    await assert.rejects(collectFiles(directory), /do not permit symbolic links: linked\.js/u);
  });
});

test("canonical package ordering uses code units independent of locale collation", async () => {
  await withTempDirectory(async (directory) => {
    // No case Bachata: this repository is developed on a case-insensitive filesystem, where
    // `A.js` and `a.js` are one file and the fixture silently loses an entry. These four
    // still separate the two orderings — code units put `ä` last, locale collation sorts it
    // beside `A` — which is the property under test.
    const names = ["z.js", "ä.js", "A.js", "b.js"];
    for (const name of names) {
      await writeFile(path.join(directory, name), `${name}\n`, "utf8");
    }
    const collected = (await collectFiles(directory)).map((entry) => entry.name);
    assert.equal(collected.length, names.length, "a fixture entry was lost before ordering");
    assert.deepEqual(collected, ["A.js", "b.js", "z.js", "ä.js"]);
    assert.notDeepEqual(
      collected,
      [...names].sort((left, right) => left.localeCompare(right)),
      "the collector reproduced locale collation rather than code-unit order",
    );
  });
});

test("manifest references are extracted for packaging verification", () => {
  assert.deepEqual(
    manifestReferences({
      background: { service_worker: "background/index.js" },
      action: { default_popup: "popup/index.html" },
      web_accessible_resources: [{ resources: ["generic-content.js", "assets/*"] }],
    }),
    ["background/index.js", "popup/index.html", "generic-content.js"],
  );
});

test("the release package rejects stale build residue", async () => {
  await withTempDirectory(async (directory) => {
    const expected = await expectedPackageEntries(path.resolve("src"));
    const archive = path.join(directory, `bachata-browser-bridge-${packageJson.version}.zip`);
    await createStoreZip(archive, await collectFiles(path.resolve("dist")));
    const entries = await inspectStoreZip(archive);
    const unexpected = [...entries.keys()].filter((name) => !expected.has(name));
    const missing = [...expected].filter((name) => !entries.has(name));
    assert.deepEqual(unexpected, []);
    assert.deepEqual(missing, []);
  });
});
