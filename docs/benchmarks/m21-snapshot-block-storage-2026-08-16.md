# M21 Snapshot Block Storage Evidence, 2026-08-16

## Scope

FUN-234 establishes the storage architecture and deterministic integration evidence needed by D-09.
It does not claim a packaged repository-scale performance result. The full exact-Git versus managed-spool
capacity benchmark remains to be run on the M21 scale fixtures.

## Implemented Decision

- SQLite is authoritative for immutable manifests, exact file deltas, hunks, block metadata,
  snapshot-owned placements, and sparse checkpoints.
- Unified diff bytes live in independent checksummed managed files. SQLite has no row per diff line.
- A block is visible only after its synced temporary file is atomically promoted, verified, and its
  block, reservation, and catalog resource rows become ready in one SQLite transaction.
- Remote, mutable, and untracked sources retain a managed spool resource reference in the manifest.
  Reproducible immutable Git sources retain repository, base object, head object, and diff-policy
  identities and may reserve and materialize output lazily.
- Exact file deltas are shared only when old content, new content, old mode, new mode, status,
  canonical diff options, diff-policy identity, and identity version all match.
- Snapshot manifests own file and block ordering. Collection follows manifest reachability and
  catalog leases, so deleting one snapshot cannot reclaim bytes referenced by another.
- Normalized block-level deduplication remains out of scope. No benchmark evidence currently
  justifies its additional identity and collection complexity.

## Deterministic Evidence

`packages/persistence/src/snapshot-block-store.test.ts` uses real `node:sqlite` and filesystem files
to cover:

- abandonment before staging;
- recovery after a synced temporary write;
- recovery after atomic promotion but before SQLite visibility;
- restart after finalization;
- reserve-ahead quota rejection;
- managed-spool and exact-Git source metadata;
- exact-key field separation;
- two-manifest sharing, first-reference deletion, last-reference deletion, and a live lease;
- recovery after collection intent and quarantine.

The focused suite passed on 2026-08-16. Its test duration is not a throughput or capacity benchmark
and must not be used to select production block sizing.

## Remaining Measurement

Run the packaged M21 repository-scale fixtures against both managed-spool and exact-Git lazy
materialization. Record fixture ID, commit, machine profile, peak RSS, SQLite size, managed bytes,
ingest time, cold and warm range-read latency, collection latency, and quota behavior before treating
D-09 as a full-scale performance decision.
