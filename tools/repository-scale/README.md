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
  --database=/path/to/user-data/diffdash.sqlite \
  --snapshot-root=/path/to/user-data/diffdash.sqlite.snapshot-blocks \
  --spool-root=/path/to/user-data/diffdash.sqlite.snapshot-blocks/spools \
  --worktree-root=/path/to/home/.diffdash/worktree-pool \
  --remote-worktree-root=/path/to/home/.diffdash/remote-worktree-pool \
  --session=linux-baseline \
  --switch=1 \
  --host=utility \
  --scenario=pathological \
  --app-version=0.8.1 \
  --artifact-digest=<packaged-app-asar-sha256> \
  --review-session-id=<active-core-review-session-id> \
  --packaged=true \
  --disposal-complete=true
```

The manifest pins every report to the exact fixture ID and base/head revisions. Reports also record
the exact DiffDash commit and a source-safe machine profile; all ten switches must use identical
provenance, packaged artifact digest, and Core host/session/switch identity. Bun reports additionally
record the selected Bun version. Reports must alternate pathological and small reviews and are
rejected unless the packaged app has completed foreground disposal. The JSON report contains no
command lines or repository paths. It records peak RSS by Electron, renderer, Core/worker, and child
ownership. Linux
also requires exact private RSS, swap, and benchmark I/O deltas from `/proc` for Electron, renderer,
and Core/worker roles. SQLite bytes, snapshot block bytes, spool bytes, local and remote worktree-pool
bytes, and filesystem free-space deltas are recorded before and after every sample.
Unsupported macOS process fields remain `null`. Each sample records a final ten-second steady window,
but the switch gate is authoritative. After switch ten, evaluate the session:

```sh
pnpm repository-scale:evaluate -- --session=linux-baseline
```

The seven post-warm-up samples must stay within the greater of five percent or 32 MiB, the final
sample must not exceed the first by that tolerance, and monotonic growth always fails. Keep raw
reports ignored and promote only reviewed, path-free summaries into `docs/benchmarks/`.

## Packaged orchestration

Run a reduced deterministic fixture through the existing packaged E2E build with either forced Core
host:

```sh
pnpm --filter @diffdash/repository-scale smoke -- --host=bun
pnpm --filter @diffdash/repository-scale smoke -- --host=utility
```

The full run requires the exact generated 61,000-file/30,000,000-row manifest. Generate it first, then
name the evidence session:

```sh
pnpm repository-scale:generate
pnpm --filter @diffdash/repository-scale run -- --host=utility --session=linux-baseline
```

Both commands open the pinned local comparison without network or authentication, verify the actual
Core host process, exercise progressive first/far ranges, diff search, reload, rapid comparison
switches, Core restart, and process teardown. Full runs directly use the fixed process/storage
measurement policy for ten alternating pathological/small switches. Objective gate failures exit
nonzero. Raw Playwright and measurement artifacts remain ignored under `.cache/orchestration`; the
adjacent path-free `summary.json` retains per-switch process-role and storage aggregates. The evidence
workflow uploads both files on successful and failed runs, while failure-only Playwright diagnostics
use a shorter retention period.
