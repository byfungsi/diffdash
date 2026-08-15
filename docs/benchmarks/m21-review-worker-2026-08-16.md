# M21 Incremental Review Worker Evidence, 2026-08-16

## Scope

This implementation checkpoint selects strict source/parser limits and a disposable worker protocol
for FUN-233. The generated Core artifact now stages checksummed Node and Bun worker entrypoints and
verifies their shared build identity before Desktop accepts the artifact. It does not claim the final
packaged 61,000-file/30,000,000-row RSS benchmark.

## D-08 Limits

| Limit | Selected value | Enforcement |
| --- | ---: | --- |
| Source chunk | 64 KiB | `ReviewDiffSource` validator and incremental parser ingress |
| Canonical line | 256 KiB UTF-8 | incremental parser before line publication |
| Core-facing parser batch | 128 events | incremental parser batch flush |
| Core-facing parser batch payload | 512 KiB | incremental parser batch flush |
| Complete file page | 2 MiB / 256 files | committed `ReviewDiffSource` contract |
| Complete buffered fallback | 8 MiB | committed `ReviewDiffSource` contract |

The 256 KiB line limit exactly covers the current pathological wrapped-line fixture. One additional
byte fails with typed `lineTooLarge`; raising it requires new evidence because parser/source memory is
bounded above by 64 MiB.

Deterministic conformance checks every byte split in the semantic corpus and 200 seeded generated
partitions, including UTF-8 continuation bytes, headers, hunk content, rename/add/binary metadata,
and no-newline markers. A bounded second pass over staged bytes reproduces the existing
`file-patch:v1`, `hunk:`, and `hunk-content:` identities without retaining finalized file line arrays.

## D-11 Worker Policy

Node uses one `worker_threads.Worker`; Bun uses one Web Worker through the same structural adapter.
The worker protocol accepts only bounded bytes, finish, heartbeat, and cancellation. It has no
SQLite package dependency, database path, persistence service, or ambient Core service container.

Source delivery permits one acknowledged chunk at a time. Parser work per turn is therefore capped
at 64 KiB plus a 256 KiB partial line, allowing heartbeat commands between turns. Cancellation and
review switch call runtime termination and resolve every pending request as terminated. A real Node
worker test proves heartbeat and termination; a deterministic held-parser fake proves heartbeat is
independent of a pending parse request and cancellation reclaims the handle. Generated-artifact tests
also execute the parser protocol in real Node and Bun workers, reject an oversized chunk, and verify
both worker checksums and their combined build identity. Bun was available at `1.2.23` for this check.

## Remaining Integration Evidence

Production review loading is deliberately not cut over in this work package. Before that cutover,
Core must supply the pre-authorized source staging resource needed for range replay instead of the
entrypoints' inert staging capability, then consume the already-composed coordinator from the review
operation. Packaged Node and Bun runs must record heartbeat latency, process heap/RSS/private bytes,
cancellation latency, and post-termination reclamation on the generated
61,000-file/30,000,000-row fixture. Product SQLite must be held open exclusively by Core during that
run to prove the worker cannot acquire it. No result for that scale measurement is claimed here.
