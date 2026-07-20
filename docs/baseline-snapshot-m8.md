# M8 Pre-Migration Baseline Snapshot

Snapshot executed on 2026-07-15 after `pnpm install --frozen-lockfile`. This is the accepted
behavioral baseline for M9-M13.

## Identity

| Field | Value |
|---|---|
| Baseline code commit | `52011909182ba734537a06e9cdca57de3256aba4` |
| Branch | `chore/reorganize` |
| DiffDash | `0.3.1` |
| Node | `22.20.0` |
| pnpm | `10.26.1` |
| Electron | `43.0.0` |
| Operating system | macOS `26.0.1` build `25A362` |
| Architecture | `arm64` |
| SQLite schema | `8` |
| Worktree before/after gates | Clean; no intentional dirty exceptions |

## Fixture Identity

| Fixture set | SHA-256 |
|---|---|
| Codex and Claude success/error/invalid/malformed/mutation JSONL set | `6ea7ff3c52c199562d887f9c83fe4be2c89543adc5f933744edb10f7108e4758` |
| Deterministic demo scenario sources | `fc706389940d0faaafcbc189cca4663a0e27086616b93444c46b00a0f4778766` |
| Populated v8 SQL source | `ffda0719ccbf8f5a93566cb9c648f514f17ab63ddbe2f8d9856478bf1bfd4f08` |
| Populated v8 SQLite fixture | `0e1605d6249548ff8678d13dd6353ae3b5ea066f6bfc34232b2a83cdca64ba51` |

Bundle hashes are the SHA-256 of sorted `shasum -a 256` output for the named files. The individual
database hashes are direct file hashes.

## Automated Results

| Gate | Result | Evidence |
|---|---|---|
| Frozen install | Pass | Lockfile current; prepare hook completed. |
| `pnpm format:check` | Pass | 228 files checked. |
| `pnpm lint` | Pass with accepted warning | 0 errors; one pre-existing landing key warning tracked by `FUN-156`. |
| `pnpm typecheck` | Pass | Main, preload, renderer, shared, tests, and tooling compile. |
| `pnpm test` | Pass | 58 files, 269 tests. |
| `pnpm test:browser` | Pass | 3 Chromium files, 38 tests. |
| `pnpm test:e2e` | Pass | 6 hidden real-Electron tests. |
| Download worker | Pass | 12 Node tests. |
| Landing build | Pass | TypeScript and Vite production build. |
| `pnpm promo:data:check` | Pass | 2 files, 6 deterministic demo tests. |
| Release infrastructure | Pass | Script syntax, 5 release-policy tests, worker check, and 12 worker tests. |
| `pnpm test:e2e:packaged` | Pass | Unsigned macOS arm64 package, real review, resources, isolation, SQLite, and restart. |

The full gate chain exited successfully. Generated build/package output remains ignored and is not
retained as source evidence.

## Accepted Exceptions

| Exception | Status | Owner | Follow-up |
|---|---|---|---|
| Landing scrub-word index key lint warning | Accepted pre-existing warning | Muhammad Hanif | `FUN-156` |
| Automated accessibility audit and retained live screen-reader run | Known gap; repeatable procedure approved | M8 verification owner | `GAP-A11Y-001` |
| Signed/notarized builds, clean-machine installers, and public post-promotion checks | Not run because this snapshot is not a production release; operational procedure approved | Release operator and approver | `FUN-141`, `docs/release.md` |
| Cross-platform packaged execution outside macOS arm64 | Not run on this host; package-specific operational evidence required before release | Release operator and approver | `FUN-141`, `docs/release.md` |

No failed automated gate is hidden by an exception.

## Acceptance

All `[B]` rows in `docs/verification.md` have passing automated or approved repeatable evidence.
Known behavior gaps remain `[G]`; M9-M13 requirements remain `[T]` until their owning issues land.
This snapshot unblocks `FUN-117` and structural migration.
