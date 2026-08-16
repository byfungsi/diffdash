# M21 Foundation Decision Register

FUN-214 owns the numerical decisions below. A decision remains pending until a dated local benchmark
or threat-model artifact records the fixture ID, DiffDash commit, machine profile, alternatives,
measured values, selected limits, and objective pass/fail result. PRD capacity guardrails are upper
bounds and cannot be increased without an RFC amendment.

| ID | Evidence required | Status |
| --- | --- | --- |
| D-01 | Frame, chunk, acknowledgement, queue-byte, concurrency, and cancellation limits under malformed, slow-consumer, and disconnect pressure | Decided 2026-08-16 by [`m21-transport-2026-08-16.md`](m21-transport-2026-08-16.md) |
| D-08 | Source chunk/page/enormous-line limits across stream, complete-page, exact-Git, and bounded-buffer offers | Implemented 2026-08-16 with deterministic parser conformance in [`m21-review-worker-2026-08-16.md`](m21-review-worker-2026-08-16.md); packaged 61k/30m scale confirmation remains |
| D-09 | Exact-Git versus managed-spool backend comparison; exact old/new content, mode/status, diff options, and policy identity key; shared block reachability after snapshot deletion | Provisional 2026-08-16 architecture and deterministic crash/reachability evidence in [`m21-snapshot-block-storage-2026-08-16.md`](m21-snapshot-block-storage-2026-08-16.md); packaged scale comparison remains |
| D-10 | Fixed-space literal search scan, acceleration, cursor, excerpt, and near-every-line match behavior | Provisional 2026-08-16 algorithm and deterministic SQLite/filesystem evidence in [`m21-search-2026-08-16.md`](m21-search-2026-08-16.md); packaged scale measurement and RPC/renderer cutover remain |
| D-11 | Bun/utility worker heartbeat, kill, cancellation, heap reclamation, and crash behavior | Worker-host implementation and generated-artifact Node/Bun process checks complete 2026-08-16 in [`m21-review-worker-2026-08-16.md`](m21-review-worker-2026-08-16.md); packaged heap/RSS/reclamation measurement remains |
| D-12 | Compact index, logical scroll page, mounted rows, independent text/highlight/AST/DOM/annotation/measurement budgets, viewport conflation, queue/concurrency/output reservation, inverse-sticky behavior, rebasing, and container reset | Decided 2026-08-16 by deterministic structural evidence in [`m21-global-virtualizer-2026-08-16.md`](m21-global-virtualizer-2026-08-16.md); packaged Linux RSS/swap/frame promotion remains |
| D-13 | Pierre public loaded-range API versus an isolated patch/fork, including coordinates, wrap measurement, deferred syntax, annotations, cancellation, and cleanup | Decided 2026-08-16 by [`m21-pierre-partial-range-2026-08-16.md`](m21-pierre-partial-range-2026-08-16.md) |
| D-14 | Packaged Linux ingest, first-range, far-target, search provisional/final/rescan, cancellation, frame/long-task, and collection latency SLOs | Pending packaged 61k-file/30m-row evidence; deterministic tests are not sufficient for approval |

## Existing Upper Bounds

| Owner | Guardrail |
| --- | ---: |
| Renderer loaded line chunks | 128 MiB |
| Renderer highlighted ranges | 64 MiB |
| Renderer layout/navigation metadata | 64 MiB |
| Core parser/source buffers | 64 MiB |
| In-flight Core transport | 16 MiB |
| Electron complete diff retention | 0 bytes |
| Mounted diff rows | 1,000 |
| Managed cache high water | 4 GiB |
| Managed collection target | 3 GiB |

## Prior Observations To Reproduce

The first promoted baseline must reproduce or explain the previously observed approximately 424 MiB
renderer residency, 737 MiB peak, and 398 MiB swap. Comparative DiffsHub evidence must record its
complete browser-side patch model, three desktop workers, 100-entry AST LRU, and approximately 1.15
GiB Linux-comparison footprint before adopting only its bounded virtualization techniques.
