# Repository-Scale Benchmark

This private tool prepares a local, pinned comparison from an existing Git checkout, measures a
running DiffDash process tree, and evaluates the required ten-switch memory plateau. Generated
repositories and raw reports stay under `.cache/` and are ignored. The tool never fetches from a
remote.

## Prepare a Linux comparison

Use an existing local Linux checkout and immutable revisions:

```sh
pnpm repository-scale:prepare -- \
  --source=/path/to/linux \
  --base=<base-revision> \
  --head=<head-revision> \
  --name=linux
```

The command makes a local shared clone without checking out files, resolves both revisions to exact
commit SHAs, and streams `git diff --numstat` to record changed-file and row counts. It does not
materialize or commit the patch. Run DiffDash from the printed repository path:

```sh
cd tools/repository-scale/.cache/fixtures/<fixture-id>/repository
diffdash compare <base-sha> <head-sha>
```

## Generate the synthetic comparison

`pnpm repository-scale:generate` creates deterministic base, head, and annotation-revision commits
without network access. The default manifest describes 61,000 logical changed files and 30,000,000
added text rows. A detected rename counts as one changed file; binary files count toward files but not
rows. Deleted rows are separate and do not reduce the configured added-row total. The fixture includes
binary modification, pure rename, deletion, executable mode-only, no-final-newline, dense-thread,
annotation, broad-search, enormous-file, and wrapped-line scenarios.

## Measure the process tree

Find the main DiffDash Electron PID after opening the comparison. Record one post-disposal sample
after each of ten alternating pathological/small review switches. The first three switches are
warm-up:

```sh
pnpm repository-scale:measure -- \
  --pid=<pid> \
  --manifest=tools/repository-scale/.cache/fixtures/<fixture-id>/manifest.json \
  --session=linux-baseline \
  --switch=1
```

The manifest pins every report to the exact fixture ID and base/head revisions. Reports also record
the exact DiffDash commit and a source-safe machine profile; all ten switches must use identical
provenance. The JSON report contains no command lines or repository paths. It records peak RSS by Electron,
renderer, Core/worker, and child ownership. Linux also reports exact private RSS, swap, and benchmark
I/O deltas from `/proc`; unsupported macOS fields remain `null`. Each sample records a final ten-second
steady window, but the switch gate is authoritative. After switch ten, evaluate the session:

```sh
pnpm repository-scale:evaluate -- --session=linux-baseline
```

The seven post-warm-up samples must stay within the greater of five percent or 32 MiB, the final
sample must not exceed the first by that tolerance, and monotonic growth always fails. Keep raw
reports ignored and promote only reviewed, path-free summaries into `docs/benchmarks/`.
