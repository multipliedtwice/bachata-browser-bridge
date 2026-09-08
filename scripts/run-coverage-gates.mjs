import { spawn } from "node:child_process";

const groups = {
  core: [
    ["dist/background/conversation.js", 100, 96, 100, ["tests/conversationIdentity.test.mjs", "tests/chatgptLogic.test.mjs", "tests/claudeLogic.test.mjs"]],
    // BB-AUD-10. Raised from 44/71/56 with the restore, injection and registration-URL
    // best-effort paths under test. Branch percentage moves least because covering a new
    // function also brings its own branches into the count.
    ["dist/background/genericProvider.js", 53, 71, 58, ["tests/genericProviderLifecycle.test.mjs"]],
    // The quarantine verdict gates unattended runs, so it is gated at what its own tests reach.
    ["dist/background/quarantine.js", 100, 90, 100, ["tests/genericConversationQuarantine.test.mjs"]],
    // Raised from 84/86/100 after REVIEW-12 removed an unreachable URL re-validation block and
    // its tests grew to cover the rejection paths the anchored pattern now solely owns.
    // Captured-payload validation lifted out of the service-worker entry, where the branches
    // guarding untrusted content-script payloads were reachable only through the whole worker.
    // BB-AUD-09. Cancellation for the provisioning waits, lifted out of the entry where a
    // cancellation path could only be reached by driving a whole conversation open.
    ["dist/background/cancellation.js", 100, 100, 100, ["tests/cancellation.test.mjs"]],
    // BB-AUD-09. The asset-transfer bookkeeping — start-frame parsing, in-sequence chunk
    // accounting, completion agreement and the bounded registry — lifted out of the entry,
    // where an out-of-order chunk or an over-budget completion could only be reached by
    // driving a whole capture.
    ["dist/background/assetTransfer.js", 100, 100, 100, ["tests/assetTransfer.test.mjs"]],
    // BB-AUD-09. Whether an `asset.fetch` may open a transfer at all, decided without a socket
    // or a Chrome call, so every refusal is reachable directly.
    ["dist/background/assetAdmission.js", 100, 100, 100, ["tests/assetAdmission.test.mjs"]],
    // BB-AUD-09. What a tab update means for the work bound to that tab, decided without
    // `chrome.tabs`, persistence or a socket behind it.
    ["dist/background/tabChange.js", 100, 100, 100, ["tests/tabChange.test.mjs"]],
    ["dist/background/capturedPayload.js", 100, 100, 100, ["tests/capturedPayload.test.mjs"]],
    ["dist/background/endpoint.js", 100, 90, 100, ["tests/endpoint.test.mjs"]],
    // N1. The normalizer Chrome's navigation events will be read through. Nothing subscribes
    // yet: the `webNavigation` permission and the listeners that need it are a separate step,
    // gated on browser evidence. The decision is here and total.
    ["dist/background/navigationEvents.js", 100, 100, 100, ["tests/navigationEvents.test.mjs"]],
    // REVIEW-11 / BB-5. The local-model proxy is the extension's only outbound network path
    // and nothing exercised it, so the loopback-only rule, the prompt limit, the sender check
    // and the backend fallback order were unguarded. Gated at what its own suite reaches; the
    // uncovered remainder is queue bookkeeping reached only under contention.
    ["dist/background/localModelProxy.js", 94, 89, 76, ["tests/localModelProxy.test.mjs"]],
    // BB-AUD-09. The popup's row projection — one row per provider tab, its readiness, its
    // reason and its conversation identity — lifted out of the entry, where the shape the
    // popup actually receives could only be reached by driving the whole worker. The
    // surrounding popup-state assembly stays in the entry; moving it too dropped the entry's
    // own branch total below its floor, and that is a coverage debt to pay before it moves.
    ["dist/background/popupProjection.js", 100, 100, 100, ["tests/popupProjection.test.mjs"]],
    ["dist/background/provisioning.js", 87, 73, 100, ["tests/provisioning.test.mjs"]],
    // BB-AUD-09. The provisioning waits' own decisions — settled session status, provider tab
    // readiness, the generic tab choice, the fresh-conversation verdict and the opened-session
    // verdict — lifted out of the entry, where each was reachable only by driving a whole
    // conversation open against a live browser.
    ["dist/background/provisioningWaits.js", 100, 100, 100, ["tests/provisioningWaits.test.mjs"]],
    ["dist/background/reconnect.js", 95, 90, 100, ["tests/reconnect.test.mjs"]],
    ["dist/background/requestOrdering.js", 100, 100, 100, ["tests/requestOrdering.test.mjs"]],
    // BB-AUD-09. Pure state and routing decisions lifted out of the service-worker entry,
    // where they were reachable only by driving the whole worker. Gated at what direct
    // tests reach, which is all of it.
    ["dist/background/routerState.js", 100, 100, 100, ["tests/routerState.test.mjs"]],
    ["dist/background/serializedState.js", 100, 100, 81, ["tests/stateConcurrency.test.mjs"]],
    ["dist/content/assetLogic.js", 95, 75, 97, ["tests/assetLogic.test.mjs"]],
    // BB-AUD-10. The healer's persisted selection is a cache whose write, read and removal
    // are all best effort. Gated at the run total node measures, which is lower than the
    // 83/40/80 the file itself reaches because the suite's DOM support is counted with it.
    ["dist/content/domHealing.js", 61, 41, 66, ["tests/domHealingPersistence.test.mjs"]],
    // The implementation both providers share, gated at what the two provider suites reach.
    // BB-4, BB-7. Raised as each shared block came under direct test: the cancellation registry,
    // the provider message table, the asset-transfer driver, the provider-status projection, the
    // response serializer and the interrupt control.
    // BB-4. Raised from 96/90/98 as the composer guard and the background sender arrived here
    // with their own tests, and again from 97/91/98 as the lifecycle observer, the request
    // teardown, composer resolution, attachment staging, the response binder, the conversation
    // binder, the asset-source store, the document wiring, the response-activity observer, the
    // submitted-prompt wait, the stream sender, the indeterminate monitor and the interrupt
    // handler arrived with direct tests of their own. Measured 98.05/93.26/99.22, twice.
    ["dist/content/providerLogic.js", 98, 93, 99, ["tests/chatgptLogic.test.mjs", "tests/claudeLogic.test.mjs"]],
    // The per-provider files are now configuration only; the uncovered branch is the guard for
    // a load order the injection list and the entry tests both enforce.
    ["dist/content/chatgptLogic.js", 87, 50, 100, ["tests/chatgptLogic.test.mjs"]],
    ["dist/content/claudeLogic.js", 87, 50, 100, ["tests/claudeLogic.test.mjs"]],
    ["dist/content/providerControls.js", 100, 100, 100, ["tests/providerControls.test.mjs"]],
    ["dist/protocol/types.js", 88, 83, 100, ["tests/protocol.test.mjs"]],
    ["dist/content/generic/bindingProfile.js", 91, 89, 100, ["tests/genericBindingProfile.test.mjs"]],
    // REVIEW-11 / BB-5. Candidate collection decides what a user, and the local healer, are
    // offered as a composer, a send control or a conversation root on an unknown page.
    ["dist/content/generic/candidates.js", 96, 95, 100, ["tests/genericCandidates.test.mjs"]],
    // REVIEW-11 / BB-5. The content side of the extension's only outbound network path: the
    // cancellation handshake, the refusal mapping and the candidate bounds.
    ["dist/content/generic/localModel.js", 100, 100, 85, ["tests/genericLocalModel.test.mjs"]],
    // REVIEW-11 / BB-5. Every decision the page extractor makes about a parse. The parse
    // itself needs a browser-grade DOM and stays in the uncovered adapter.
    ["dist/content/generic/readability.js", 92, 100, 50, ["tests/genericReadability.test.mjs"]],
    ["dist/content/generic/conversationQuarantine.js", 98, 95, 100, ["tests/genericConversationQuarantine.test.mjs"]],
    ["dist/content/generic/freshConversation.js", 100, 88, 100, ["tests/genericFreshConversation.test.mjs"]],
    // BB-AUD-10. Both healing parsers absorb an unusable repair and an unparsable attempt;
    // gated at what the compatibility suite now reaches.
    ["dist/content/generic/healing.js", 84, 71, 81, ["tests/genericHealingCompatibility.test.mjs"]],
    ["dist/content/generic/lifecycleEvidence.js", 100, 97, 100, ["tests/genericLifecycleEvidence.test.mjs"]],
    // BB-AUD-10. Raised from 88/80/88 once the role, placeholder, CSS-fallback and
    // exhausted-structural-path paths were exercised directly.
    ["dist/content/generic/locator.js", 93, 90, 88, ["tests/genericLocator.test.mjs"]],
    // BR-G6-01. The healing contracts' structural validation, interpreted rather than
    // compiled so the bundle loads under a page CSP that forbids generating code from
    // strings. Total: every keyword and every refusal is reachable directly.
    ["dist/content/generic/schemaGuard.js", 100, 100, 100, ["tests/genericSchemaGuard.test.mjs"]],
    // BB-10. The picker holds a capture-phase click handler over a page the user is looking
    // at, so its lifetime and its refusal of a late result are gated at what its tests reach.
    ["dist/content/generic/picker.js", 100, 84, 90, ["tests/genericPicker.test.mjs"]],
    // REVIEW-11 / BB-5. Markdown fidelity decides what the controller is told the provider
    // said, so it is gated at what the capture suites reach rather than left ungated.
    ["dist/content/generic/markdown.js", 79, 74, 83, ["tests/genericResponseCapture.test.mjs", "tests/genericHealingCompatibility.test.mjs"]],
    ["dist/content/generic/responseCapture.js", 90, 77, 100, ["tests/genericResponseCapture.test.mjs"]],
    ["dist/content/generic/responseLifecycle.js", 100, 100, 100, ["tests/genericResponseLifecycle.test.mjs"]],
    ["dist/content/generic/transientControl.js", 100, 93, 100, ["tests/transientControl.test.mjs"]],
  ],
  entries: [
    // BB-AUD-09. The service-worker entry. The pure routing, state, payload-validation,
    // provisioning-wait, asset-transfer and popup decisions live in `routerState.js`,
    // `capturedPayload.js`, `provisioningWaits.js`, `assetTransfer.js` and
    // `popupProjection.js`, each gated at 100; what is measured here is the entry's own
    // delegation and lifecycle. Covered through a harness that builds a registered content
    // document: a whole asset transfer from published asset to checksummed completion and
    // acknowledgement, every way a transfer can be refused, a whole Generic conversation turn
    // from registration through submission commitment to reuse confirmation, and the
    // navigation races driven against a held permission read.
    // Node checks a threshold against the run total, not the included file, so these are the
    // totals it reports. The suite loads the entry once per test, and an entry's imports resolve
    // to one shared module however many times the entry itself is loaded — so a function that
    // stays inline is counted uncovered in every instance that does not reach it, and the number
    // falls as the suite grows however much behaviour is added. That is why decisions leave the
    // entry rather than being covered where they sit.
    // BB-A4-N05, BB-A4-COV. Splitting the Generic turn into four module-scope functions cost
    // 45.70 -> 44.66 on that arithmetic alone; moving the four provisioning waits into
    // `provisioningWaits.js`, gated at 100, returned it to 37.29/53.17/45.81.
    // BB-AUD-09. Raised from 36/51/45 as asset-fetch admission, the initial-transition
    // admission and the tab-change verdicts left the entry for `assetAdmission.js`,
    // `routerState.js` and `tabChange.js`, each gated at 100: what stayed behind is the
    // dispatch and the Chrome calls, and its own covered share is higher for it. Measured
    // 37.17/52.28/45.90, twice.
    ["dist/background/index.js", 37, 52, 45, ["tests/productionEntries.test.mjs"]],
    // BB-4. The two provider entries, each measured with the controls file they share.
    // Node reports the run total across every instance of an entry a suite loads, not their
    // union, so a message table every harness installs has to be driven by every harness for
    // the total to mean anything: each provider harness now answers its own status, interrupt,
    // asset probe, reveal, cancel, fetch refusal and re-registration before it ends. Raised from
    // 43/46/47 and 39/53/43 on that, measured 52.96/53.25/49.03 and 49.96/59.62/45.73, twice.
    // The ChatGPT function floor is 47 and has never been below it.
    [["dist/content/chatgpt.js", "dist/content/providerControls.js"], 52, 53, 47, ["tests/productionEntries.test.mjs"]],
    [["dist/content/claude.js", "dist/content/providerControls.js"], 49, 59, 45, ["tests/productionEntries.test.mjs"]],
    // REVIEW-11 / BB-5. The generic content entry, driven through its own message table under a
    // DOM and a background stub. It carried no gate while a real request could not be finished:
    // every wait was a wall-clock deadline, so a locator failure or a stability failure ran for
    // its whole timeout and the harness could not end it. `setWaitScheduler` substitutes the
    // clock those waits read, and a status, a send, a fresh conversation, a reuse confirmation,
    // a cancellation, a malformed request, a timeout, a locator failure and a stability failure
    // now each terminate. The install-once guard is measured nowhere: proving it needs a second
    // module URL, and V8 reports both runs against this file.
    // BB-A4-N03. The finalization race suite drives a whole turn through the entry — submission,
    // capture, lifecycle persistence and final registration — which the message-table suite
    // cannot reach, so the gate is measured across both.
    // cannot reach, so the gate is measured across both and raised from 47/52/53 on it.
    // Measured 60.65/61.62/65.26, twice.
    ["dist/content/generic/index.js", 70, 68, 69, ["tests/genericContentEntry.test.mjs", "tests/genericFinalizationRace.test.mjs", "tests/genericCancellationRace.test.mjs"]],
    ["dist/popup/index.js", 76, 65, 82, ["tests/popupBehavior.test.mjs", "tests/productionEntries.test.mjs"]],
    // REVIEW-11. The release and packaging scripts. These decide what ships and what is
    // deleted, and nothing exercised them: the packager's verdict, the notice generator, the
    // Generic bundle's entry and output, `clean`'s target list, and the source export and its
    // verification. They run from `scripts/` and are maintained logic, so they are gated like
    // any other. `package.mjs`, `build-generic.mjs` and `clean-dist.mjs` are thin runners over
    // the modules gated here; `dist/generic-content.js` is generated and is tested by what it
    // contains rather than by covering its bundled text.
    [[
      "scripts/packageContents.mjs",
      "scripts/third-party-notices.mjs",
      "scripts/build-generic.mjs",
      "scripts/clean-dist.mjs",
      "scripts/source-distribution.mjs",
    ], 88, 75, 97, ["tests/releaseScripts.test.mjs", "tests/sourceDistribution.test.mjs"]],
  ],
};

// BB-R26-03/04. Required behavioural stages that run before the per-file gates of a group. These
// suites must pass for the release coverage command to pass, so the Paste & Pair and popup race
// regressions cannot silently drop out of it. They run as plain behaviour, not as coverage
// contributors: node sums coverage across every module instance a run loads, and these narrow
// cache-busted instances of the popup entry would dilute its aggregate below the 76/65/82 floor.
// Running them here keeps the floor and the broad popup gate (below) unchanged while pinning them.
const behavioralStages = {
  entries: [
    ["tests/popupPasteAndPair.test.mjs", "tests/popupRaces.test.mjs"],
  ],
};

const group = process.argv[2];
const gates = groups[group];
if (!gates) throw new Error(`Unknown coverage group: ${group ?? ""}`);

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) return resolve();
    reject(new Error(signal ? `Coverage stopped by ${signal}` : `Coverage exited with ${String(code)}`));
  });
});

for (const tests of behavioralStages[group] ?? []) {
  await run(["--test", "--test-concurrency=1", ...tests]);
}

for (const [files, lines, branches, functions, tests] of gates) {
  const includes = (Array.isArray(files) ? files : [files]).map(
    (file) => `--test-coverage-include=${file}`,
  );
  await run([
    "--experimental-test-coverage",
    ...includes,
    `--test-coverage-lines=${String(lines)}`,
    `--test-coverage-branches=${String(branches)}`,
    `--test-coverage-functions=${String(functions)}`,
    "--test",
    ...tests,
  ]);
}
