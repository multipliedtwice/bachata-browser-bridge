# TODO

Active backlog only. Every box below is unfinished work. Cross-repository and owner
work lives in [`../TODO.md`](../TODO.md); Extension work in
[`../extension/TODO.md`](../extension/TODO.md).

Release classification: `BR-G6-19` is existing-contract compatibility; popup, provider and
hosted proof are acceptance work. Conditional C2/K1/V2 work is not an automatic release
prerequisite merely because it has an open box. Preserve each dependency and owner decision;
apply the finite blocker and claim rules in `docs/STABLE_RELEASE_GATE.md`.

Rules:

- Preserve dirty work. No reset, clean, stash, dependency install, telemetry, commit,
  tag or push. Marketplace publication follows verified release gates and current user authority.
- Functional helpers first. Reuse shared primitives. No wholesale class ports.
- Remove an item only after its named tests and gates pass. Rewrite partial work to
  remaining scope. Record failures outside this backlog; no invented green claim.
- Order: N1 may run now. L1 gates C1, then C2. V1 gates V2; L1 additionally gates typed activity. K1 is a
  product and security decision, not implementation authority.

## Audit closure

### Release and protocol

- [ ] **BB-AUD-05 / paired release:** complete exact-artifact acceptance, then pass
  the hosted verification phase and marketplace deployment. Configure Chrome item
  and publishing credentials; retain the verified Bridge ZIP.

### Popup visual acceptance

- [ ] **BB-R26-04 / rendered popup:** verify the packaged popup at 372px width,
  hidden/revealed token, keyboard focus and zoom. Check token text/caret and all three
  controls remain separate and usable. DOM/CSS checks cannot prove rendered geometry.
  Current browser tool rejects local preview; authorized graphical validation still needed.

## UI verification and acceptance

- [ ] **E1 / packaged capability UI:** verify compact summary, limitations, disclosure,
  one primary action and keyboard focus in the rendered release popup.
- [ ] **E2 / real-page setup accessibility:** verify picker outline, scroll/resize,
  arrow selection of nonfocusable controls, Enter without Send activation, Escape,
  restored setup focus, screen reader and zoom against the exact package.
- [ ] Complete `docs/LIVE_SMOKE_TEST.md` against the new package, including 372px layout,
  zoom, focus, permissions and real-page setup. Local browser preview remains rejected;
  do not substitute another browser/CDP/headless route.

## E5 / independent response fidelity

- [ ] Specify smallest atomic Bridge/Extension contract for headings, lists, tables and
  links. Preserve exact code blocks, plain-text fallback and byte/count bounds.
- [ ] Obtain compatibility and privacy/CSP decisions; implement both contract copies,
  compatibility hash, parsers, allowlists and migration tests together. No v9 shape change
  in place. Follow V1/V2; fidelity does not depend on provider expansion or L1.
- [ ] Keep activity/terminal classification behind its separate L1 evidence gate.

## Storage compatibility

- [ ] **BR-G6-19 residue / release-era Generic binding profiles are still unread:**
  `storedProfilesForOrigin` (`src/background/genericProvider.ts:107`) reads only
  `bachata.generic.profile.<origin>`, and the records it accepts must carry
  `protocol: "bachata-generic-binding-store-v1"` and `bachata-generic-binding-v1` inside. A
  released build wrote `pair.generic.profile.<origin>` with the `pair-` protocol literals, so
  every binding a person made before the rename is invisible.
  Reading those records means accepting `pair-` protocol literals inside them, and `PAIR-ID-01`
  in `../TODO.md` reserves exactly that per-group choice — keep old, migrate old to new, or break
  on purpose. Answer it there, then this follows mechanically.

## P0 / C1: stronger ChatGPT terminal completion

Depends: L1 live evidence for a stable response-scoped terminal control. L1 also gates the typed
visible-activity taxonomy.

Keep current minimum: generation observed + Stop gone + nonempty response +
quiet interval + provider-idle interval.

Remaining gate: `chatGptTerminalControlProven = false`. Preserve response-bound control
resolution, mutation-revision stability, stopped-without-action grace and quarantine.
Enable only after L1 proves the exact candidate on an authenticated page.

- [ ] Confirm the response-scoped terminal control on an authenticated ChatGPT page (L1), then set
  `chatGptTerminalControlProven = true` and rerun the suites below. Never flip it from an upstream
  selector alone.
- [ ] `src/content/claude.ts`: no completion-policy change in C1. Separate live Claude evidence and
  owner-approved scope required first. No ChatGPT selector or assumption reused.

Acceptance:

- ChatGPT silence alone never completes.
- Old/global completion action never completes current ChatGPT turn.
- Unproved ChatGPT completion produces no successful response.

## P1 / C2: built-in capture cost

Depends: C1 evidence model fixed first.

- [ ] `src/content/chatgpt.ts`, `src/content/claude.ts`: observe stable response
  ancestor when available. On response-root replacement/rebind: disconnect old
  observer, bind new root/ancestor, increment monotonic mutation revision.
- [ ] Cache captured parts, text, segments, and bounded HTML signature by bound
  root + mutation revision. No DOM mutation means no repeated full
  serialization. Markdown waits for V2.
- [ ] After relevant mutation, wait one bounded React settle window before
  capture. Reset settle only for bound response mutation, not page noise.
- [ ] Before final success, perform one authoritative uncached DOM reread and
  recompute text, HTML signature, segments, assets. Compare with candidate.
  Mismatch resumes observation or fails at deadline.
- [ ] Preserve exact response binding, segment coverage, asset limits, text/HTML
  limits, cancellation, deadline, quarantine, virtualization/rebind handling.
- [ ] Tests: serializer call count on unchanged DOM; relevant vs unrelated
  mutation; React microtask/frame mutation; cached candidate/final mismatch;
  final reread match; rebind invalidation; size/depth limits unchanged.

Acceptance:

- Stable DOM serializes once per revision plus final reread.
- Final payload always comes from authoritative reread.
- No weakened completion or binding proof.

## P1 / N1: browser-emitted navigation authority

Interpret "tab-emitted navigation" as Chrome navigation events. Do not confuse
with Tab-key focus traversal. Prefer browser truth over page History monkey
patches or permanent URL polling.

Constraints to preserve while finishing this: accepted navigations carry a per-tab sequence, and
the `isCurrent` check belongs immediately after an await and only there — nothing else on the
path yields, so a second copy could never be false and could never be tested. `tabs.onRemoved`
must keep forgetting the tracker state, because Chrome reuses tab ids.

Only live evidence remains.

- [ ] Live: ChatGPT new-chat -> conversation route, conversation -> new chat, same-document
  conversation switch, Claude equivalents, one bound Generic SPA. Record event sequence and
  resulting registration identity, no private page content.
  Blocked on: authenticated provider access (same block as L1) plus owner authorization to
  drive a real account.
- [ ] Real BFCache restoration without DOMContentLoaded. No harness here can produce one; it
  rides with the live case above.

Acceptance:

- Required top-level route changes arrive from Chrome, once per effective state
  transition after dedupe.
- No page code patch is required. No polling is required after proven removal.
- Stale document or route cannot send, interrupt, or complete current work.

## Gate / K1: keyboard-only provider interaction

A product and security gate, not implementation authority: the trusted-input option
would widen the extension's trust boundary and needs an explicit owner decision first.

Proposal needs owner decision and live proof. Content-script `KeyboardEvent`
dispatch is synthetic, not trusted user input. Blind Tab counts are unstable.
True browser-level key injection needs a larger automation authority such as
Chrome debugger access. Do not call either path "user keyboard input" without
proof.

Valid goal: lower coupling to click handlers and prove native keyboard semantics.
Not a goal or claim: stealth, fingerprint evasion, or anti-bot bypass.

- [ ] Define scope first: provider pages only or extension popup too; text send,
  menu choice, stop, attachment picker, and recovery. Strict keyboard-only file
  attachment needs OS/file-picker automation and is outside current authority.
- [ ] Current-permission option: resolve one exact visible/enabled DOM control,
  focus it, prove `document.activeElement` is that control, emit the smallest
  key sequence, then verify provider postcondition. Never navigate by "press
  Tab N times" from assumed focus. Expose capability as synthetic keyboard,
  not native. Failure after possible send remains non-retryable and quarantined.
- [ ] Trusted-input option: write a separate security decision for Chrome
  debugger/CDP permission, attachment lifecycle, conflicts with DevTools,
  user-visible permission warning, store/release impact, and exact command
  allowlist. No implementation before explicit approval of that trust-boundary
  expansion.
- [ ] For either option, live-test ChatGPT and Claude with normal layout, open
  sidebar, banner, modal, tool rows, streaming, stopped turn, focus loss, and UI
  rerender. Prove focus owner before every key and exact postcondition after it.
- [ ] Accessibility smoke remains separate: a human must complete the supported
  flow with keyboard alone. It does not prove synthetic automation reliability.

Acceptance:

- No tab-order-count dependency.
- Every key targets a uniquely proven focus owner.
- No trusted/native claim for script-dispatched events.
- Keep current exact-control activation if keyboard path is less safe or cannot
  support attachments under the approved permission boundary.

## Gate / L1: authenticated provider DOM evidence

Hard prerequisite for C1 terminal control and typed visible-activity classifier.
Human/live only.

Requires exact-candidate evidence from an owner-authorized authenticated provider session.
No current-run live proof recorded. Prior logged-out observations are historical only;
they do not establish current account availability. C1 and C2 remain gated behind L1.

- [ ] Use exact release candidate in authenticated ChatGPT normal and thinking
  models.
  Observe: status/reasoning-summary nodes, intermediate commentary Markdown,
  final-answer Markdown, response-scoped completion actions, tool rows, DOM
  mutation, reparent, virtualization, stopped/error states.
- [ ] Repeat: normal completion, tool use, long answer, interruption, response
  failure, page refresh. Test Claude only if typed activity is proposed there.
- [ ] Record sanitized structural selectors/ancestry/order and state transitions.
  No prompt/response content, cookie, token, account data, private screenshot.
- [ ] Stop C1 if no stable response-scoped terminal control exists. Stop V2 if
  no stable structural boundary separates commentary from final answer. Do not
  guess from labels or upstream selectors.

Acceptance:

- Reproducible DOM fixture derived from observed public structure.
- Final-answer boundary survives at least tool rows and reparent/virtualization.

## P1 / V2: Protocol v10 implementation and migration

Depends: accepted compatibility and security decisions in V1. Cross-repository atomic release.
Markdown fidelity is independent of typed activity. L1 gates activity only; select and specify
the exact fidelity-only contract before implementation. No v9 wire-shape change in place.

Bridge impacts:

- [ ] `src/protocol/types.ts`: version, messages, parser/validators, segment and
  activity types, byte/count limits.
- [ ] `protocol/browser-protocol-v10.contract.json`: canonical contract. Remove
  active v9 contract only after migration tests.
- [ ] `src/background/endpoint.ts`, `src/background/index.ts`,
  `src/background/conversation.ts`, `src/popup/index.ts`: endpoint, handshake,
  forwarding, validation, stored endpoint migration.
- [ ] `src/content/chatgpt.ts`, `src/content/claude.ts`,
  `src/content/generic/markdown.ts`, `src/content/generic/responseCapture.ts`:
  semantic blocks, GFM fidelity, activity ledger where live evidence permits.
- [ ] `tests/protocol.test.mjs`, `tests/package.test.mjs`,
  `tests/productionEntries.test.mjs`, provider logic/capture suites, endpoint,
  popup, reconnect fixtures: v10 positive/negative/migration corpus.
- [ ] `scripts/source-distribution.mjs`, `scripts/packageContents.mjs`,
  `scripts/run-coverage-gates.mjs`, `scripts/verify-generic-browser.mjs`: contract,
  fixtures, package allowlist, coverage. Update
  `scripts/third-party-notices.mjs` if dependency graph changes; build regenerates
  `dist/THIRD_PARTY_NOTICES.txt`. No hand-maintained generated notice file.
- [ ] `README.md`, `docs/PROTOCOL.md`, `docs/SECURITY.md`,
  `docs/LIVE_SMOKE_TEST.md`, provider docs, changelog: v10 only after tests.

Controller impacts in `../extension`:

- [ ] `protocol/browser-protocol-v10.contract.json` byte-identical to Bridge.
  Update `protocol/browser-bridge.compatibility.json` SHA-256.
- [ ] `src/browser/protocol.ts`: version, parser, strict keys, semantic block and
  activity validation, UTF-8/count limits.
- [ ] `src/browser/bridgeServer.ts`, `src/adapters/browserProvider.ts`,
  `src/adapters/types.ts`: retain activity phase; final answer accounting stays
  separate.
- [ ] Audit consumers: `src/browser/semanticInterpreter.ts` and
  `src/browser/actions.ts`. Only final-answer semantic blocks may drive control
  parsing/actions unless policy explicitly permits another phase.
- [ ] Update `tests/protocol.test.cjs`, `tests/browserBridge.test.cjs`,
  `tests/runtimeSafety.test.cjs`, `tests/vsixVerification.test.cjs`,
  `tests/sourceDistribution.test.cjs`, adapter/runtime fixtures.
- [ ] Update `scripts/source-distribution.mjs`, package/VSIX allowlists,
  compatibility/hash checks, coverage gates, notices if dependencies change,
  support/compatibility/release docs.

Acceptance:

- Contract copies byte-identical; compatibility hash exact.
- Stateless parser rejects unknown kind, invalid coverage, over-limit UTF-8
  payload, mixed protocol version.
- Stateful activity ledger rejects gap/duplicate sequence, committed rewrite,
  and reclassification.
- Markdown fixtures round-trip required GFM semantics.
- Controller UI/event path preserves typed activity. Final answer remains exact.
- Bridge ZIP and VSIX contain only active contract and declared fixtures/assets.

## Conditional proposals: no work before trigger

- [ ] Structured submission phases only with named controller recovery consumer.
  If approved: `prepared -> send_activated`, then `accepted` or `ambiguous`.
  Post-send ambiguity non-retryable; quarantine retained. Existing binary
  no-replay boundary remains until then.
- [ ] `generation_running` signal only with unique current-response binding.
  Bare page-global Stop/busy signal declined.
- [ ] Provider input preflight only with reliable account/model capability and
  live measured boundary. No fixed prompt cap.
- [ ] Multipart staging only after reproduced single-message boundary need and
  inert exact reconstruction proof. No automatic splitting.

## Open review dependencies

Remaining prior review item:

- [ ] `REVIEW-10 / BB-3` closes with N1's live evidence — authenticated provider access and real
  BFCache. Its only remaining dependency is that live evidence.

## Standing behavior constraints

- Preserve provider/account resource leases in
  `../extension/src/runtime/providerResourceBroker.ts` and `resourceWrappedAdapter.ts`.
  Do not replace Worker/Lead scheduling with an upstream five-tab cap.
- Mark send commitment before unsafe ambiguity; quarantine unproved state. No automatic resend.
- Controller owns task/agent conversation sessions and fresh-session rollover.
  No Bridge epoch/task ownership layer.
- Disconnect intentionally cancels Bridge active requests and rejects controller
  pending operations. No event journal/reconnect replay.
- Preserve strengths: loopback exact-version pairing; token authentication;
  exact tab/frame/session binding; no filesystem/shell access; explicit-origin
  Generic binding; provider-specific capture; image/assets; cancellation;
  deterministic package/coverage/no-telemetry gates.

## Declined / non-goals

- Auto retry or resend after possible submission.
- Fixed prompt cap. Bare `generation_running`.
- Upstream global five-tab cap.
- Event journal/reconnect replay.
- Bridge-side compaction.
- Epoch/task conversation ownership in Bridge.
- Upstream model catalog/capability emulation.
- Generic stream URL attestation as a confirmed defect. Current content capture
  revalidates request/document; same-origin transition supports new-chat route.
- Wholesale upstream commentary classifier or stateful classes.
- MCP, tunnel, Electron/launcher, unauthenticated Responses endpoint.
- Persisted response state or expanded privacy boundary.
- Telemetry, metrics, tracing, diagnostics framework.
- Blind Tab-count navigation. Trusted-keyboard claim for synthetic DOM events.
- Chrome debugger/CDP input without explicit trust-boundary approval.
- Stealth, fingerprint masking, or provider anti-automation bypass.

## Verification

After C1/C2:

```sh
npm run build
node --test tests/chatgptLogic.test.mjs tests/claudeLogic.test.mjs tests/productionEntries.test.mjs
```

After V2, Bridge:

```sh
npm run check-types
npm test
npm run test:coverage
npm run package
git diff --check
git status --short
```

After V2, controller:

```sh
cd ../extension
npm run check-types
npm test
npm run test:coverage
npm run package
git diff --check
git status --short
```

Live release gates:

- [ ] `docs/LIVE_SMOKE_TEST.md`: ChatGPT and Claude bind/send/stream/final/
  attachment/asset/interrupt/quarantine/SPA cases.
- [ ] Thinking-model L1 fixture cases: commentary, tool rows, final boundary,
  virtualization, interruption, terminal error.
- [ ] Generic target checks only for targets claimed supported.
- [ ] Record exact source/artifact hashes, Chrome, OS, date. No sensitive content.

Stop conditions:

- Missing owner decision on v10 compatibility/privacy.
- No stable live DOM boundary for typed activity.
- Required provider/account unavailable for live gate.
- Destructive operation, dependency install, network write, commit, tag, push,
  publish, or telemetry needed without explicit authority.
- Baseline test failure unrelated to changed scope: record exact failure; do not
  edit around it.
