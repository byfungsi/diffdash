# M21 Release SLO Report Template

Copy this file to `m21-release-slo-YYYY-MM-DD.md` only after running the packaged Ubuntu 24.04 x86_64
full fixture under both utility and Bun Core hosts. Replace every `PENDING` value with an observed
value and an approved threshold. Pending, inferred, or mixed-host values cannot promote D-14.

## Provenance

| Field | Value |
| --- | --- |
| DiffDash commit | PENDING |
| App version | PENDING |
| Fixture ID and base/head revisions | PENDING |
| OS, release, and architecture | PENDING |
| Logical CPUs and physical memory | PENDING |
| Node and Bun versions | PENDING |
| Core host | PENDING |
| Packaged artifact digest | PENDING |

## Latency And Interaction

| Gate | Threshold | Observed | Pass |
| --- | ---: | ---: | --- |
| Ingest to first committed block | PENDING | PENDING | PENDING |
| First range to plain-text display | PENDING | PENDING | PENDING |
| Far target resolution and focus | PENDING | PENDING | PENDING |
| First provisional broad-search result | PENDING | PENDING | PENDING |
| Final broad-search result | PENDING | PENDING | PENDING |
| Directional search rescan | PENDING | PENDING | PENDING |
| Superseded request cancellation | PENDING | PENDING | PENDING |
| Review disposal and collection | PENDING | PENDING | PENDING |

## Renderer

| Gate | Threshold | Observed | Pass |
| --- | ---: | ---: | --- |
| Mounted diff rows | 1,000 maximum | PENDING | PENDING |
| Live Pierre hosts and DOM nodes | PENDING | PENDING | PENDING |
| p50, p95, and p99 frame duration | PENDING | PENDING | PENDING |
| Long tasks over 50 ms | PENDING | PENDING | PENDING |
| Text, syntax, container, annotation, and measurement bytes | Owner budgets | PENDING | PENDING |

## Process And Queue Ownership

Record Electron, renderer, Core/worker, and child RSS, private RSS, JS heap, and swap independently.
Record every scheduler lane's depth, queued bytes, active count, cancellation age, and reserved output
bytes. Explain any process or allocation that cannot be attributed to one stable owner.

| Gate | Threshold | Observed | Pass |
| --- | ---: | ---: | --- |
| Renderer RSS, private RSS, heap, and swap | PRD upper bounds | PENDING | PENDING |
| Core/worker RSS, private RSS, heap, and swap | PRD upper bounds | PENDING | PENDING |
| Electron RSS, private RSS, heap, and swap | No complete-diff ownership | PENDING | PENDING |
| Child RSS, private RSS, heap, and swap | PENDING | PENDING | PENDING |
| Queue and reservation budgets | Configured lane limits | PENDING | PENDING |
| Ten-switch memory plateau | 5% or 32 MiB; no monotonic growth | PENDING | PENDING |

## Storage And Recovery

| Gate | Threshold | Observed | Pass |
| --- | ---: | ---: | --- |
| SQLite growth | PENDING | PENDING | PENDING |
| Managed-resource growth | 4 GiB high water; collect toward 3 GiB | PENDING | PENDING |
| Filesystem free-space delta after collection | PENDING | PENDING | PENDING |
| Worker heap reclaimed after cancellation or switch | PENDING | PENDING | PENDING |
| Core crash before and after ready | Recovery without fallback ownership | PENDING | PENDING |
| ENOSPC and read-only failure | Typed failure; no partial publication | PENDING | PENDING |
| Watcher longevity and reconciliation | No stale-generation publication | PENDING | PENDING |

## Baseline Explanation

Explain whether the run reproduces or supersedes the recorded approximately 424 MiB renderer
residency, 737 MiB peak, and 398 MiB swap. Compare it with the approximately 1.15 GiB comparison
product, three workers, complete browser patch ownership, and 100-entry AST LRU.

## Approval

| Role | Name | Date | Decision |
| --- | --- | --- | --- |
| Engineering | PENDING | PENDING | PENDING |
| Product | PENDING | PENDING | PENDING |
