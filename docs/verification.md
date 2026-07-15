# Verification Baseline

This document is the repository-owned companion to the Linear Monorepo Migration Verification
Matrix. It records executable evidence that must remain green while DiffDash moves into the
M9-M13 workspace architecture.

## Classification

- `[B]` is implemented baseline behavior and must not regress.
- `[G]` is a known pre-existing gap and is not evidence of a migration regression.
- `[T]` is behavior introduced by an owning migration issue and becomes required when that issue
  lands.

Automation is required when technically feasible. Manual or operational evidence is reserved for
signing, notarization, installers, public promotion, screen-reader checks, and platform checks that
cannot be made reliable in local automation.

## Verification Levels

- Unit: parsers, schemas, policies, stores, service orchestration, and adapters.
- Browser: composed renderer behavior in real Chromium with a deterministic platform fake.
- Electron E2E: compiled main, preload, renderer, IPC, SQLite, CLI fakes, Git fixtures, and restart.
- Packaged E2E: unsigned electron-builder output, ASAR, resources, native modules, and packaged paths.
- Operational: signing, notarization, installers, draft publication, stable promotion, and public
  download/update checks.

## Current Automated Gates

| Gate | Command | Coverage |
|---|---|---|
| Formatting | `pnpm format:check` | Repository formatting |
| Lint | `pnpm lint` | TypeScript, React, and correctness rules |
| Types | `pnpm typecheck` | Main, preload, shared, renderer, tests, and tooling |
| Unit/service | `pnpm test` | Effect services, SQLite, Git/CLI/providers, and shared logic |
| Browser | `pnpm test:browser` | Composed renderer interaction and state transitions |
| Electron | `pnpm test:e2e` | Full shell, IPC, CLI navigation, worktrees, and restart |
| Packaged Electron | `pnpm test:e2e:packaged` | ASAR, updater/CLI resources, native SQLite, preload isolation, and restart |
| Download worker | `pnpm --dir web/download-worker test` | Stable release routing and artifact selection |
| Full test gate | `pnpm test:all` | Unit, browser, Electron, and worker suites |
| Landing build | `pnpm --dir web/landing build` | Landing TypeScript and production bundle |
| Promo data | `pnpm promo:data:check` | Deterministic demo scenarios |
| Release infrastructure | `pnpm release:infrastructure:check` | Release-script syntax and worker checks |

## Executable Baseline Evidence

The following requirement IDs are covered by
`tests/e2e/app-flow.spec.ts` in `covers finished Home to Review flow with fake CLI fixtures`.

| Requirement | Class | Evidence |
|---|---|---|
| `SHELL-IPC-001` | `[B]` | Preload exposes the typed `window.diffDash` contract and a real app-state request succeeds. |
| `SHELL-SEC-001` | `[B]` | Renderer globals do not expose Node `require` or `process`. |
| `SHELL-IPC-002` | `[B]` | All 49 preload request channels have one matching main handler; all 3 event subscriptions have cleanup and a main emission. |
| `SHELL-IPC-003` | `[B]` | All 51 public preload request operations preserve their exact channel, argument order, object wrapping, and generate/regenerate transformation. |
| `SHELL-EVENT-001` | `[B]` | Each preload event cleanup removes the exact listener wrapper registered for its channel. |
| `SHELL-LIFECYCLE-001` | `[B]` | Repeated ordinary quits share one disposal, and neither ordinary quit nor update installation proceeds before disposal completes. |
| `SHELL-SEC-002` | `[B]` | BrowserWindow options lock context isolation, disabled Node integration, web security, insecure-content denial, preload path, and intentional sandbox state. |
| `SHELL-NAV-001` | `[B]` | External URL and renderer navigation allowlists preserve their current exact lexical behavior. |
| `SHELL-FILE-001` | `[B]` | Review file paths reject absolute paths, parent traversal, and targets outside the repository root. |
| `SHELL-FILE-002` | `[B]` | Review file paths resolve filesystem symlinks and reject canonical targets outside the repository checkout. |
| `SHELL-FILE-003` | `[B]` | Local shell error strings and remote shell rejections propagate, disallowed schemes cause no side effect, and provider URLs prefer immutable head SHAs. |
| `PERSIST-RESTART-001` | `[B]` | Completed onboarding remains completed after Electron closes and relaunches. |
| `PERSIST-RESTART-002` | `[B]` | Viewed-file state rehydrates from SQLite after restart. |
| `PERSIST-RESTART-003` | `[B]` | Initial and follow-up thread messages plus completed agent replies rehydrate after restart. |
| `PERSIST-RESTART-004` | `[B]` | Generated walkthrough content is served after restart. |
| `PERSIST-RESTART-005` | `[B]` | Appearance, provider, and telemetry opt-out settings selected through onboarding rehydrate after restart. |
| `PERSIST-RESTART-006` | `[B]` | Completed runs, normalized artifacts, message ownership, and compact thread memory remain byte-for-byte stable across a real Electron restart. |
| `PERSIST-V8-001` | `[B]` | A committed populated version-8 database contains all nine durable tables with valid foreign keys and integrity. |
| `PERSIST-V8-002` | `[B]` | Repository, viewed-file, walkthrough, thread/message, run, artifact, and memory stores decode the frozen v8 graph after two independent opens. |
| `PERSIST-FIXTURES-001` | `[B]` | Current, legacy, telemetry-disabled, malformed settings, incomplete/completed onboarding, populated v8, and malformed-row fixtures contain no personal data or secrets. |
| `PERSIST-FAIL-001` | `[B]` | Corrupt SQLite input fails database acquisition with a typed open error. |
| `PERSIST-FAIL-002` | `[B]` | Malformed persisted JSON fails at each store decoding boundary with a typed operation error. |
| `PERSIST-DB-001` | `[B]` | Runtime SQLite connections use WAL mode and enforce foreign keys. |
| `PERSIST-DB-002` | `[B]` | Every version-8 primary/composite uniqueness boundary rejects duplicate durable identity. |
| `PERSIST-DB-003` | `[B]` | Repository deletion cascades through pull requests, viewed files, walkthroughs, threads, messages, runs, artifacts, and memory. |
| `PERSIST-MIGRATE-001` | `[B]` | Databases newer than the application fail acquisition without downgrade or mutation. |
| `PERSIST-STORES-001` | `[B]` | Every public method on the current SQLite-backed stores has real-database integration coverage. |
| `AGENT-LIFECYCLE-001` | `[B]` | Reopening a completed thread or walkthrough does not rerun the agent. |
| `WORKTREE-SAFETY-001` | `[B]` | The source checkout branch and dirty state are unchanged after review and restart. |
| `PACKAGE-001` | `[B]` | Unsigned directory output contains ASAR, updater metadata, bundled CLI resources, and unpacked `better_sqlite3.node`. |
| `PACKAGE-002` | `[B]` | The electron-builder executable boots with `app.isPackaged`, packaged preload, and renderer isolation. |
| `PACKAGE-003` | `[B]` | The packaged executable opens a deterministic real-Git working-tree review and renders its changed file and line. |
| `PERSIST-PACKAGED-001` | `[B]` | A repository written through packaged preload/IPC persists in packaged SQLite after restart. |

## Known M8 Gaps

- `[G]` Locked-database and interrupted future-migration startup behavior still needs broader
  user-visible characterization.
- `[G]` Settings and onboarding JSON writes replace files directly rather than using atomic
  temporary-file and rename semantics.
- `[G]` Historical thread migrations intentionally deleted legacy thread, run, artifact, and memory
  rows; tests preserve this behavior as migration history rather than desired future behavior.
- `[G]` Settings decode as one closed provider/model domain, so one malformed or unknown provider
  value falls back to all defaults instead of preserving independently valid preferences.
- `[G]` IPC argument schemas are not decoded uniformly, and privileged handlers do not yet validate
  sender/frame origin.
- `[G]` Installer, signing, notarization, update installation, and public artifact checks remain
  operational rather than part of the unsigned packaged E2E gate.
- `[G]` Release scripts have syntax checks but limited behavioral tests for partial failure,
  checksums, retries, promotion ordering, and retention.
- `[G]` Accessibility has interaction assertions but no automated audit or recorded screen-reader
  procedure.
- `[G]` Performance has bounded mounted-node assertions but no recorded fixture metrics for startup,
  memory, or large datasets.

## Baseline Snapshot Record

Before M9 begins, record the following in `FUN-147`:

- Commit SHA, DiffDash version, branch, and intentional dirty-worktree exceptions.
- Node, pnpm, Electron, operating system, architecture, and SQLite schema version.
- Fixture hashes or versions for provider streams, Git repositories, and demo scenarios.
- Result and artifact links for every current automated gate.
- Pass, fail, not-run, and accepted-exception status without hiding failures.
- Owner and follow-up issue for every accepted exception.

M9 remains blocked until every `[B]` requirement has passing automated or approved repeatable
evidence and the snapshot is reviewed.

The frozen compatibility database is generated from
`src/main/services/fixtures/database-v8-populated.sql`. Regenerate it with
`pnpm fixtures:database-v8`; do not replace the source DDL with current migration output when a
future schema version is added.
