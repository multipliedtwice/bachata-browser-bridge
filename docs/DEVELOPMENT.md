# Development

## Requirements

- Node.js 22 or later.
- Chrome or Chromium 116 or later for live tests.

## Layout

```text
src/background      service worker and provisioning
src/content         ChatGPT and Claude adapters
src/popup           pairing and status UI
src/protocol        protocol types and validation
protocol            synchronized contract files
tests               behavioral tests
```

## Commands

In a development checkout with the repository lockfile available:

```bash
npm ci
npm run check-types
npm test
npm run test:coverage
npm run build
```

The maintained-source distribution carries this package's own `package-lock.json`, so an
extracted distribution installs with `npm ci` against the same closure continuous
integration installs. Only the package-root lockfile is maintained source: a lockfile a
nested install creates below the root is refused by the exporter and by
`npm run source:verify`, and other package managers' lock files are refused everywhere.

Coverage enforces separate thresholds for core logic and production entry scripts. Provider entry gates include the shared provider-control module, which is also gated independently at 100%.

Load `dist/` unpacked for manual testing.

### Which gates need a Git checkout

Every command listed above runs in a maintained-source distribution, which carries no VCS
metadata. The `git` program is still required — the candidate-gate tests build scratch
repositories to run the real gate scripts against — but no command above needs the package
itself to be a checkout.

Two gates do, and they are deliberately outside that list:

- `npm run lint` and `npm run format:check` enumerate what they are answerable for with
  `git ls-files --cached --others --exclude-standard`, and separate a tracked deletion from a
  file that vanished mid-run with `git ls-files --deleted`. Neither question has an answer
  without an index, and a gate that cannot ask refuses rather than reporting success over a
  tree it never read. Run them in a checkout.
- The repository-state guard in `tests/releaseScripts.test.mjs` compares Git's own
  before-and-after answer for the working tree, the unstaged diff and the index. Where there
  is no checkout to ask it records that and runs the checks that need none; it never
  initializes a repository to manufacture an answer.

## Source distribution

Export maintained source through the fail-closed exporter instead of archiving the
working tree directly:

```bash
npm run source:export -- /absolute/path/to/new/bachata-browser-bridge-source
npm run source:verify -- /absolute/path/to/new/bachata-browser-bridge-source
```

The destination must not already exist and must be outside this package. The exporter
keeps the required root `package-lock.json` and the release workflows under `.github/`. It
excludes nested and alternate-package-manager locks, dependencies, build/test/runtime/cache
output, logs, nested archives, generated reports, VCS metadata, and symlinks. `dist/` is
never part of a source-only archive.

An extracted distribution runs `npm ci` and then the commands under **Commands** above, all
of which pass without a Git checkout. See *Which gates need a Git checkout* for the two that
do not run there and why.

## Rules

- Keep the bridge narrow.
- Add no shell or filesystem execution.
- Add no telemetry.
- Add no hosted platform.
- Keep protocol copies synchronized with bachata-vscode.
- Test production entry scripts, not helper copies only.
- Keep provider-specific DOM behavior inside provider adapters.
