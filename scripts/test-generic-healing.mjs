import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(root, ".bachata-generic-test-"));
const require = createRequire(import.meta.url);

function transpile(relative) {
  const sourcePath = path.join(root, relative);
  const outputPath = path.join(temporary, relative.replace(/\.ts$/, ".cjs"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: sourcePath,
  });
  // A transpiled module still names its sibling by the `.js` specifier TypeScript requires;
  // here the sibling is emitted as `.cjs`, so relative specifiers follow it.
  fs.writeFileSync(
    outputPath,
    output.outputText.replace(/require\("(\.\.?\/[^"]+)\.js"\)/gu, 'require("$1.cjs")'),
  );
  return outputPath;
}

try {
  transpile("src/content/generic/schemaGuard.ts");
  const healing = require(transpile("src/content/generic/healing.ts"));
  const candidates = [
    { id: "c1", kindHint: "composer", tag: "textarea", contentEditable: false, rect: { x: 0, y: 0, width: 100, height: 20 }, domOrder: 1 },
    { id: "c2", kindHint: "conversationRoot", tag: "main", contentEditable: false, rect: { x: 0, y: 0, width: 100, height: 100 }, domOrder: 2 },
  ];
  const valid = healing.parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["c1"],
    conversationRootIds: ["c2"],
    sendButtonIds: [],
    stopButtonIds: [],
    responseMessageIds: [],
  }), candidates);
  assert.equal(valid.status, "selected");
  const invented = healing.parseHealingDecision(JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    status: "selected",
    composerIds: ["invented"],
    conversationRootIds: ["c2"],
    sendButtonIds: [],
    stopButtonIds: [],
    responseMessageIds: [],
  }), candidates);
  assert.equal(invented.status, "ambiguous");
  const repaired = healing.parseHealingDecision("{protocol:'bachata-dom-heal-v1',status:'ambiguous',composerIds:[],conversationRootIds:[],sendButtonIds:[],stopButtonIds:[],responseMessageIds:[]}", candidates);
  assert.equal(repaired.status, "ambiguous");
  const prompt = healing.buildHealingPrompt(candidates);
  assert.match(prompt, /Never return CSS, XPath, JavaScript, URLs, coordinates, or new IDs/);
  const responseCandidates = [
    { id: "m1", kindHint: "message", tag: "article", contentEditable: false, rect: { x: 0, y: 40, width: 100, height: 20 }, domOrder: 3 },
  ];
  const response = healing.parseResponseHealingDecision(JSON.stringify({
    protocol: "bachata-response-heal-v1",
    status: "selected",
    responseMessageIds: ["m1"],
  }), responseCandidates);
  assert.equal(response.status, "selected");
  assert.deepEqual(response.responseMessageIds, ["m1"]);
  const inventedResponse = healing.parseResponseHealingDecision(JSON.stringify({
    protocol: "bachata-response-heal-v1",
    status: "selected",
    responseMessageIds: ["invented"],
  }), responseCandidates);
  assert.equal(inventedResponse.status, "ambiguous");
  const responsePrompt = healing.buildResponseHealingPrompt(responseCandidates);
  assert.match(responsePrompt, /responseMessageIds/);

  console.log("Generic browser focused tests passed");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
