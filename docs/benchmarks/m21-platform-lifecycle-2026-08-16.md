# M21 Platform Lifecycle Evidence, 2026-08-16

## Scope

This artifact records deterministic policy evidence for D-02 through D-07. It does not promote
packaged crash, disk-pressure, process-memory, or watcher-longevity results. Those require the final
packaged Linux and macOS matrix.

## D-02 Runtime Qualification

- The packaged Core manifest requires Bun 1.2.0 or newer, the packaged architecture, the exact
  `core-bun.mjs` checksum, worker support, SQLite, filesystem/watch, socket, Effect, and native Core
  health conformance.
- Forced Bun fails qualification rather than silently selecting utility. Auto may select utility only
  before acknowledged database ownership.
- Node `node:sqlite` and `bun:sqlite` run the shared store, transaction, migration, backup, constraint,
  WAL, and fixture conformance suite.

Evidence: `packages/desktop/electron/main/core-bun-runtime.test.ts`,
`packages/desktop/electron/main/bun-runtime-qualification-hooks.test.ts`,
`packages/desktop/scripts/build-core-artifact.test.mjs`, and
`packages/persistence/src/test-support/database-conformance.ts`.

## D-03 Supervision

- Listening has a finite startup deadline and failed launch cleanup has its own two-second bound.
- Bun and utility have independent crash circuits. Production opens one host circuit after three
  crashes inside 60 seconds; crashes outside the window expire.
- A ready-host exit first cleans host-owned resources. Draining exits stop; other exits are either
  restart-eligible or unavailable after the circuit opens.
- No runtime fallback is allowed after ownership authorization.

Evidence: `packages/desktop/electron/main/core-process-launcher.ts`,
`packages/desktop/electron/main/core-host-supervisor.ts`, and their focused tests. Packaged heartbeat,
orphan, and repeated-crash timing remains a release gate.

## D-04 Backup And Ownership

- Migration backup requires a complete WAL checkpoint, bounded creation and verification, integrity,
  foreign-key, and schema-version checks.
- Node uses the runtime backup API; Bun uses `VACUUM INTO`. Both verify through an independently opened
  runtime adapter before publication.
- Publication fsyncs the staging file, renames atomically, and fsyncs the parent directory. Failure
  removes incomplete staging output.
- Ownership records bind application instance, Core epoch, PID, process-start identity, and nonce.
  Corrupt or uncertain stale ownership fails closed; release requires the exact unchanged owner record.

Evidence: `packages/persistence/src/sqlite-backup.test.ts`,
`packages/persistence/src/database-ownership.test.ts`, and dual-runtime database conformance.

## D-05 Resource Pressure

- Managed disposable resources trigger collection above 4 GiB and collect toward 3 GiB. Durable user
  data is structurally ineligible.
- Reservation happens before unknown-length writes cross accounted capacity.
- Live leases on a resource or descendant protect the complete tree. Eligible resources rank
  temporary before cache before migration backup, then oldest use and stable ID.

Evidence: `packages/core/src/resource-policy.test.ts`, including one-year `TestClock` arithmetic. A
minimum free-space reserve and full-fixture pressure measurements remain provisional.

## D-06 Retention And Old Artifacts

- Collection can select only explicitly registered disposable resources and typed locations.
- Unknown older filesystem artifacts remain untouched until an explicit migration recognizes and
  registers them.
- Shared snapshot blocks remain reachable while any snapshot references them; active foreground and
  durable-operation leases prevent reclamation.

Evidence: `packages/core/src/resource-producer-registration.test.ts`,
`packages/core/src/disposable-resource-lifecycle.test.ts`, and
`packages/persistence/src/snapshot-block-store.test.ts`. Packaged old-cache migration and filesystem
space-return evidence remains.

## D-07 Repository Watching

- One active project watcher uses a 75 ms trailing debounce, 500 ms maximum wait, and 30-second
  authoritative polling fallback.
- Focus, resume, overflow, and timer reasons bypass hint debounce. One reconciliation runs at a time;
  an event during reconciliation schedules one follow-up.
- Generation and project identity prevent stale watcher resolution or reconciliation from publishing.
  Native watcher failure is never authoritative.

Evidence: `packages/local-git/src/repository-watcher.test.ts` and
`packages/local-git/src/repository-reconciliation.test.ts`. Packaged linked-worktree and longevity
evidence remains.
