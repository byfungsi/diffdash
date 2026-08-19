import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Fiber, Layer, Match, Option, Result, Schema, Stream } from "effect"

import {
  makeHostedRepositoryKey,
  type HostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import { VERY_LARGE_DIFF_CHARACTER_THRESHOLD } from "@diffdash/domain/large-diff-policy"
import { GitCommitSha, type RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryCheckoutPath, type RepositoryLocalPath } from "@diffdash/domain/repository"
import type { AgentRunId, ReviewAgentProgressStage } from "@diffdash/domain/review-agent"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { ReviewThreadId } from "@diffdash/domain/review-thread"
import type { HostedReviewCheckoutSpec } from "@diffdash/git-provider"
import {
  ProcessExitError,
  ProcessService,
  type ProcessResult,
  type ProcessRunner,
} from "@diffdash/process"
import { gitProcessRequest } from "./git-environment"
import { isProcessAlive, withFileLock } from "./hosted-review-workspace-file-lock"
import { completeWithFinalizer } from "./hosted-review-workspace-finalizer"
import {
  type Manifest,
  type Slot,
  mutateManifest,
  updateManifest,
  updateSlot,
} from "./hosted-review-workspace-manifest"
import {
  HostedReviewWorkspacePoolError,
  poolError,
  toError,
} from "./hosted-review-workspace-pool-error"
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
  readonly sourcePath: RepositoryLocalPath
  readonly bootstrapBareRepository: (
    destination: RepositoryCheckoutPath,
  ) => Effect.Effect<void, Error, never>
}

/** One exclusively leased, detached review worktree. */
export interface HostedReviewWorkspaceLease {
  readonly localPath: RepositoryCheckoutPath
  readonly headSha: GitCommitSha
  readonly slotId: string
}

interface PreparedHostedReviewWorkspaceLease extends HostedReviewWorkspaceLease {
  readonly reviewRef: CreatedReviewRef
}

/** Input required to pin one immutable repository comparison. */
export interface HostedRepositoryComparisonInput {
  readonly repository: HostedRepositoryLocator
  readonly sourcePath: RepositoryLocalPath
  readonly remoteUrl: string
  readonly baseRef: RepositoryComparisonRef
  readonly headRef: RepositoryComparisonRef
  readonly bootstrapBareRepository: (
    destination: RepositoryCheckoutPath,
  ) => Effect.Effect<void, Error, never>
}

/** Immutable Git coordinates resolved for one repository comparison. */
export interface PinnedRepositoryComparison {
  readonly baseSha: GitCommitSha
  readonly headSha: GitCommitSha
  readonly mergeBaseSha: GitCommitSha
}

/** One exact ref created and verified by the hosted-review producer. */
export interface CreatedReviewRef {
  readonly repositoryPath: string
  readonly ref: string
  readonly targetSha: GitCommitSha
}

/** Lifecycle authority installed by Core for producer-created review refs. */
export interface ReviewRefLifecycle {
  readonly manage: <A, E, R>(
    refs: readonly CreatedReviewRef[],
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | HostedReviewWorkspacePoolError, R>
}

const ReviewRefIdentity = Schema.Struct({
  version: Schema.Literal(1),
  repositoryPath: Schema.String,
  ref: Schema.String,
  targetSha: GitCommitSha,
})

/** Encodes an adapter-owned identity for one verified producer-created ref. */
export const encodeReviewRefIdentity = (resource: CreatedReviewRef): string =>
  JSON.stringify({ version: 1, ...resource })

/** Git mutation authority for cataloged hosted-review refs. */
export class ReviewRefMutation extends Context.Service<
  ReviewRefMutation,
  {
    readonly mutate: (
      operation: "quarantine" | "delete",
      identity: string,
    ) => Effect.Effect<void, HostedReviewWorkspacePoolError>
  }
>()("@diffdash/ReviewRefMutation") {
  /** Builds ref mutation constrained to the two configured managed pools. */
  static readonly layer = (config: {
    readonly worktreePoolPath: RepositoryCheckoutPath
    readonly remoteWorktreePoolPath: RepositoryCheckoutPath
  }) =>
    Layer.effect(
      ReviewRefMutation,
      Effect.gen(function* () {
        const processes = yield* ProcessService
        const filesystems = yield* Effect.all([
          makeManagedWorkspaceFilesystem(config.worktreePoolPath),
          makeManagedWorkspaceFilesystem(config.remoteWorktreePoolPath),
        ])
        return ReviewRefMutation.of({
          mutate: Effect.fn("ReviewRefMutation.mutate")(function* (operation, identity) {
            const decoded = yield* Schema.decodeUnknownEffect(ReviewRefIdentity)(
              yield* Effect.try({
                try: () => JSON.parse(identity),
                catch: (cause) =>
                  poolError(
                    "filesystem",
                    "reviewRef.identity",
                    "A cataloged review ref has an invalid identity.",
                    toError(cause),
                  ),
              }),
            ).pipe(
              Effect.mapError((cause) =>
                poolError(
                  "filesystem",
                  "reviewRef.identity",
                  "A cataloged review ref has an invalid identity.",
                  cause,
                ),
              ),
            )
            if (!isManagedReviewRef(decoded.ref)) {
              yield* poolError(
                "filesystem",
                "reviewRef.validate",
                "A cataloged review ref is outside DiffDash's managed namespaces.",
                new Error(`Ref is not managed: ${decoded.ref}`),
              )
            }
            const repository = yield* firstManagedRepository(filesystems, decoded.repositoryPath)
            if (operation === "quarantine") {
              const current = yield* runManagedGit(
                repository.filesystem,
                [repository.path],
                processes,
                ["--git-dir", repository.path, "show-ref", "--verify", "--hash", decoded.ref],
              ).pipe(Effect.result)
              if (Result.isFailure(current)) {
                if (
                  !Schema.is(ProcessExitError)(current.failure.cause) ||
                  current.failure.cause.exitCode !== 1
                ) {
                  yield* current.failure
                }
              } else if (current.success.stdout.trim() !== decoded.targetSha) {
                yield* poolError(
                  "git",
                  "reviewRef.quarantine",
                  "A cataloged review ref changed after DiffDash created it.",
                  new Error(`Ref target changed: ${decoded.ref}`),
                )
              }
            } else {
              yield* runManagedGit(repository.filesystem, [repository.path], processes, [
                "--git-dir",
                repository.path,
                "update-ref",
                "-d",
                decoded.ref,
                decoded.targetSha,
              ])
            }
          }),
        })
      }),
    )
}

/** Input required to read or materialize an already pinned comparison. */
export interface PinnedRepositoryComparisonInput {
  readonly repository: HostedRepositoryLocator
  readonly sourcePath: RepositoryLocalPath
  readonly remoteUrl: string | null
  readonly baseSha: GitCommitSha
  readonly headSha: GitCommitSha
  readonly mergeBaseSha: GitCommitSha
  readonly bootstrapBareRepository: (
    destination: RepositoryCheckoutPath,
  ) => Effect.Effect<void, Error, never>
}

export { HostedReviewWorkspacePoolError } from "./hosted-review-workspace-pool-error"

/** Executes hosted-review agent work inside an exclusively leased managed worktree. */
export class HostedReviewWorkspacePool extends Context.Service<
  HostedReviewWorkspacePool,
  {
    readonly use: <A, E, R>(
      input: HostedReviewWorkspaceInput,
      run: (lease: HostedReviewWorkspaceLease) => Effect.Effect<A, E, R>,
      onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<A, E | HostedReviewWorkspacePoolError, R>
    readonly pinComparison: (
      input: HostedRepositoryComparisonInput,
    ) => Effect.Effect<PinnedRepositoryComparison, HostedReviewWorkspacePoolError>
    readonly readComparisonDiff: (
      input: PinnedRepositoryComparisonInput,
    ) => Effect.Effect<string, HostedReviewWorkspacePoolError>
    readonly useComparison: <A, E>(
      input: PinnedRepositoryComparisonInput,
      run: (localPath: RepositoryCheckoutPath) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | HostedReviewWorkspacePoolError>
  }
>()("@diffdash/HostedReviewWorkspacePool") {
  static readonly layer = (config: {
    readonly worktreePoolPath: RepositoryCheckoutPath
    readonly remoteWorktreePoolPath: RepositoryCheckoutPath
    readonly reviewRefs?: ReviewRefLifecycle
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
                reserveAndPrepare(
                  filesystem,
                  instanceId,
                  processes,
                  input,
                  config.reviewRefs,
                  onProgress,
                ),
              )
              return yield* completeWithFinalizer(
                manageReviewRefs(config.reviewRefs, [lease.reviewRef], restore(run(lease))),
                completeWithFinalizer(
                  restoreAndRelease(filesystem, processes, input, lease),
                  restore(reportProgress(onProgress, "restoring-workspace")),
                ),
              )
            }),
          )
        }

        const pinComparison = (input: HostedRepositoryComparisonInput) => {
          const filesystem = input.sourcePath === null ? remoteFilesystem : localFilesystem
          const repositoryRoot = pathForRepository(
            filesystem,
            makeHostedRepositoryKey(input.repository),
          )

          return withFileLock(
            filesystem,
            filesystem.child(repositoryRoot, "repository.lock"),
            () =>
              Effect.gen(function* () {
                const barePath = yield* prepareBareRepository(filesystem, processes, input)
                const first = yield* fetchAndResolveComparison(
                  filesystem,
                  processes,
                  barePath,
                  input,
                )
                const second = yield* fetchAndResolveComparison(
                  filesystem,
                  processes,
                  barePath,
                  input,
                ).pipe(
                  Effect.mapError((cause) =>
                    isComparisonResolutionError(cause) ? comparisonChanged(cause) : cause,
                  ),
                )
                if (
                  first.baseSha !== second.baseSha ||
                  first.headSha !== second.headSha ||
                  first.mergeBaseSha !== second.mergeBaseSha
                ) {
                  return yield* poolError(
                    "revision-changed",
                    "comparison.verify",
                    "The repository comparison changed while its revisions were being resolved. Retry the comparison.",
                    new Error("Repository comparison revisions changed during acquisition"),
                  )
                }
                const refs = yield* retainComparisonCommits(
                  filesystem,
                  processes,
                  barePath,
                  second,
                  config.reviewRefs,
                )
                if (input.sourcePath === null) {
                  yield* recordRemoteRepositoryUse(filesystem, input.repository, false)
                }
                return yield* manageReviewRefs(config.reviewRefs, refs, Effect.succeed(second))
              }),
            REPOSITORY_LOCK_TIMEOUT_MS,
          )
        }

        const readComparisonDiff = (input: PinnedRepositoryComparisonInput) => {
          const filesystem = input.sourcePath === null ? remoteFilesystem : localFilesystem
          const repositoryRoot = pathForRepository(
            filesystem,
            makeHostedRepositoryKey(input.repository),
          )
          return withFileLock(
            filesystem,
            filesystem.child(repositoryRoot, "repository.lock"),
            () =>
              Effect.gen(function* () {
                const barePath = yield* prepareBareRepository(filesystem, processes, input)
                yield* verifyPinnedComparison(filesystem, processes, barePath, input)
                const refs = yield* retainComparisonCommits(
                  filesystem,
                  processes,
                  barePath,
                  input,
                  config.reviewRefs,
                )
                yield* filesystem.validate(barePath, "comparison.diff.path")
                return yield* manageReviewRefs(
                  config.reviewRefs,
                  refs,
                  processes
                    .run(
                      gitProcessRequest(
                        [
                          "--git-dir",
                          barePath,
                          "diff",
                          "--no-ext-diff",
                          input.mergeBaseSha,
                          input.headSha,
                          "--",
                        ],
                        {
                          timeoutMs: GIT_TIMEOUT_MS,
                          stdout: {
                            maxBytes: VERY_LARGE_DIFF_CHARACTER_THRESHOLD * 4,
                            overflow: "error",
                          },
                        },
                      ),
                    )
                    .pipe(
                      Effect.map((result) => result.stdout),
                      Effect.mapError((cause) =>
                        poolError(
                          "git",
                          "comparison.diff",
                          "DiffDash could not read the pinned repository comparison.",
                          cause,
                        ),
                      ),
                    ),
                )
              }),
            REPOSITORY_LOCK_TIMEOUT_MS,
          )
        }

        const useComparison = <A, E>(
          input: PinnedRepositoryComparisonInput,
          run: (localPath: RepositoryCheckoutPath) => Effect.Effect<A, E>,
        ): Effect.Effect<A, E | HostedReviewWorkspacePoolError> => {
          const filesystem = input.sourcePath === null ? remoteFilesystem : localFilesystem
          const repositoryRoot = pathForRepository(
            filesystem,
            makeHostedRepositoryKey(input.repository),
          )
          const workspaceRoot = filesystem.child(repositoryRoot, "comparison-workspaces")
          const workspacePath = filesystem.child(workspaceRoot, randomUUID())

          return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const prepared = yield* withFileLock(
                filesystem,
                filesystem.child(repositoryRoot, "repository.lock"),
                () =>
                  Effect.gen(function* () {
                    const bare = yield* prepareBareRepository(filesystem, processes, input)
                    yield* verifyPinnedComparison(filesystem, processes, bare, input)
                    const refs = yield* retainComparisonCommits(
                      filesystem,
                      processes,
                      bare,
                      input,
                      config.reviewRefs,
                    )
                    yield* filesystem.ensureDirectory(workspaceRoot, "comparison.workspace.mkdir")
                    yield* recreateWorktree(
                      filesystem,
                      processes,
                      bare,
                      workspacePath,
                      input.headSha,
                    )
                    return { barePath: bare, refs }
                  }),
                REPOSITORY_LOCK_TIMEOUT_MS,
              )
              return yield* completeWithFinalizer(
                manageReviewRefs(
                  config.reviewRefs,
                  prepared.refs,
                  restore(run(RepositoryCheckoutPath.make(workspacePath))),
                ),
                withFileLock(
                  filesystem,
                  filesystem.child(repositoryRoot, "repository.lock"),
                  () => removeWorktree(filesystem, processes, prepared.barePath, workspacePath),
                  REPOSITORY_LOCK_TIMEOUT_MS,
                ),
              )
            }),
          )
        }

        return HostedReviewWorkspacePool.of({
          pinComparison,
          readComparisonDiff,
          use,
          useComparison,
        })
      }),
    )
}

interface Reservation {
  readonly slot: Slot
  readonly evicted: Slot | null
}

interface HostedRepositoryCacheInput {
  readonly repository: HostedRepositoryLocator
  readonly sourcePath: RepositoryLocalPath
  readonly remoteUrl: string | null
  readonly bootstrapBareRepository: (
    destination: RepositoryCheckoutPath,
  ) => Effect.Effect<void, Error, never>
}

const reserveAndPrepare = (
  filesystem: ManagedWorkspaceFilesystem,
  instanceId: string,
  processes: ProcessRunner,
  input: HostedReviewWorkspaceInput,
  reviewRefs: ReviewRefLifecycle | undefined,
  onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const reservation = yield* mutateManifest(filesystem, (manifest) =>
      reserveSlot(manifest, instanceId, input),
    )

    const prepared = prepareSlot(
      filesystem,
      processes,
      input,
      reservation,
      reviewRefs,
      onProgress,
    ).pipe(
      Effect.flatMap(({ headSha, reviewRef }) =>
        mutateManifest(filesystem, (manifest) => ({
          manifest: updateSlot(manifest, reservation.slot.id, (slot) => ({
            ...slot,
            state: "leased",
            headSha,
            reviewNumber: input.checkout.review.number,
            lastError: null,
          })),
          value: {
            localPath: RepositoryCheckoutPath.make(pathForSlot(filesystem, reservation.slot)),
            headSha,
            reviewRef,
            slotId: reservation.slot.id,
          } satisfies PreparedHostedReviewWorkspaceLease,
        })),
      ),
    )

    const quarantine = (reason: string) =>
      updateManifest(filesystem, (manifest) =>
        updateSlot(manifest, reservation.slot.id, (slot) => ({
          ...slot,
          state: "quarantined",
          lease: null,
          lastError: reason,
        })),
      )

    return yield* prepared.pipe(
      Effect.interruptible,
      Effect.onInterrupt(() =>
        quarantine("Review workspace preparation was interrupted.").pipe(Effect.ignore),
      ),
      Effect.catch((cause) => quarantine(cause.reason).pipe(Effect.andThen(Effect.fail(cause)))),
    )
  })

const prepareSlot = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  input: HostedReviewWorkspaceInput,
  reservation: Reservation,
  reviewRefs: ReviewRefLifecycle | undefined,
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
    Effect.andThen(
      withFileLock(
        filesystem,
        filesystem.child(repositoryRoot, "repository.lock"),
        () =>
          Effect.gen(function* () {
            const barePath = yield* prepareBareRepository(
              filesystem,
              processes,
              {
                repository: input.checkout.repository,
                sourcePath: input.sourcePath,
                remoteUrl: null,
                bootstrapBareRepository: input.bootstrapBareRepository,
              },
              onProgress,
            )

            const fetchedRef = `refs/diffdash/reviews/${input.checkout.review.number}/heads/${randomUUID()}`
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
            const fetchedSha = yield* parseCommitSha(fetched.stdout, "prepare.verifyRevision")
            if (String(fetchedSha) !== String(input.checkout.revision)) {
              return yield* poolError(
                "revision-changed",
                "prepare.verifyRevision",
                "The hosted review changed while its isolated workspace was being prepared. Refresh the review and retry.",
                new Error(`Expected ${input.checkout.revision}, fetched ${fetchedSha}`),
              )
            }
            const reviewRef = createdReviewRef(barePath, fetchedRef, fetchedSha)
            yield* manageReviewRefs(reviewRefs, [reviewRef], Effect.void)

            yield* reportProgress(onProgress, "checking-out-revision")
            yield* recreateWorktree(
              filesystem,
              processes,
              barePath,
              pathForSlot(filesystem, reservation.slot),
              fetchedSha,
            )
            if (input.sourcePath === null)
              yield* recordRemoteRepositoryUse(filesystem, input.checkout.repository, false)
            return { headSha: fetchedSha, reviewRef }
          }),
        REPOSITORY_LOCK_TIMEOUT_MS,
      ),
    ),
  )
}

const prepareBareRepository = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  input: HostedRepositoryCacheInput,
  onProgress?: (stage: ReviewAgentProgressStage) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const repositoryRoot = pathForRepository(filesystem, makeHostedRepositoryKey(input.repository))
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
          .bootstrapBareRepository(RepositoryCheckoutPath.make(barePath))
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
        yield* recordRemoteRepositoryUse(filesystem, input.repository, true)
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
      const remoteUrl =
        input.remoteUrl ??
        (yield* runGit(processes, ["-C", sourcePath, "remote", "get-url", "origin"])).stdout.trim()
      yield* runManagedGit(filesystem, [barePath], processes, [
        "--git-dir",
        barePath,
        "remote",
        "set-url",
        "origin",
        remoteUrl,
      ])
    }
    return barePath
  })

const COMPARISON_HEAD_PREFIX = "refs/diffdash/comparisons/heads/"
const COMPARISON_TAG_PREFIX = "refs/diffdash/comparisons/tags/"
const COMPARISON_COMMIT_PREFIX = "refs/diffdash/comparisons/commits/"
const isFullCommitSha = (revision: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)

const fetchAndResolveComparison = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  input: HostedRepositoryComparisonInput,
): Effect.Effect<PinnedRepositoryComparison, HostedReviewWorkspacePoolError> =>
  Effect.gen(function* () {
    const shallow = yield* runManagedGit(filesystem, [barePath], processes, [
      "--git-dir",
      barePath,
      "rev-parse",
      "--is-shallow-repository",
    ])
    yield* runManagedGit(filesystem, [barePath], processes, [
      "--git-dir",
      barePath,
      "fetch",
      "--no-tags",
      "--force",
      "--prune",
      ...(shallow.stdout.trim() === "true" ? ["--unshallow"] : []),
      "origin",
      `+refs/heads/*:${COMPARISON_HEAD_PREFIX}*`,
      `+refs/tags/*:${COMPARISON_TAG_PREFIX}*`,
    ])
    for (const [revision, side] of [
      [input.baseRef, "base"],
      [input.headRef, "head"],
    ] as const) {
      if (!isFullCommitSha(revision)) continue
      yield* runManagedGit(filesystem, [barePath], processes, [
        "--git-dir",
        barePath,
        "fetch",
        "--no-tags",
        "--force",
        "origin",
        `+${revision}:${COMPARISON_COMMIT_PREFIX}${side}`,
      ]).pipe(Effect.mapError((cause) => revisionNotFound(side, revision, cause)))
    }
    const baseSha = yield* resolveComparisonRevision(
      filesystem,
      processes,
      barePath,
      input.baseRef,
      "base",
    )
    const headSha = yield* resolveComparisonRevision(
      filesystem,
      processes,
      barePath,
      input.headRef,
      "head",
    )
    const mergeBase = yield* runManagedGit(filesystem, [barePath], processes, [
      "--git-dir",
      barePath,
      "merge-base",
      baseSha,
      headSha,
    ]).pipe(
      Effect.mapError((cause) =>
        poolError(
          "no-common-ancestor",
          "comparison.mergeBase",
          "The requested repository revisions do not share a common ancestor.",
          cause,
        ),
      ),
    )
    const mergeBaseSha = yield* parseCommitSha(mergeBase.stdout, "comparison.mergeBase")
    return { baseSha, headSha, mergeBaseSha }
  })

const resolveComparisonRevision = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  revision: RepositoryComparisonRef,
  side: "base" | "head",
): Effect.Effect<GitCommitSha, HostedReviewWorkspacePoolError> => {
  if (isFullCommitSha(revision)) {
    return resolveRequiredCommit(filesystem, processes, barePath, revision, side)
  }
  if (revision.startsWith("refs/heads/")) {
    return resolveRequiredCommit(
      filesystem,
      processes,
      barePath,
      `${COMPARISON_HEAD_PREFIX}${revision.slice("refs/heads/".length)}`,
      side,
    )
  }
  if (revision.startsWith("refs/tags/")) {
    return resolveRequiredCommit(
      filesystem,
      processes,
      barePath,
      `${COMPARISON_TAG_PREFIX}${revision.slice("refs/tags/".length)}`,
      side,
    )
  }
  if (revision.startsWith("refs/")) {
    return Effect.fail(revisionNotFound(side, revision))
  }

  return Effect.all([
    Effect.option(
      resolveCommit(filesystem, processes, barePath, `${COMPARISON_HEAD_PREFIX}${revision}`),
    ),
    Effect.option(
      resolveCommit(filesystem, processes, barePath, `${COMPARISON_TAG_PREFIX}${revision}`),
    ),
  ]).pipe(
    Effect.flatMap(([branch, tag]) => {
      if (Option.isSome(branch) && Option.isSome(tag)) {
        return Effect.fail(
          poolError(
            "revision-ambiguous",
            `comparison.resolve.${side}`,
            `The ${side} revision exists as both a branch and a tag. Use refs/heads/ or refs/tags/ explicitly.`,
            new Error(`Ambiguous ${side} revision: ${revision}`),
          ),
        )
      }
      if (Option.isSome(branch)) return Effect.succeed(branch.value)
      if (Option.isSome(tag)) return Effect.succeed(tag.value)
      return Effect.fail(revisionNotFound(side, revision))
    }),
  )
}

const resolveRequiredCommit = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  revision: string,
  side: "base" | "head",
) =>
  resolveCommit(filesystem, processes, barePath, revision).pipe(
    Effect.mapError((cause) => revisionNotFound(side, revision, cause)),
  )

const resolveCommit = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  revision: string,
) =>
  runManagedGit(filesystem, [barePath], processes, [
    "--git-dir",
    barePath,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]).pipe(Effect.flatMap((result) => parseCommitSha(result.stdout, "comparison.resolve")))

const parseCommitSha = (output: string, operation: string) =>
  Effect.try({
    try: () => GitCommitSha.make(output.trim()),
    catch: (cause) =>
      poolError(
        "git",
        operation,
        "Git returned an invalid commit object identity.",
        toError(cause),
      ),
  })

const revisionNotFound = (
  side: "base" | "head",
  revision: string,
  cause: Error = new Error(`Missing ${side} revision: ${revision}`),
) =>
  poolError(
    "revision-not-found",
    `comparison.resolve.${side}`,
    `The requested ${side} revision could not be resolved as a branch, tag, or full commit SHA.`,
    cause,
  )

const isComparisonResolutionError = (cause: HostedReviewWorkspacePoolError) =>
  cause.code === "revision-not-found" ||
  cause.code === "revision-ambiguous" ||
  cause.code === "no-common-ancestor"

const comparisonChanged = (cause: HostedReviewWorkspacePoolError) =>
  poolError(
    "revision-changed",
    "comparison.verify",
    "The repository comparison changed while its revisions were being resolved. Retry the comparison.",
    cause,
  )

const retainComparisonCommits = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  comparison: PinnedRepositoryComparison,
  reviewRefs: ReviewRefLifecycle | undefined,
) =>
  Effect.forEach(
    [comparison.baseSha, comparison.headSha, comparison.mergeBaseSha],
    (sha) => {
      const ref = `${COMPARISON_COMMIT_PREFIX}${sha}/${randomUUID()}`
      return runManagedGit(filesystem, [barePath], processes, [
        "--git-dir",
        barePath,
        "update-ref",
        ref,
        sha,
      ]).pipe(
        Effect.as(createdReviewRef(barePath, ref, sha)),
        Effect.tap((capture) => manageReviewRefs(reviewRefs, [capture], Effect.void)),
      )
    },
    { concurrency: 1 },
  )

const createdReviewRef = (
  repositoryPath: string,
  ref: string,
  targetSha: GitCommitSha,
): CreatedReviewRef => ({ repositoryPath, ref, targetSha })

const manageReviewRefs = <A, E, R>(
  lifecycle: ReviewRefLifecycle | undefined,
  refs: readonly CreatedReviewRef[],
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HostedReviewWorkspacePoolError, R> =>
  lifecycle === undefined ? use : lifecycle.manage(refs, use)

const isManagedReviewRef = (ref: string): boolean =>
  /^refs\/diffdash\/reviews\/[1-9][0-9]*\/heads\/[0-9a-f-]{36}$/u.test(ref) ||
  /^refs\/diffdash\/comparisons\/commits\/[0-9a-f]{40}(?:[0-9a-f]{24})?\/[0-9a-f-]{36}$/iu.test(ref)

const firstManagedRepository = (
  filesystems: readonly ManagedWorkspaceFilesystem[],
  repositoryPath: string,
) =>
  Effect.gen(function* () {
    for (const filesystem of filesystems) {
      const candidate = yield* filesystem
        .existingPath(repositoryPath, "reviewRef.repository")
        .pipe(Effect.option)
      if (Option.isSome(candidate)) return { filesystem, path: candidate.value }
    }
    return yield* poolError(
      "filesystem",
      "reviewRef.repository",
      "A cataloged review ref is outside the configured managed pools.",
      new Error(`Repository is not managed: ${repositoryPath}`),
    )
  })

const verifyPinnedComparison = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  comparison: PinnedRepositoryComparison,
) =>
  Effect.forEach(
    [comparison.baseSha, comparison.headSha, comparison.mergeBaseSha],
    (sha) => resolveCommit(filesystem, processes, barePath, sha),
    { discard: true },
  ).pipe(
    Effect.mapError((cause) =>
      poolError(
        "revision-not-found",
        "comparison.verifyPinned",
        "A pinned repository comparison revision is no longer available.",
        cause,
      ),
    ),
  )

const restoreAndRelease = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  input: HostedReviewWorkspaceInput,
  lease: HostedReviewWorkspaceLease,
) =>
  Effect.gen(function* () {
    yield* updateManifest(filesystem, (manifest) =>
      updateSlot(manifest, lease.slotId, (slot) => ({ ...slot, state: "cleaning" })),
    )
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
          updateManifest(filesystem, (manifest) =>
            updateSlot(manifest, lease.slotId, (slot) => ({
              ...slot,
              state: "quarantined",
              lease: null,
              lastError: cause.reason,
            })),
          ).pipe(Effect.andThen(Effect.fail(cause))),
        onSuccess: () =>
          updateManifest(filesystem, (manifest) =>
            updateSlot(manifest, lease.slotId, (slot) => ({
              ...slot,
              state: "available",
              lease: null,
              lastThreadId: String(input.threadId),
              lastUsedAt: new Date().toISOString(),
              lastError: null,
            })),
          ),
      }),
    )
  })

const recreateWorktree = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  worktreePath: ManagedWorkspacePath,
  headSha: GitCommitSha | ReviewRevision,
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
      ]).pipe(Effect.catch(() => Effect.void))
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

const removeWorktree = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  barePath: ManagedWorkspacePath,
  worktreePath: ManagedWorkspacePath,
) =>
  Effect.gen(function* () {
    if (yield* filesystem.exists(worktreePath, "comparison.workspace.exists")) {
      yield* runManagedGit(filesystem, [barePath, worktreePath], processes, [
        "--git-dir",
        barePath,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]).pipe(Effect.catch(() => Effect.void))
      yield* filesystem.remove(worktreePath, "comparison.workspace.remove")
    }
    yield* runManagedGit(filesystem, [barePath], processes, [
      "--git-dir",
      barePath,
      "worktree",
      "prune",
      "--expire",
      "now",
    ]).pipe(Effect.catch(() => Effect.void))
  })

const verifyWorktree = (
  filesystem: ManagedWorkspaceFilesystem,
  processes: ProcessRunner,
  worktreePath: ManagedWorkspacePath,
  headSha: GitCommitSha | ReviewRevision,
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
      ]).pipe(Effect.catch(() => Effect.void))
      yield* runManagedGit(filesystem, [barePath], processes, [
        "--git-dir",
        barePath,
        "worktree",
        "prune",
        "--expire",
        "now",
      ]).pipe(Effect.catch(() => Effect.void))
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
        .pipe(Stream.runLast, Effect.forkChild)
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
        onSome: (event) =>
          Match.value(event).pipe(
            Match.tag("ProcessExit", (exit) => Effect.succeed(exit.result)),
            Match.tag("ProcessLine", (line) =>
              Effect.fail(
                poolError(
                  "git",
                  "git.run",
                  "A Git command ended without an exit event.",
                  new Error(line.line),
                ),
              ),
            ),
            Match.exhaustive,
          ),
      })
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(HostedReviewWorkspacePoolError)(cause)
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
  }).pipe(Effect.andThen(runGit(processes, args)))

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
    Effect.catch(() => Effect.succeed(false)),
  )

const recordRemoteRepositoryUse = (
  filesystem: ManagedWorkspaceFilesystem,
  repositoryLocator: HostedRepositoryLocator,
  cloned: boolean,
) =>
  updateManifest(filesystem, (manifest) => {
    const now = new Date().toISOString()
    const repositoryKey = makeHostedRepositoryKey(repositoryLocator)
    const existing = manifest.repositories.find((item) => item.repositoryKey === repositoryKey)
    const repository = {
      providerId: String(repositoryLocator.providerId),
      repositoryKey,
      clonedAt: cloned || existing === undefined ? now : existing.clonedAt,
      lastUsedAt: now,
    }
    return {
      ...manifest,
      repositories:
        existing === undefined
          ? [...manifest.repositories, repository]
          : manifest.repositories.map((item) =>
              item.repositoryKey === repositoryKey ? repository : item,
            ),
    }
  })

const reportProgress = (
  reporter: ((stage: ReviewAgentProgressStage) => Effect.Effect<void>) | undefined,
  stage: ReviewAgentProgressStage,
) => reporter?.(stage) ?? Effect.void
