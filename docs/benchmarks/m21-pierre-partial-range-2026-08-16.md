# M21 Pierre Partial-Range Evidence

Date: 2026-08-16

Decision: D-13

## Decision

Use Pierre's public API behind a DiffDash-owned loaded-range adapter. Do not patch or fork Pierre and
do not make the global virtualizer depend on undocumented `CodeView` state.

The qualified dependency is `@pierre/diffs@1.3.0-beta.10`, Apache-2.0, pinned by
`pnpm-lock.yaml` to:

```text
sha512-efyFM9GRfI6WkmHJP0CnZBopuM8yCwGqIKbZHoe1D5PV15VDkr7Vpi8EZt40AYrN1km//utQtYhHDSwt2KwjSg==
```

## Alternatives

| Alternative | Result |
| --- | --- |
| Public `FileDiff` API with a DiffDash-owned scheduler and ownership boundary | Selected |
| Pierre `CodeView` as the global review virtualizer | Rejected because review-wide paging, budgets, identity, cancellation, and logical scroll ownership belong to DiffDash |
| Patch or fork Pierre internals | Rejected because the prototype needs no private API |
| Replace the production review renderer during WP01 | Rejected; this prototype is an isolated feasibility seam for WP17 |

## Public Surface Proven

`packages/app/src/review/pierre-loaded-range-prototype.ts` uses only package exports:

* `FileDiff.render({ fileDiff, renderRange, lineAnnotations })` receives one loaded bounded range.
* `FileDiffOptions.diffStyle` preserves unified and split coordinates.
* `FileDiffOptions.overflow = "wrap"` plus a host `ResizeObserver` reports height deltas to the
  outer layout owner.
* `FileDiff.getLineIndex` resolves old/deletion and new/addition semantic coordinates without
  querying private `CodeView` state.
* Public line annotations mount thread content on partial hunks. Search substring ranges mount from
  rendered semantic text, as the existing `ReviewSearchHighlightManager` already does.
* Plain rendering forces `tokenizeMaxLength: 0`. Deferred syntax uses `primeHighlightCache` and
  rerenders the same semantic key, range, annotations, width, and mode.
* `FileDiff.cleanUp` and an explicit host reset form the pool return contract.

Pierre's `renderRange` uses dense rendered-row indexes, while the parsed hunk metadata retains
one-based old/new source coordinates. DiffDash therefore owns semantic range boundaries and passes
Pierre only the loaded patch metadata plus dense range window.

## DiffDash-Owned Behavior

The adapter intentionally keeps these concerns outside Pierre:

* Exact latest-request identity includes project, process epoch, snapshot generation, session epoch,
  request ID, width, and mode.
* A new viewport direction or far target aborts range and highlight signals. Output is checked again
  at publication, so an uncooperative producer cannot publish stale work.
* Far targets publish estimated shell geometry before I/O.
* The visible range remains owned until replacement plain text is ready (inverse-sticky retention).
* Measurement deltas above the anchor adjust logical scroll; large logical offsets rebase into a
  bounded browser scroll page without coordinate loss.
* Text, highlight, AST/output, DOM/container, annotation, observer, measurement, reservation, and
  worker owners release as one idempotent lease. The byte-bounded LRU cannot evict only half a range.

Pierre's `primeHighlightCache` does not accept an `AbortSignal`. Production highlighting must remain
behind the DiffDash cancellable worker lane; `cleanUp` cancels the renderer side and exact identity
gating prevents late publication. This does not require a Pierre patch.

## Objective Evidence

Focused unit coverage proves:

* shell priming, plain-first publication, and deferred identity-equivalent syntax;
* rapid reversal cancellation and stale range rejection;
* stale or semantically changed syntax rejection;
* inverse-sticky height correction and exact logical-scroll rebasing;
* byte-budget eviction and release continuation across all coordinated owners.

Focused Chromium browser coverage proves:

* partial hunk text renders in unified and split modes with source coordinates 40/50;
* thread annotations and search text ranges mount on the bounded content;
* wrap measurement emits an outer height delta;
* pooled hosts remove Pierre DOM, observers, style, and stale ownership attributes.

Commands:

```text
pnpm --dir packages/app exec vitest --config vitest.config.ts run src/review/pierre-loaded-range-prototype.test.ts
pnpm --dir packages/app exec vitest --config vitest.browser.config.ts run src/review/pierre-loaded-range-prototype.browser.test.tsx
pnpm --filter @diffdash/app typecheck
```

This closes only D-13. Numerical D-12 budgets remain pending the full compact-index and global
virtualizer benchmark; this prototype demonstrates the ownership and API shape without selecting
those limits.
