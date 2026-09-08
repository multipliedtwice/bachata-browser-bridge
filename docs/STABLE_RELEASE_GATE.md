# Stable release gate

A Browser Bridge build is stable only when every gate below passes for the exact source revision being packaged.

## Automated source and build gates

Run from a clean dependency installation:

```bash
npm ci
npm run test:coverage
npm run package
```

`npm run package` runs the complete `npm test` gate, builds the extension, and creates the verified release ZIP. A failure blocks release. The maintained-source export keeps the root `package-lock.json`; it excludes dependencies, nested or alternate-package-manager locks, build, coverage, cache, and test artifacts.

## Built-in provider gate

Complete `LIVE_SMOKE_TEST.md` against the current production ChatGPT and Claude sites. The exact installed extension build must prove normal send, long streaming completion, confirmed interruption, changed or missing Stop-control handling, refresh behavior, bridge reconnect behavior, and conversation quarantine after uncertain completion.

A built-in conversation may return to automatic use only after its lifecycle is positively confirmed or a fresh conversation identity is established.

## Generic provider gate

Each origin claimed as supported is validated independently. Complete the Generic section of `LIVE_SMOKE_TEST.md` for that exact site and UI mode.

Stable unattended support requires all of these published capabilities:

```text
submission = verifiedSend
completion = verifiedLifecycle
interruption = confirmed
conversationState = confirmed
```

`syntheticEnter`, `manualOnly`, or `uncertain` sessions are not stable autonomous targets. A successful bind alone is not a compatibility claim.

Grok, Z.AI, and other Generic targets are named as supported only after their exact production target passes this gate. The model or mode selected inside a Generic website remains website-owned unless a separately validated provider-specific integration exists.

## Release evidence

Keep the checklist result with the release work. Do not add analytics, crash reporting, remote diagnostics, usage history, provider-success tracking, or other telemetry to collect release evidence.

## Observed automated validation

2026-09-08: [Release gates run 34199689556](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34199689556)
passed on Ubuntu, macOS and Windows. Source: `5ae4436107bf5b4d14ccd4ac8d1a9865febc366a`.
Clean lockfile install, types, lint, format, no telemetry, tests, coverage, package and
source-drift checks passed. Live-provider and exact-package visual acceptance remain open.
