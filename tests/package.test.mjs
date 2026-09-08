import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("the store icon is packaged at its declared dimensions", async () => {
  const manifest = await loadJson(new URL("../dist/manifest.json", import.meta.url));
  assert.equal(manifest.icons["128"], "icon.png");
  const icon = await readFile(new URL("../dist/icon.png", import.meta.url));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});

test("built manifest is a minimal ChatGPT and Claude transport", async () => {
  const manifest = await loadJson(new URL("../dist/manifest.json", import.meta.url));
  const packageJson = await loadJson(new URL("../package.json", import.meta.url));

  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual(manifest.permissions, ["activeTab", "alarms", "clipboardRead", "contextMenus", "favicon", "scripting", "storage", "tabs", "webNavigation"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "http://127.0.0.1/*",
    "http://localhost/*",
    "https://127.0.0.1/*",
    "https://localhost/*",
  ]);
  assert.equal(manifest.background.service_worker, "background/index.js");
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background.type, "module");
});

test("only the active browser protocol contract ships", async () => {
  const contract = await loadJson(
    new URL("../protocol/browser-protocol-v9.contract.json", import.meta.url),
  );
  assert.equal(contract.protocolVersion, 9);
  await assert.rejects(
    readFile(new URL("../protocol/browser-protocol-v8.contract.json", import.meta.url), "utf8"),
  );
});

test("browser protocol contains no local execution messages", async () => {
  const source = await readFile(
    new URL("../src/protocol/types.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /shell\.run|workspace\.write|tool\.request/);
});

test("ChatGPT adapter uses strict provider controls rather than generic fallbacks", async () => {
  const source = await readFile(
    new URL("../src/content/chatgpt.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /data-testid='send-button'/);
  assert.match(source, /data-testid='stop-button'/);
  assert.doesNotMatch(source, /form button\[type='submit'\]/);
  assert.doesNotMatch(source, /main \[contenteditable='true'\]/);
  assert.doesNotMatch(source, /aria-label\*='Stop'|aria-label\*='Send'/);
});


test("provider readiness does not require a pre-input send control", async () => {
  for (const provider of ["chatgpt", "claude"]) {
    const source = await readFile(
      new URL(`../src/content/${provider}.ts`, import.meta.url),
      "utf8",
    );
    const statusStart = source.indexOf("const providerStatus =");
    const statusEnd = source.indexOf("const registration =", statusStart);
    const statusSource = source.slice(statusStart, statusEnd);
    assert.doesNotMatch(statusSource, /if \(!sendButton\(\)\)/);
  }
});

test("provider submission writes and verifies the prompt before resolving the enabled send control", async () => {
  for (const provider of ["chatgpt", "claude"]) {
    const source = await readFile(
      new URL(`../src/content/${provider}.ts`, import.meta.url),
      "utf8",
    );
    const writeIndex = source.indexOf("writeComposer(element, request.text)");
    const sendIndex = source.indexOf("await waitForEnabledSendButton(", writeIndex);
    assert.notEqual(writeIndex, -1, `${provider} does not write its composer`);
    assert.notEqual(sendIndex, -1, `${provider} does not resolve an enabled send control`);
    assert.ok(writeIndex < sendIndex, `${provider} resolves send before writing the prompt`);
  }
});

test("background validates active content-script sender and guards stale sockets", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /validActiveSender/);
  // BB-AUD-09. Whether a message names the request's own document is decided in
  // `routerState.ts`; the entry reads the sender and applies the verdict.
  const routerState = await readFile(
    new URL("../src/background/routerState.ts", import.meta.url),
    "utf8",
  );
  assert.match(routerState, /request\.documentToken !== binding\.documentToken/);
  assert.match(routerState, /request\.documentToken === binding\.documentToken/);
  assert.match(source, /if \(nextSocket !== socket\)/);
  assert.match(source, /type: "bridge\.ping"/);
});


test("provider code is injected only after explicit tab handling", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /content\/chatgptLogic\.js/);
  assert.match(source, /content\/chatgpt\.js/);
  assert.match(source, /content\/claudeLogic\.js/);
  assert.match(source, /content\/claude\.js/);
});

test("protocol contract matches the browser implementation", async () => {
  const contract = await loadJson(
    new URL("../protocol/browser-protocol-v9.contract.json", import.meta.url),
  );
  const source = await readFile(
    new URL("../src/protocol/types.ts", import.meta.url),
    "utf8",
  );
  assert.equal(contract.protocolVersion, 9);
  assert.equal(contract.endpointPath, "/bachata-browser-bridge-v9");
  for (const type of [
    ...contract.clientMessageTypes,
    ...contract.serverMessageTypes,
  ]) {
    assert.equal(
      source.includes(`"${type}"`),
      true,
      `Missing protocol message ${type}`,
    );
  }
});

test("background serializes server messages and preserves queued interrupts", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /let serverMessageQueue = Promise\.resolve\(\)/);
  assert.match(source, /serverMessageQueue\.then\(\(\) =>\s*handleServerMessage/);
  assert.match(source, /requestOrdering\.recordInterrupt\(message\.requestId\)/);
  assert.match(source, /acknowledgeInterrupted\(request, true\)/);
  assert.match(source, /cancelled && registered/);
});

test("background revisions provider status and holds accepted navigation transitions", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /providerStatusRevision/);
  assert.match(source, /providerStatusQueue/);
  assert.match(source, /hasActiveInitialTransition/);
  // BB-AUD-09. What a tab change means is decided in `tabChange.ts`, which is where the
  // pending-transition suppression now lives.
  const tabChange = await readFile(
    new URL("../src/background/tabChange.ts", import.meta.url),
    "utf8",
  );
  assert.match(tabChange, /suppressRefresh: permittedPendingTransition/);
  assert.match(source, /urlVerdict\.suppressRefresh/);
});

test("background keepalive requires the matching pong before its deadline", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /pendingKeepAliveNonce/);
  assert.match(source, /keepAliveDeadlineTimer/);
  assert.match(source, /message\.nonce === pendingKeepAliveNonce/);
  assert.match(source, /eventSocket\.close\(\)/);
});

test("content adapter keeps uncertain post-click requests blocked until idle", async () => {
  const source = await readFile(
    new URL("../src/content/chatgpt.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /monitorIndeterminateRequest/);
  assert.match(source, /may still be generating/);
  assert.match(source, /await interruptAndConfirm/);
});

test("popup preserves valid state and ignores stale action responses", async () => {
  const source = await readFile(
    new URL("../src/popup/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /isErrorResponse/);
  assert.match(source, /const apply = async/);
  assert.match(source, /response\.revision >= state\.revision/);
  assert.match(source, /\.\.\.state,[\s\S]*error: response\.error/);
  assert.match(source, /if \(mergeState\(await call\(\{ type: "popup\.getState" \}\)\)\) \{/);
  assert.match(source, /type: "popup\.deselect"/);
  assert.match(source, /setDisabled\(dom\.pair, pending/);
  assert.equal(source.includes("innerHTML"), false);
});



test("popup keeps pairing drafts locally and exposes exact provider readiness", async () => {
  const popup = await readFile(
    new URL("../src/popup/index.ts", import.meta.url),
    "utf8",
  );
  const background = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  for (const marker of [
    "let endpointDraft",
    "let tokenDraft",
    "dom.endpointInput !== document.activeElement",
    "endpointDirty",
    "conversationIdentity",
    "tab.status",
    "tab.reason",
    "disabled",
  ]) {
    assert.equal(popup.includes(marker), true, `Missing popup marker: ${marker}`);
  }
  const projection = await readFile(
    new URL("../src/background/popupProjection.ts", import.meta.url),
    "utf8",
  );

  for (const marker of ["popupStatusReason", "buildPopupTabs", "projectPopupTabs"]) {
    assert.equal(background.includes(marker), true, `Missing background marker: ${marker}`);
  }
  for (const marker of [
    "popupStatusReason",
    'const status = session?.status ?? "unregistered"',
    'ready: status === "ready"',
    "conversationIdentity",
  ]) {
    assert.equal(projection.includes(marker), true, `Missing projection marker: ${marker}`);
  }
  assert.match(background, /if \(selected\.status !== "ready"\)/u);
});

test("content registration retries after failures and background restarts", async () => {
  const source = await readFile(
    new URL("../src/content/chatgpt.ts", import.meta.url),
    "utf8",
  );
  const background = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );
  // BB-4. The message table both provider entries answer now lives once, in the shared
  // provider logic, so the dispatch assertions read it there.
  const providerLogic = await readFile(
    new URL("../src/content/providerLogic.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /createRegistrationCoordinator/);
  assert.match(source, /registration\.ensure\(verify\)/);
  // BB-4. Installing the document is the shared wiring, so the periodic re-registration and
  // the message table are read where they now live.
  assert.match(
    providerLogic,
    /setInterval\(\(\) => hooks\.ensureRegisteredUrl\(true\), hooks\.reregisterIntervalMs \?\? 1_000\)/,
  );
  assert.match(providerLogic, /createProviderMessageListener\(\{[\s\S]{0,300}registerDocument: hooks\.registerDocument,/);
  assert.match(source, /installProviderDocument\(\{/);
  assert.match(providerLogic, /message\.type === "content\.reregister"/);
  assert.match(background, /type: "content\.reregister"/);
  assert.match(background, /waitForDocumentRegistration/);
});

test("popup mutations, reads, and storage writes are serialized", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /const popupQueue = createRevisionQueue\(\)/);
  assert.match(source, /const storageWrites = createSnapshotWriteQueue<StoredState>/);
  assert.match(source, /messageType === "popup\.getState"[\s\S]*popupQueue\.enqueueRead\(run\)/);
  assert.match(source, /storageWrites\.enqueue\(stored\)/);
});

test("provider asset recovery survives a service-worker registry restart", async () => {
  const background = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(background, /const recoverRegisteredAsset = async/);
  assert.match(background, /type: "asset\.probe"/);
  assert.match(background, /await recoverRegisteredAsset\(message\.assetId\)/);
  const providerLogic = await readFile(
    new URL("../src/content/providerLogic.ts", import.meta.url),
    "utf8",
  );
  assert.match(providerLogic, /message\.type === "asset\.probe"/);
  assert.match(providerLogic, /assetMetadata: \(message\) => \{[\s\S]{0,240}hooks\.assetSources\.get/);
  assert.match(providerLogic, /assetRevealer: \(message\) =>[\s\S]{0,200}hooks\.assetSources\.get/);
  for (const provider of ["chatgpt", "claude"]) {
    const source = await readFile(
      new URL(`../src/content/${provider}.ts`, import.meta.url),
      "utf8",
    );
    // BB-4. Which assets this document published is the entry's; answering a probe about one
    // is the shared wiring's.
    assert.match(source, /assetSources,/);
    assert.match(source, /publicAssetMetadata: toPublicMetadata,/);
  }
});

test("Claude artifact capture excludes interactive controls and previous unchanged panes", async () => {
  const source = await readFile(
    new URL("../src/content/claude.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /artifactInteractiveSelector/);
  assert.match(source, /element\.closest\(artifactInteractiveSelector\)/);
  assert.match(source, /initialArtifacts: currentClaudeArtifacts\(\)/);
  assert.match(
    source,
    /initialArtifacts\.get\(element\) !== artifactFingerprint\(element\)/,
  );
});

test("invalid provider asset streams are cancelled at the producing document", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );
  const cancellations = source.match(/await cancelAssetTransfer\(transfer\);/g) ?? [];
  assert.ok(cancellations.length >= 3);
  assert.match(source, /INVALID_ASSET_CHUNK/);
  assert.match(source, /INVALID_ASSET_COMPLETION/);
});

test("asset transfer lifecycle requires one start and an exact declared size", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );
  const assets = await readFile(
    new URL("../src/background/assetTransfer.ts", import.meta.url),
    "utf8",
  );
  // BB-AUD-09. The state an admitted transfer begins with is decided in `assetAdmission.ts`.
  const admission = await readFile(
    new URL("../src/background/assetAdmission.ts", import.meta.url),
    "utf8",
  );
  assert.match(admission, /started: false/);
  assert.match(source, /transfer\.started = true/);
  assert.match(source, /transfer\.declaredSize = start\.size/);
  assert.match(assets, /if \(transfer\.started\) return undefined;/);
  assert.match(assets, /if \(!transfer\.started\) return undefined;/);
  assert.match(
    assets,
    /transfer\.declaredSize !== undefined && size !== transfer\.declaredSize/,
  );
});

test("startup reinjects only explicitly handled provider tabs", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /handledTabIds/);
  assert.match(source, /tabs\.filter\(\(tab\) => handled\.has\(tab\.id\)\)/);
  assert.doesNotMatch(
    source,
    /const initialize = async \(\): Promise<void> => \{[\s\S]*?tabs\.map\(\(tab\) => ensureContentScript\(tab\.id\)\)[\s\S]*?await connect\(\);/,
  );
});

test("programmatic provider provisioning waits for a registered terminal session", async () => {
  const source = await readFile(
    new URL("../src/background/index.ts", import.meta.url),
    "utf8",
  );

  const waits = await readFile(
    new URL("../src/background/provisioningWaits.ts", import.meta.url),
    "utf8",
  );

  // BB-A4-COV. The wait itself is `provisioningWaits.ts`'s; the entry hands it the Chrome read
  // and the tab it is waiting on, and nothing about the deadline, the interval or what settles
  // is decided beside the Chrome call any more.
  assert.doesNotMatch(source, /const waitForProviderSession = async/);
  assert.match(
    source,
    /await awaitProviderSession\(\{\s*readSessions: buildSessions,\s*tabId: createdTabId,\s*provider,\s*timeoutMs: 20_000,\s*signal,\s*\}\)/,
  );
  assert.match(waits, /export const awaitProviderSession = async/);
  assert.match(waits, /settled: sessionWaitIsSettled/);
  assert.match(
    waits,
    /new Set<BrowserSession\["status"\]>\(\[\s*"ready",\s*"notAuthenticated",\s*"failed",\s*\]\)/,
  );
});


test("coverage gates every core module and production entry independently", async () => {
  const packageJson = await loadJson(new URL("../package.json", import.meta.url));
  // BB-AUD-03 wrapped every `dist` producer and consumer in the repository artifact lock,
  // so the composition now lives in the `:unlocked` variant. Both halves are asserted: the
  // gate order that this test has always guarded, and the lock that must now enclose it.
  assert.equal(
    packageJson.scripts["test:coverage:unlocked"],
    "npm run build && npm run test:coverage:core && npm run test:coverage:entries",
  );
  for (const name of ["test:coverage", "test:coverage:core", "test:coverage:entries"]) {
    assert.match(
      packageJson.scripts[name],
      /^node scripts\/with-artifact-lock\.mjs -- /u,
      `${name} does not run under the repository artifact lock`,
    );
  }
  assert.match(packageJson.scripts["test:coverage:core"], /run-coverage-gates\.mjs core$/u);
  assert.match(packageJson.scripts["test:coverage:entries"], /run-coverage-gates\.mjs entries$/u);
  const source = await readFile(new URL("../scripts/run-coverage-gates.mjs", import.meta.url), "utf8");
  for (const file of [
    "dist/background/conversation.js",
    "dist/content/assetLogic.js",
    "dist/content/providerControls.js",
    "dist/protocol/types.js",
    "dist/background/index.js",
    "dist/content/chatgpt.js",
    "dist/content/claude.js",
    "dist/popup/index.js",
  ]) {
    assert.match(source, new RegExp(file.replaceAll("/", "\\/"), "u"));
  }
});


test("background reconnect uses persisted Chrome alarms for long retries", async () => {
  const background = await readFile(new URL("../src/background/index.ts", import.meta.url), "utf8");
  const reconnect = await readFile(new URL("../src/background/reconnect.ts", import.meta.url), "utf8");
  assert.match(reconnect, /bachataBridgeReconnect\.v8/u);
  assert.match(reconnect, /alarms\.create/u);
  assert.match(background, /stored\.reconnectAt/u);
  assert.match(background, /onAlarm\.addListener/u);
});

test("release smoke test requires a real alarm-backed reconnect after worker shutdown", async () => {
  const source = await readFile(
    new URL("../docs/LIVE_SMOKE_TEST.md", import.meta.url),
    "utf8",
  );

  for (const marker of [
    "Alarm-backed reconnect after worker shutdown",
    "exact release build in Chrome",
    "delay longer than 30 seconds",
    "Close extension DevTools",
    "Do not open the popup",
    "reconnected automatically",
    "Restart Chrome while a reconnect is pending",
    "duplicate alarms",
  ]) {
    assert.equal(source.includes(marker), true, `Missing live reconnect gate: ${marker}`);
  }
});
