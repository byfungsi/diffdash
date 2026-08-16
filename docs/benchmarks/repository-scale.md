# Repository-Scale Evidence

FUN-214 measurements are local evidence, not per-commit CI gates. The generated comparison and raw
process samples remain ignored under `tools/repository-scale/.cache/`.

## Method

1. Generate the deterministic, auth-independent pathological suite with
   `pnpm repository-scale:generate`. It produces exactly 61,000 files and 30,000,000 rows under the
   ignored benchmark cache, including enormous-file, wrapped-line, annotation, broad-search, and
   revision-change cases. Alternatively, prepare a pinned comparison from an existing local checkout
   with `pnpm repository-scale:prepare`.
2. Open the emitted repository and exact SHAs with `diffdash compare`.
3. Exercise initial load, broad search, rapid scrolling, far-target navigation, annotations, and
   revision switching.
4. Alternate the pathological and small review ten times. Run `pnpm repository-scale:measure` on
   Linux with the pinned manifest, selected Bun or utility host, active scenario, app version,
   packaged confirmation, packaged artifact digest, Core review-session identity, and
   foreground-disposal confirmation; Bun runs also record its runtime version. The first three are
   warm-up and each report uses the fixed 60-second duration, 500 ms interval, 10-second steady window,
   and five-percent steady-window threshold.
5. Run `pnpm repository-scale:evaluate` for the session. The seven evaluated samples must vary by no
   more than the greater of five percent or 32 MiB, the final sample cannot exceed the first by that
   tolerance, and monotonic growth fails regardless.
6. Copy only reviewed aggregate values into a dated section below. Record the DiffDash commit,
   fixture ID, operating system, architecture, physical memory, scenario, and pass/fail guardrails.

Promoted Linux `/proc` measurements require RSS, private RSS, swap, and disk I/O for the Electron,
renderer, and Core/worker roles. Every platform also records SQLite bytes, snapshot block and spool
bytes, local and remote worktree-pool bytes, and filesystem free-space deltas without retaining their
paths. macOS process measurements provide RSS only and cannot be promoted as the full Linux run.
Renderer-owned DOM, frame, highlight, and
reconciliation observations come from browser instrumentation; Core queue, reservation, cache, and
worker counters must use the same dated evidence section rather than entering telemetry.

Initial guardrails remain upper bounds: 128 MiB renderer line chunks, 64 MiB renderer highlighted
ranges, 64 MiB renderer layout/navigation metadata, 64 MiB Core parser/source buffers, 16 MiB
in-flight Core transport, zero Electron complete-diff bytes, 1,000 mounted rows, and 4/3 GiB managed
cache high/collection watermarks.

## Results

No repository-scale baseline has been promoted yet. Promotion requires the content-derived fixture
ID, pinned base/head manifest, exact DiffDash commit, machine profile, measured values, and objective
pass/fail status required by the decision register.

The M21 specification records pre-cutover observations of approximately 424 MiB renderer residency,
737 MiB peak residency, and 398 MiB swap. It also records the comparison product at approximately
1.15 GiB on Linux with three desktop workers, a complete browser-side patch model, and a 100-entry AST
LRU. These are comparison inputs, not promoted DiffDash measurements. The final report must reproduce
or explain each value and must attribute retained text, syntax output, DOM/container state,
annotations, measurement state, workers, queues, and reservations by owner.
