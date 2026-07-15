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
| `PERSIST-RESTART-001` | `[B]` | Completed onboarding remains completed after Electron closes and relaunches. |
| `PERSIST-RESTART-002` | `[B]` | Viewed-file state rehydrates from SQLite after restart. |
| `PERSIST-RESTART-003` | `[B]` | Initial and follow-up thread messages plus completed agent replies rehydrate after restart. |
| `PERSIST-RESTART-004` | `[B]` | Generated walkthrough content is served after restart. |
| `AGENT-LIFECYCLE-001` | `[B]` | Reopening a completed thread or walkthrough does not rerun the agent. |
| `WORKTREE-SAFETY-001` | `[B]` | The source checkout branch and dirty state are unchanged after review and restart. |

## Known M8 Gaps

- `[G]` A populated version-8 database fixture does not yet cover every durable entity in one
  upgrade/restart scenario.
- `[G]` Main/preload channel parity is not mechanically checked for the entire `DiffDashApi`.
- `[G]` BrowserWindow security options, navigation denial, sender validation, and file containment
  lack direct contract tests.
- `[G]` No test launches unsigned electron-builder output, inspects packaged resources, or loads
  packaged `better-sqlite3`.
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
