# M21 Global Virtualizer Evidence

Date: 2026-08-16

Decision: D-12

DiffDash baseline commit: `e4754a5a8407c86b47d0e9e19ac3d6c887f3ec1a` plus the uncommitted
FUN-237 prototype described here.

Machine: Apple silicon arm64, macOS 26.5.2 (25F84), 24 GiB physical memory.

Fixture: deterministic equivalent of the committed `repositoryScaleProfile` in
`tools/repository-scale/src/synthetic-fixture.mjs`: exactly 61,000 files, 30,000,000 rows, and one
1,000,000-row file. The unit fixture uses the same row-allocation formula but does not generate file
contents because D-12 measures renderer index and scheduling structures rather than Git ingestion.

## Decision

Adopt the DiffDash-owned compact layout, visibility projection, scheduler, logical scroll owner,
global mount window, shell pool, and coordinated renderer caches as the production integration API.
Keep Pierre behind the public loaded-range seam selected by D-13.

This is deterministic structural evidence. It does not claim packaged Electron RSS, swap, frame-time,
or end-to-end worker measurements; those still require production wiring and the promoted
repository-scale baseline procedure in `repository-scale.md`.

## Selected Limits

| Owner | Limit |
| --- | ---: |
| Compact layout/navigation metadata | 64 MiB |
| Browser logical scroll page | 8,000,000 px |
| Mounted diff rows | 1,000 |
| Scheduler global concurrency | 6 |
| Scheduler queued input: target / viewport / prefetch / background | 2 / 4 / 8 / 2 MiB |
| Scheduler reserved output: target / viewport / prefetch / background | 16 / 24 / 16 / 8 MiB |
| Scheduler concurrency: target / viewport / prefetch / background | 2 / 4 / 2 / 1 |
| Text cache | 128 MiB |
| Syntax AST / output caches | 32 / 32 MiB |
| DOM/container cache | 32 MiB |
| Annotation / measurement caches | 8 / 8 MiB |
| Prefetch / pin caches | 16 / 8 MiB |

Queued bytes and reserved output bytes are different counters. Admission fails before either hard
lane limit is exceeded. Canceled queued work releases both immediately; canceled active work releases
its output reservation immediately and retains its concurrency slot until its promise settles. This
allows a latest viewport request to be admitted without permitting an uncooperative canceled task to
create extra active concurrency.

## Objective Results

| Check | Observed | Result |
| --- | ---: | --- |
| 61,000-file compact arrays (`Uint32` rows, `Uint8` flags, `Float64` heights/Fenwick tree) | 1,281,008 bytes | Pass, below 64 MiB |
| Worst-case all-visible projection (`Uint32` visible and `Int32` reverse mapping) | 488,000 bytes | Pass |
| Combined compact layout plus all-visible projection | 1,769,008 bytes | Pass |
| Exact represented rows | 30,000,000 | Pass |
| Direct final-file seek physical coordinate | below 8,000,000 px with exact origin sum | Pass |
| Global mount projection | never above 1,000 rows | Pass |
| Latest viewport conflation | stale queued viewport never starts | Pass |
| Reversal cancellation | active viewport read, prefetch, and background highlight signals abort | Pass |
| Lane pressure | queued bytes, concurrency, and reservations reject over-limit work | Pass |
| Width/mode reflow | semantic file/row/fraction preserved | Pass |
| Inverse sticky | only measurement changes before the anchor adjust logical scroll | Pass |
| Coordinated cache eviction | over-budget category releases all owners for that range | Pass |
| Shell reuse | reset always precedes reuse; overflow is destroyed | Pass |

The compact index has no per-file React element, object, observer, map entry, or closure. File paths
remain owned by the existing review manifest; policy bitsets produce one projection consumed by both
tree and canvas. Scheduler objects exist only for bounded in-flight work.

## Commands

```text
pnpm --dir packages/app exec vitest --config vitest.config.ts run src/review/review-layout-index.test.ts src/review/review-load-scheduler.test.ts src/review/review-global-virtualizer.test.ts
pnpm --filter @diffdash/app typecheck
pnpm --filter @diffdash/app lint
pnpm exec biome check packages/app/src/review/review-layout-index.ts packages/app/src/review/review-layout-index.test.ts packages/app/src/review/review-load-scheduler.ts packages/app/src/review/review-load-scheduler.test.ts packages/app/src/review/review-global-virtualizer.ts packages/app/src/review/review-global-virtualizer.test.ts docs/benchmarks/m21-global-virtualizer-2026-08-16.md docs/benchmarks/m21-decision-register.md
```

## Production Integration Requirements

The prototype intentionally does not change the current production review UI. Integration must:

1. Build row-count and policy bitsets from progressive renderer state without materializing all file
   payloads in the renderer.
2. Feed the shared visibility projection to both Pierre's file tree adapter and the canvas.
3. Translate scheduler tasks to cancellable review-data-worker page/range requests and report the
   pressure counters through existing diagnostics, not product telemetry.
4. Bind logical page rebases and semantic anchor correction to the review scroll container.
5. Lease `PierreLoadedRangeRenderer` hosts through `ReviewShellPool` and place loaded owners into the
   corresponding independent caches.
6. Run the packaged Linux 61k/30m scenario, promote RSS/swap/frame results, and reproduce or explain
   the prior 424 MiB residency, 737 MiB peak, and 398 MiB swap observations before rollout.
