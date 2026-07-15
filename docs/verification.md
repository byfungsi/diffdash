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
| `SHELL-IPC-004` | `[B]` | All 15 currently schema-decoded structured IPC operations reject malformed payloads through the real preload/main boundary. |
| `SHELL-EVENT-001` | `[B]` | Each preload event cleanup removes the exact listener wrapper registered for its channel. |
| `SHELL-LIFECYCLE-001` | `[B]` | Repeated ordinary quits share one disposal, and neither ordinary quit nor update installation proceeds before disposal completes. |
| `SHELL-WINDOW-001` | `[B]` | Existing minimized windows restore before reveal, use platform-specific focus behavior, and remain untouched in hidden E2E mode. |
| `SHELL-WINDOW-002` | `[B]` | Activating the app with no windows recreates its BrowserWindow. |
| `SHELL-NAV-002` | `[B]` | Initial and pre-ready second-instance commands remain FIFO-ordered until one renderer drain; later commands remain available after prior drains. |
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
| `AGENT-LIFECYCLE-002` | `[B]` | Provider finalization and scoped MCP revocation complete before isolated PR workspace restoration on success and provider failure. |
| `AGENT-LIFECYCLE-003` | `[B]` | Interrupted running turns become terminal before replacement, and concurrent same-thread requests create only one run and pending response. |
| `MCP-CONTEXT-001` | `[B]` | Scoped MCP tools expose bounded thread context and pagination while unavailable hunks, artifacts, and walkthroughs return explicit unavailable results. |
| `AGENT-PROTOCOL-001` | `[B]` | Codex and Claude reject malformed JSONL as protocol failures; Codex file-change and OpenCode patch events fail closed as permission violations. |
| `WORKTREE-SAFETY-001` | `[B]` | The source checkout branch and dirty state are unchanged after review and restart. |
| `REPOSITORY-LIFECYCLE-001` | `[B]` | Linking a local checkout upgrades the matching hosted favorite in place without duplicating or losing its identity. |
| `REVIEW-IDENTITY-001` | `[B]` | Hosted, working-tree, branch-ref, and frozen branch-revision cache identities do not collide. |
| `REVIEW-REVISION-001` | `[B]` | Viewed-file state is isolated by immutable head revision. |
| `PRIVACY-001` | `[B]` | Telemetry opt-out takes effect after analytics startup, preserves unrelated preferences, and emitted payloads retain only approved coarse properties. |
| `DIFF-PARSE-001` | `[B]` | Modified, added, deleted, renamed, binary, multi-hunk, no-newline-marker, and mode-only patch forms retain deterministic metadata. |
| `DIFF-LARGE-001` | `[B]` | Exact 20,000-line and 2,000,000-character boundaries remain eligible for highlighted rendering; values above either boundary use plain mode. |
| `TREE-SCALE-001` | `[B]` | A deterministic 10,000-file fixture preserves one unique canonical path and status per input file. |
| `DIFF-SCALE-001` | `[B]` | A deterministic 1,000-file fixture classifies exactly one over-threshold file for plain rendering while retaining 999 highlight-eligible files. |
| `PACKAGE-001` | `[B]` | Unsigned directory output contains ASAR, updater metadata, bundled CLI resources, and unpacked `better_sqlite3.node`. |
| `PACKAGE-002` | `[B]` | The electron-builder executable boots with `app.isPackaged`, packaged preload, and renderer isolation. |
| `PACKAGE-003` | `[B]` | The packaged executable opens a deterministic real-Git working-tree review and renders its changed file and line. |
| `PACKAGE-004` | `[B]` | The packaged shell denies popup creation and closes DevTools immediately after an open attempt. |
| `PERSIST-PACKAGED-001` | `[B]` | A repository written through packaged preload/IPC persists in packaged SQLite after restart. |

## Classified Product Surface

These rows classify implemented behavior already covered by the named suites. More focused rows above
record migration-sensitive invariants added during M8.

| Requirement | Class | Evidence |
|---|---|---|
| `REPOSITORY-DISCOVERY-001` | `[B]` | `github.test.ts` covers authenticated scopes, owner-scoped search, review requests, and provider failures; `app.browser.test.tsx` covers debounce and actionable search errors. |
| `REPOSITORY-FAVORITES-001` | `[B]` | `repository-store.test.ts` covers favorite state, search, touch, and hosted-to-local identity-preserving upgrade. |
| `REPOSITORY-LINK-001` | `[B]` | `repository-linker.test.ts` covers canonical matching checkouts, mismatched remotes, unsupported origins, and no-persist failure behavior. |
| `REVIEW-CAPTURE-001` | `[B]` | `review-context.test.ts` covers stable hosted snapshots, retry after movement, and rejection of continued inconsistency; `git.test.ts` covers coherent local snapshots. |
| `REVIEW-CACHE-001` | `[B]` | Viewed files, walkthroughs, and threads are keyed by immutable review revisions in their store suites and restart E2E. |
| `CLI-PARSE-001` | `[B]` | `cli-navigation.test.ts` covers public working-tree, repository, PR, and branch commands, relative paths, legacy envelopes, and invalid syntax. |
| `CLI-FORWARD-001` | `[B]` | `diffdash-cli.test.ts` and `prerequisites.test.ts` cover source, macOS, Linux, and AppImage launcher forwarding without launcher-side parsing. |
| `CLI-NAVIGATION-001` | `[B]` | `app-flow.spec.ts` covers startup working-tree/branch commands and forwarding to an existing instance; queue and activation suites cover ordering and focus policy. |
| `SETUP-ONBOARDING-001` | `[B]` | `app.browser.test.tsx` covers first-run setup, limited-capability continuation, telemetry choice, and setup warnings; Electron restart preserves completion. |
| `SETUP-DIAGNOSTICS-001` | `[B]` | `prerequisites.test.ts` covers installed, missing, unsupported, unauthenticated, CLI installation, and AppImage launcher states. |
| `SETTINGS-001` | `[B]` | `app-settings.test.ts` covers defaults, legacy defaults, manual telemetry opt-out, malformed fallback, and JSON persistence; Electron restart covers appearance/provider/model restoration. |
| `SETTINGS-ROLLBACK-001` | `[B]` | Failed walkthrough settings persistence restores the last confirmed provider/model. |
| `PRIVACY-002` | `[B]` | `AnalyticsEvent` is a closed coarse schema, analytics disables exception autocapture, IPC rejects malformed events, and `analytics.test.ts` locks the emitted property allowlist. |
| `DIFF-RENDER-001` | `[B]` | `app.browser.test.tsx` covers a 3,000-pair virtualized diff, fewer than 500 mounted lines, trailing navigation, and very-large-file plain mode. |
| `DIFF-FILTER-001` | `[B]` | `diff-file-filters.test.ts` and browser flows cover hidden generated/vendor/binary files, reveal behavior, and visible filtering. |
| `TREE-001` | `[B]` | `file-tree-adapter.test.ts` and browser tests cover canonical inventory, status mapping, deterministic ordering input, stable selection, and Tree/Walkthrough navigation. |
| `WALKTHROUGH-001` | `[B]` | Shared/service/store/browser suites cover bounded prompt preparation, validation, one retry, revision cache identity, regeneration, sampled disclosure, and completion. |
| `WALKTHROUGH-CACHE-001` | `[B]` | Cached walkthroughs are isolated by repository, review key, base/head revision, and current prompt version. |
| `THREAD-001` | `[B]` | Thread store/shared/browser/Electron suites cover line threads, Markdown safety, follow-ups, progress, failed/complete states, retry entry, and revision mapping. |
| `AGENT-001` | `[B]` | Agent store/memory/orchestration/provider suites cover run/message/artifact/memory lifecycle, current provider protocols, session behavior, and process interruption cleanup. |
| `MCP-001` | `[B]` | `diffdash-mcp-server.test.ts` covers bearer authorization/revocation, bounded read-only tools, immutable diff/repository context, traversal denial, and local reviews. |
| `WORKTREE-001` | `[B]` | `review-worktree-pool.test.ts` covers exact GitHub PR heads, clone reuse, capacity, concurrent leases, revision movement, quarantine, destructive reuse, and checkout non-mutation. |
| `DISTRIBUTION-001` | `[B]` | Packaged E2E, download-worker tests, release infrastructure checks, and release scripts cover unsigned packaging, stable artifact routing, and current local release orchestration. |

## Known M8 Gaps

| Requirement | Class | Known pre-existing behavior |
|---|---|---|
| `GAP-PERSIST-001` | `[G]` | Locked-database and interrupted future-migration startup behavior lacks broader user-visible characterization. |
| `GAP-PERSIST-002` | `[G]` | Settings and onboarding JSON writes replace files directly instead of temporary-file plus atomic rename. |
| `GAP-PERSIST-003` | `[G]` | Historical thread migrations deleted legacy thread/run/artifact/memory rows; tests preserve migration history rather than desired future behavior. |
| `GAP-SETTINGS-001` | `[G]` | One malformed/unknown closed provider value falls back to all defaults instead of preserving independently valid preferences. |
| `GAP-SETTINGS-002` | `[G]` | Permanent Settings, staged/versioned onboarding, resume, and Run setup again are not implemented. |
| `GAP-SETTINGS-003` | `[G]` | Walkthrough settings rollback occurs, but its save failure is not visible while a review remains open. |
| `GAP-IPC-001` | `[G]` | IPC schemas are not uniform and privileged handlers do not validate sender/frame origin. |
| `GAP-DISTRIBUTION-001` | `[G]` | Signing, notarization, installers, update installation, and public artifacts remain operational rather than unsigned packaged-E2E behavior. |
| `GAP-RELEASE-001` | `[G]` | Release scripts have limited behavioral coverage for partial failure, checksums, retries, promotion ordering, and retention. |
| `GAP-A11Y-001` | `[G]` | There is no automated accessibility audit or retained screen-reader procedure. |
| `GAP-A11Y-002` | `[G]` | File filter labels, Tree/Walkthrough tab semantics, command active-option semantics, live announcements, and focus restoration are incomplete. |
| `GAP-PERF-001` | `[G]` | Mounted diff-line bounds exist, but startup, heap, syntax-queue, steady-state, and extreme-review metrics are not recorded. |
| `GAP-TREE-001` | `[G]` | The 10,000-file canonical inventory lacks a bounded mounted-row assertion; all-hidden and explicit-versus-active states are incomplete. |
| `GAP-DIFF-001` | `[G]` | Parser typed failures are absent for malformed hunk counts, quoted paths, copy metadata, `GIT binary patch`, CRLF metadata, and combined diffs. |
| `GAP-DIFF-002` | `[G]` | Syntax-worker failure fallback, live theme token changes, and the extreme 1,000-file fixture lack evidence. |
| `GAP-WALKTHROUGH-001` | `[G]` | Cached walkthrough without an installed agent, provider/model provenance, stale-generation cancellation, and viewed-state preservation on regeneration are incomplete. |
| `GAP-THREAD-001` | `[G]` | Persisted thread creation is line-only; review/file/hunk creation and an explicit carried-forward state are not implemented. |
| `GAP-WORKTREE-001` | `[G]` | Stale lock/lease recovery, idle LRU eviction, malicious-manifest containment, and cleanup-failure quarantine need direct evidence. |
| `GAP-REVIEW-001` | `[G]` | Visible hosted PR rendering fetches detail and diff separately rather than through the coherent snapshot service. |
| `GAP-REVIEW-002` | `[G]` | Recent reviews and navigation history are process-local and do not restore after restart. |
| `GAP-CLI-001` | `[G]` | Branch comparison intentionally uses merge-base semantics, not exact target-tip comparison. |

## Migration Targets

| Requirement | Class | Owning issue |
|---|---|---|
| `TARGET-WORKSPACE-001` | `[T]` | pnpm/Turbo topology and root commands: `FUN-117`, `FUN-116`, `FUN-118`, `FUN-119`, `FUN-120`. |
| `TARGET-E2E-001` | `[T]` | Private full-product E2E workspace: `FUN-155`; final packaged contributor verification: `FUN-141`. |
| `TARGET-DOMAIN-001` | `[T]` | Platform-neutral domain/protocol packages: `FUN-123`. |
| `TARGET-PERSIST-001` | `[T]` | SQLite persistence package: `FUN-122`; process/settings packages: `FUN-121`. |
| `TARGET-RENDERER-001` | `[T]` | Reusable React app and demo host: `FUN-124`; feature decomposition: `FUN-142`. |
| `TARGET-GIT-001` | `[T]` | Provider-neutral local Git/workspaces: `FUN-125`; Git SDK/registry/conformance: `FUN-127`; GitHub isolation: `FUN-129`, `FUN-130`. |
| `TARGET-GIT-IDENTITY-001` | `[T]` | Instance-aware hosted identities and routing: `FUN-126`, `FUN-128`. |
| `TARGET-AGENT-001` | `[T]` | Open agent IDs/settings and manifest UI: `FUN-131`, `FUN-133`; provider-neutral walkthrough/review orchestration: `FUN-136`, `FUN-137`. |
| `TARGET-AGENT-SDK-001` | `[T]` | Agent SDK/registry/conformance: `FUN-138`; Codex/OpenCode/Claude packages: `FUN-132`, `FUN-134`, `FUN-135`. |
| `TARGET-IPC-001` | `[T]` | Validated IPC requests/responses/events/errors: `FUN-140`; thin Electron composition host: `FUN-144`. |
| `TARGET-ENFORCEMENT-001` | `[T]` | Package boundaries and affected-package CI: `FUN-139`. |
| `TARGET-RELEASE-001` | `[T]` | Build/release orchestration under scripts: `FUN-143`; packaged verification and provider documentation: `FUN-141`. |

## Specification Versioning

- The v0.1 product PRD is historical context, not a migration gate.
- M8 freezes the worktree, comment-thread, CLI, file-tree, and diff behavior represented by the
  `[B]` rows above. Future spec revisions append migration sections and owner IDs; they do not
  rewrite these baseline claims.
- `[G]` rows are accepted pre-existing gaps. A migration failure is only a regression when a `[B]`
  row loses evidence or a landed `[T]` row fails its owning issue's gate.

## Accessibility Procedure

Retain the result, platform, assistive technology version, and any exception when running this
procedure. Automation remains authoritative for roles and interactions already asserted by browser
tests; this procedure covers behavior that is not reliable to automate locally.

| Surface | Keyboard and screen-reader procedure | Expected evidence |
|---|---|---|
| Onboarding | Traverse from the page heading through diagnostics, telemetry, Recheck, and Continue without a pointer. | Controls have persistent names, focus is visible, diagnostic state is announced, and Continue remains available with optional tools missing. |
| Home/search | Focus repository search, enter a query, traverse results, bookmark a result, and open a review request. | Search purpose and result actions are announced; loading, empty, and failure states are distinguishable without color. |
| Review tree | Move through files and directories, expand/collapse directories, filter files, reveal hidden files, and open one file. | Tree level, expansion, selection, status, hidden count, and active file are understandable without pointer position. |
| Diff | Expand a file, navigate visible lines, toggle viewed state, and open a line comment. | File status, changed-line side/number, viewed state, and comment entry are keyboard reachable and announced. |
| Walkthrough | Switch from Tree, move through chapters/stops/support, mark a stop complete, and return to Tree. | Mode, selected/visited/completed state, sampled coverage, and referenced file are not conveyed by color alone. |
| Threads | Submit Markdown, wait for progress, inspect a completed or failed response, retry, and submit a follow-up. | Composer focus, busy progress, terminal status, retry action, and new response are announced in sequence. |
| Commands/errors/updates | Open and close command navigation, trigger a recoverable error, and inspect an available update. | Focus enters and returns from the command surface; active option, alert, retry, update status, and restart action have stable names. |

## Performance Observations

Baseline environment on 2026-07-15: macOS arm64, Node 22.20.0, Electron 43.0.0. These are
observations, not wall-clock pass thresholds.

| Fixture | Stable assertion | Current observation |
|---|---|---|
| 10,000 canonical tree files | 10,000 unique paths and statuses, no loss or duplication | Unit runs observed approximately 190-394 ms; mounted tree rows remain `GAP-TREE-001`. |
| 3,000 replacement pairs | Fewer than 500 mounted diff-line nodes; trailing navigation and filtering remain functional | Browser baseline passes headlessly. |
| 20,002 changed lines | Plain mode and fewer than 500 mounted diff-line nodes | Browser baseline passes headlessly; exact 20,000-line boundary remains highlighted by unit policy. |
| 1,000 files, one over threshold | Exactly one file uses very-large classification; aggregate review is sampled | Unit baseline passes; renderer peak heap and IPC copy cost remain `GAP-PERF-001`. |
| Syntax worker | Pool configuration remains one worker with bounded AST cache | Queue depth, task completion, and steady-state idle observations remain `GAP-PERF-001`. |

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
