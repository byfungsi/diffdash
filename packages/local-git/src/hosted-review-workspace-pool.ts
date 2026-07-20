import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"

import { makeHostedRepositoryKey } from "@diffdash/domain/git-provider"
import type { AgentRunId, ReviewAgentProgressStage } from "@diffdash/domain/review-agent"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import type { HostedReviewCheckoutSpec } from "@diffdash/git-provider"
import { ProcessService, type ProcessResult, type ProcessRunner } from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"
import { isProcessAlive, withFileLock } from "./hosted-review-workspace-file-lock"
import {
  type Manifest,
  type Slot,
  mutateManifest,
  updateSlot,
} from "./hosted-review-workspace-manifest"
import { HostedReviewWorkspacePoolError, poolError } from "./hosted-review-workspace-pool-error"
import {
  makeManagedWorkspaceFilesystem,
  type ManagedWorkspaceFilesystem,
  type ManagedWorkspacePath,
  pathForRepository,
  pathForSlot,
} from "./hosted-review-workspace-paths"

const MAX_POOL_SLOTS = 10
const GIT_TIMEOUT_MS = 120_000
const REPOSITORY_LOCK_TIMEOUT_MS = 30 * 60 * 1_000
/** Input required to materialize one exact hosted-review workspace. */
export interface HostedReviewWorkspaceInput {
  readonly runId: AgentRunId
  readonly threadId: ReviewThreadId
  readonly checkout: HostedReviewCheckoutSpec
  readonly sourcePath: string | null
  readonly bootstrapBareRepository: (destination: string) => Effect.Effect<void, unknown>
}

/** One exclusively leased, detached review worktree. */
export interface HostedReviewWorkspaceLease {
  readonly localPath: string
  readonly headSha: string
  readonly slotId: string
}

export { HostedReviewWorkspacePoolError } from "./hosted-review-workspace-pool-error"

/** Executes hosted-review agent work inside an exclusively leased managed worktree. */
export class HostedReviewWorkspacePool extends Context.Tag("@diffdash/HostedReviewWorkspacePool")<
  HostedReviewWorkspacePool,
  {
    readonly use: <A, E, R>(
      input: HostedReviewWorkspaceInput,
      run: (lease: HostedReviewWorkspaceLease) => Effect.Effect<A, E, R>,
      onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<A, E | HostedReviewWorkspacePoolError, R>
  }
>() {
  static readonly layer = (config: {
    readonly worktreePoolPath: string
    readonly remoteWorktreePoolPath: string
  }) =>
    Layer.effect(
      HostedReviewWorkspacePool,
      Effect.gen(function* () {
        const processes = yield* ProcessService
        const [localFilesystem, remoteFilesystem] = yield* Effect.all([
          makeManagedWorkspaceFilesystem(config.worktreePoolPath),
          makeManagedWorkspaceFilesystem(config.remoteWorktreePoolPath),
        ])
        const instanceId = randomUUID()

        const use = <A, E, R>(
          input: HostedReviewWorkspaceInput,
          run: (lease: HostedReviewWorkspaceLease) => Effect.Effect<A, E, R>,
          onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
        ): Effect.Effect<A, E | HostedReviewWorkspacePoolError, R> => {
          const filesystem = input.sourcePath === null ? remoteFilesystem : localFilesystem

          return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* reportProgress(onProgress, "reserving-workspace")
              const lease = yield* restore(
                reserveAndPrepare(filesystem, instanceId, processes, input, onProgress),
              )
              const runExit = yield* restore(run(lease)).pipe(Effect.exit)
              yield* reportProgress(onProgress, "restoring-workspace")
              const cleanupExit = yield* restoreAndRelease(
                filesystem,
                processes,
                input,
                lease,
              ).pipe(Effect.exit)
              if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause)
              if (Exit.isFailure(runExit)) return yield* Effect.failCause(runExit.cause)
              return runExit.value
            }),
          )
        }

        return HostedReviewWorkspacePool.of({ use })
      }),
    )
}

interface Reservation {
  readonly slot: Slot
  readonly evicted: Slot | null
}

const reserveAndPrepare = (
  filesystem: ManagedWorkspaceFilesystem,
  instanceId: string,
  processes: ProcessRunner,
  input: HostedReviewWorkspaceInput,
  onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const reservation = yield* mutateManifest(filesystem, (manifest) =>
      reserveSlot(manifest, instanceId, input),
    )

    const slotPath = pathForSlot(filesystem, reservation.slot)
    const lease = {
      localPath: slotPath,
      headSha: input.checkout.revision,
      slotId: reservation.slot.id,
    } satisfies HostedReviewWorkspaceLease

    const prepared = prepareSlot(filesystem, processes, input, reservation, onProgress).pipe(
      Effect.tap(() =>
        mutateManifest(filesystem, (manifest) => ({
          manifest: updateSlot(manifest, reservation.slot.id, (slot) => ({
            ...slot,
            state: "leased",
            headSha: input.checkout.revision,
            reviewNumber: input.checkout.review.number,
            lastError: null,
          })),
          value: undefined,
        })),
      ),
      Effect.as(lease),
    )

    const quarantine = (reason: string) =>
      mutateManifest(filesystem, (manifest) => ({
        manifest: updateSlot(manifest, reservation.slot.id, (slot) => ({
          ...slot,
          state: "quarantined",
          lease: null,
          lastError: reason,
        })),
        value: undefined,
      }))

    return yield* prepared.pipe(
      Effect.interruptible,
      Effect.onInterrupt(() =>
        quarantine("Review workspace preparation was interrupted.").pipe(Effect.ignore),
      ),
      Effect.catchAll((cause) =>
        quarantine(cause.reason).pipe(Effect.zipRight(Effect.fail(cause))),
      ),
    )
  })

const prepareSlot = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  input: HostedReviewWorkspaceInput,
  reservation: Reservation,
  onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
) => {
  const repositoryKey = makeHostedRepositoryKey(input.checkout.repository)
  const repositoryRoot = pathForRepository(filesystem, repositoryKey)

  const evicted = reservation.evicted
  const evict =
    evicted === null
      ? Effect.void
      : withFileLock(
          filesystem,
          filesystem.child(pathForRepository(filesystem, evicted.repositoryKey), "repository.lock"),
          () => evictSlot(filesystem, processes, evicted),
          REPOSITORY_LOCK_TIMEOUT_MS,
        )

  return evict.pipe(
    Effect.zipRight(
      withFileLock(
        filesystem,
        filesystem.child(repositoryRoot, "repository.lock"),
        () =>
          Effect.gen(function* () {
            const sourcePath = input.sourcePath
            yield* filesystem.ensureDirectory(repositoryRoot, "repository.mkdir")
            const barePath = filesystem.child(repositoryRoot, "repository.git")
            let bareExists = yield* filesystem.exists(barePath, "repository.exists")
            if (bareExists && !(yield* isBareRepository(filesystem, processes, barePath))) {
              yield* filesystem.remove(barePath, "repository.removeInvalid")
              bareExists = false
            }
            if (!bareExists) {
              yield* reportProgress(onProgress, "creating-repository")
              yield* filesystem.validate(barePath, "repository.create.path")
              if (sourcePath === null) {
                yield* input
                  .bootstrapBareRepository(barePath)
                  .pipe(
                    Effect.mapError((cause) =>
                      poolError(
                        "git",
                        "repository.bootstrap",
                        "DiffDash could not create its authenticated repository cache.",
                        cause,
                      ),
                    ),
                  )
                yield* filesystem.validate(barePath, "repository.bootstrap.result")
                yield* recordRemoteRepositoryUse(filesystem, input.checkout, true)
              } else {
                yield* runManagedGit(filesystem, [barePath], processes, [
                  "clone",
                  "--bare",
                  "--no-hardlinks",
                  "--",
                  sourcePath,
                  barePath,
                ])
              }
            }
            if (sourcePath !== null) {
              const sourceRemote = yield* runGit(processes, [
                "-C",
                sourcePath,
                "remote",
                "get-url",
                "origin",
              ])
              yield* runManagedGit(filesystem, [barePath], processes, [
                "--git-dir",
                barePath,
                "remote",
                "set-url",
                "origin",
                sourceRemote.stdout.trim(),
              ])
            }

            const fetchedRef = `refs/diffdash/reviews/${input.checkout.review.number}/head`
            yield* reportProgress(onProgress, "fetching-review-revision")
            yield* runManagedGit(filesystem, [barePath], processes, [
              "--git-dir",
              barePath,
              "fetch",
              "--no-tags",
              "--force",
              "origin",
              `+${input.checkout.fetchRef}:${fetchedRef}`,
            ])
            const fetched = yield* runManagedGit(filesystem, [barePath], processes, [
              "--git-dir",
              barePath,
              "rev-parse",
              "--verify",
              `${fetchedRef}^{commit}`,
            ])
            const fetchedSha = fetched.stdout.trim()
            if (fetchedSha !== input.checkout.revision) {
              return yield* poolError(
                "revision-changed",
                "prepare.verifyRevision",
                "The hosted review changed while its isolated workspace was being prepared. Refresh the review and retry.",
                new Error(`Expected ${input.checkout.revision}, fetched ${fetchedSha}`),
              )
            }

            yield* reportProgress(onProgress, "checking-out-revision")
            yield* recreateWorktree(
              filesystem,
              processes,
              barePath,
              pathForSlot(filesystem, reservation.slot),
              fetchedSha,
            )
            if (sourcePath === null)
              yield* recordRemoteRepositoryUse(filesystem, input.checkout, false)
          }),
        REPOSITORY_LOCK_TIMEOUT_MS,
      ),
    ),
  )
}

const restoreAndRelease = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  input: HostedReviewWorkspaceInput,
  lease: HostedReviewWorkspaceLease,
) =>
  Effect.gen(function* () {
    yield* mutateManifest(filesystem, (manifest) => ({
      manifest: updateSlot(manifest, lease.slotId, (slot) => ({ ...slot, state: "cleaning" })),
      value: undefined,
    }))
    const repositoryRoot = pathForRepository(
      filesystem,
      makeHostedRepositoryKey(input.checkout.repository),
    )
    const barePath = filesystem.child(repositoryRoot, "repository.git")

    const cleanup = withFileLock(
      filesystem,
      filesystem.child(repositoryRoot, "repository.lock"),
      () =>
        recreateWorktree(
          filesystem,
          processes,
          barePath,
          pathForSlot(filesystem, {
            repositoryKey: makeHostedRepositoryKey(input.checkout.repository),
            id: lease.slotId,
          }),
          lease.headSha,
        ),
      REPOSITORY_LOCK_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((cause) =>
        poolError(
          "cleanup",
          "release.restore",
          "DiffDash could not restore its isolated review workspace. The workspace was quarantined and will be rebuilt before reuse.",
          cause,
        ),
      ),
    )

    return yield* cleanup.pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          mutateManifest(filesystem, (manifest) => ({
            manifest: updateSlot(manifest, lease.slotId, (slot) => ({
              ...slot,
              state: "quarantined",
              lease: null,
              lastError: cause.reason,
            })),
            value: undefined,
          })).pipe(Effect.zipRight(Effect.fail(cause))),
        onSuccess: () =>
          mutateManifest(filesystem, (manifest) => ({
            manifest: updateSlot(manifest, lease.slotId, (slot) => ({
              ...slot,
              state: "available",
              lease: null,
              lastThreadId: String(input.threadId),
              lastUsedAt: new Date().toISOString(),
              lastError: null,
            })),
            value: undefined,
          })),
      }),
    )
  })

const recreateWorktree = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  worktreePath: ManagedWorkspacePath,
  headSha: string,
) =>
  Effect.gen(function* () {
    if (yield* filesystem.exists(worktreePath, "worktree.exists")) {
      yield* runManagedGit(filesystem, [barePath, worktreePath], processes, [
        "--git-dir",
        barePath,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]).pipe(Effect.catchAll(() => Effect.void))
      yield* filesystem.remove(worktreePath, "worktree.removeDirectory")
    }
    yield* runManagedGit(filesystem, [barePath], processes, [
      "--git-dir",
      barePath,
      "worktree",
      "prune",
      "--expire",
      "now",
    ])
    yield* runManagedGit(filesystem, [barePath, worktreePath], processes, [
      "--git-dir",
      barePath,
      "worktree",
      "add",
      "--force",
      "--detach",
      worktreePath,
      headSha,
    ])
    yield* filesystem.validate(worktreePath, "worktree.created.path")
    yield* verifyWorktree(filesystem, processes, worktreePath, headSha)
  })

const verifyWorktree = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  worktreePath: ManagedWorkspacePath,
  headSha: string,
) =>
  Effect.gen(function* () {
    yield* filesystem.validate(worktreePath, "worktree.verify.path")
    const [head, branch, status, clean] = yield* Effect.all([
      runGit(processes, ["-C", worktreePath, "rev-parse", "--verify", "HEAD"]),
      runGit(processes, ["-C", worktreePath, "branch", "--show-current"]),
      runGit(processes, ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]),
      runGit(processes, ["-C", worktreePath, "clean", "-ndx"]),
    ])
    if (
      head.stdout.trim() !== headSha ||
      branch.stdout.trim().length > 0 ||
      status.stdout.trim().length > 0 ||
      clean.stdout.trim().length > 0
    ) {
      return yield* poolError(
        "git",
        "worktree.verify",
        "The isolated review workspace could not be verified as clean at the expected revision.",
        new Error("Worktree verification failed"),
      )
    }
  })

const evictSlot = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  slot: Slot,
) => {
  const repositoryRoot = pathForRepository(filesystem, slot.repositoryKey)
  const barePath = filesystem.child(repositoryRoot, "repository.git")
  const slotPath = pathForSlot(filesystem, slot)
  return Effect.gen(function* () {
    if (yield* filesystem.exists(barePath, "evict.repository.exists")) {
      yield* runManagedGit(filesystem, [barePath, slotPath], processes, [
        "--git-dir",
        barePath,
        "worktree",
        "remove",
        "--force",
        slotPath,
      ]).pipe(Effect.catchAll(() => Effect.void))
      yield* runManagedGit(filesystem, [barePath], processes, [
        "--git-dir",
        barePath,
        "worktree",
        "prune",
        "--expire",
        "now",
      ]).pipe(Effect.catchAll(() => Effect.void))
    }
    yield* filesystem.remove(slotPath, "evict.remove")
  })
}

const reserveSlot = (
  manifest: Manifest,
  instanceId: string,
  input: HostedReviewWorkspaceInput,
): { readonly manifest: Manifest; readonly value: Reservation } => {
  const now = new Date().toISOString()
  const providerId = String(input.checkout.repository.providerId)
  const repositoryKey = makeHostedRepositoryKey(input.checkout.repository)
  const recovered = manifest.slots.map((slot) =>
    slot.state !== "available" && slot.state !== "quarantined" && !isProcessAlive(slot.lease?.pid)
      ? { ...slot, state: "available" as const, lease: null }
      : slot,
  )
  const available = recovered.filter(
    (slot) => slot.state === "available" || slot.state === "quarantined",
  )
  const preferredCandidates = available.filter((slot) => slot.repositoryKey === repositoryKey)
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort mutates only the new filtered array.
  preferredCandidates.sort((left, right) => {
    const leftThread = left.lastThreadId === String(input.threadId) ? 0 : 1
    const rightThread = right.lastThreadId === String(input.threadId) ? 0 : 1
    const leftSha = left.headSha === input.checkout.revision ? 0 : 1
    const rightSha = right.headSha === input.checkout.revision ? 0 : 1
    return (
      leftThread - rightThread ||
      leftSha - rightSha ||
      left.lastUsedAt.localeCompare(right.lastUsedAt)
    )
  })
  const preferred = preferredCandidates[0]
  const lruCandidates = [...available]
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort mutates only the new copied array.
  lruCandidates.sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt))
  const lru = lruCandidates[0]
  const existing = preferred ?? (recovered.length >= MAX_POOL_SLOTS ? lru : undefined)

  if (existing === undefined && recovered.length >= MAX_POOL_SLOTS) {
    throw poolError(
      "capacity",
      "reserve",
      "All 10 isolated review worktrees are busy. Wait for another review to finish, then retry.",
      new Error("Worktree pool is at capacity"),
    )
  }

  const id = existing?.id ?? createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12)
  const lease = {
    id: randomUUID(),
    runId: String(input.runId),
    threadId: String(input.threadId),
    instanceId,
    pid: process.pid,
    acquiredAt: now,
  }
  const slot: Slot = {
    id,
    providerId,
    repositoryKey,
    state: "preparing",
    headSha: input.checkout.revision,
    reviewNumber: input.checkout.review.number,
    lastThreadId: existing?.lastThreadId ?? null,
    lease,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    lastError: null,
  }
  const slots =
    existing === undefined
      ? [...recovered, slot]
      : recovered.map((item) => (item.id === id ? slot : item))
  return {
    manifest: { ...manifest, slots },
    value: {
      slot,
      evicted: existing !== undefined && existing.repositoryKey !== repositoryKey ? existing : null,
    },
  }
}

const runGit = (
  processes: ProcessRunner,
  args: readonly string[],
): Effect.Effect<ProcessResult, HostedReviewWorkspacePoolError> =>
  Effect.interruptibleMask((restore) =>
    Effect.gen(function* () {
      // ProcessService races child signals internally; keep that fiber interruptible while
      // joining it under the caller's original status so protected workspace cleanup stays masked.
      const fiber = yield* processes
        .streamLines(
          gitProcessRequest(args, {
            timeoutMs: GIT_TIMEOUT_MS,
            killAfterMs: 1_000,
            stdout: { maxBytes: 1024 * 1024, overflow: "error" },
            stderr: { maxBytes: 1024 * 1024, overflow: "truncate" },
            env: { GIT_TERMINAL_PROMPT: "0" },
          }),
        )
        .pipe(Stream.runLast, Effect.fork)
      const lastEvent = yield* restore(Fiber.join(fiber))
      return yield* Option.match(lastEvent, {
        onNone: () =>
          Effect.fail(
            poolError(
              "git",
              "git.run",
              "A Git command ended without a result.",
              new Error("No exit event"),
            ),
          ),
        onSome: (event) => {
          const { _tag: tag } = event
          return tag === "ProcessExit"
            ? Effect.succeed(event.result)
            : Effect.fail(
                poolError(
                  "git",
                  "git.run",
                  "A Git command ended without an exit event.",
                  new Error(event.line),
                ),
              )
        },
      })
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof HostedReviewWorkspacePoolError
          ? cause
          : poolError(
              "git",
              "git.run",
              "DiffDash could not prepare its isolated Git workspace.",
              cause,
            ),
      ),
    ),
  )

const runManagedGit = (
  filesystem: ManagedWorkspaceFilesystem,
  paths: readonly ManagedWorkspacePath[],
  processes: ProcessRunner,
  args: readonly string[],
) =>
  Effect.forEach(paths, (path) => filesystem.validate(path, "git.managedPath"), {
    discard: true,
  }).pipe(Effect.zipRight(runGit(processes, args)))

const isBareRepository = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
) =>
  runManagedGit(filesystem, [barePath], processes, [
    "--git-dir",
    barePath,
    "rev-parse",
    "--is-bare-repository",
  ]).pipe(
    Effect.map((result) => result.stdout.trim() === "true"),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const recordRemoteRepositoryUse = (
  filesystem: ManagedWorkspaceFilesystem,
  checkout: HostedReviewCheckoutSpec,
  cloned: boolean,
) =>
  mutateManifest(filesystem, (manifest) => {
    const now = new Date().toISOString()
    const repositoryKey = makeHostedRepositoryKey(checkout.repository)
    const existing = manifest.repositories.find((item) => item.repositoryKey === repositoryKey)
    const repository = {
      providerId: String(checkout.repository.providerId),
      repositoryKey,
      clonedAt: cloned || existing === undefined ? now : existing.clonedAt,
      lastUsedAt: now,
    }
    return {
      manifest: {
        ...manifest,
        repositories:
          existing === undefined
            ? [...manifest.repositories, repository]
            : manifest.repositories.map((item) =>
                item.repositoryKey === repositoryKey ? repository : item,
              ),
      },
      value: undefined,
    }
  })

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void
