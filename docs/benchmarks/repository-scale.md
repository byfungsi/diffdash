# Repository-Scale Evidence

FUN-214 measurements are local evidence, not per-commit CI gates. The generated comparison and raw
process samples remain ignored under `tools/repository-scale/.cache/`.

## Method

1. Prepare a pinned comparison from an existing local Linux checkout with
   `pnpm repository-scale:prepare`.
2. Open the emitted repository and exact SHAs with `diffdash compare`.
3. Exercise initial load, broad search, rapid scrolling, far-target navigation, annotations, and
   revision switching.
4. Alternate the pathological and small review ten times. Record switches one through ten with
   `pnpm repository-scale:measure`; the first three are warm-up and each report is captured after
   foreground disposal settles.
5. Run `pnpm repository-scale:evaluate` for the session. The seven evaluated samples must vary by no
   more than the greater of five percent or 32 MiB, the final sample cannot exceed the first by that
   tolerance, and monotonic growth fails regardless.
6. Copy only reviewed aggregate values into a dated section below. Record the DiffDash commit,
   fixture ID, operating system, architecture, physical memory, scenario, and pass/fail guardrails.

Linux `/proc` measurements include RSS, anonymous/private RSS, swap, and disk I/O. macOS measurements
provide RSS only. Renderer-owned DOM, frame, highlight, and reconciliation observations come from the
existing browser instrumentation; future Core queue and reservation counters must use the same dated
evidence section rather than entering telemetry.

Initial guardrails remain upper bounds: 128 MiB renderer line chunks, 64 MiB renderer highlighted
ranges, 64 MiB renderer layout/navigation metadata, 64 MiB Core parser/source buffers, 16 MiB
in-flight Core transport, zero Electron complete-diff bytes, 1,000 mounted rows, and 4/3 GiB managed
cache high/collection watermarks.

## Results

No repository-scale baseline has been promoted yet.
