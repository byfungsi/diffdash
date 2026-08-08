/* oxlint-disable eslint/no-underscore-dangle -- Effect errors use _tag discriminants. */
import type { Repo } from "@diffdash/domain/repository"
import type {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
  ReviewSnapshot,
} from "@diffdash/domain/review-context"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import {
  prepareWalkthroughPromptInput,
  type StoredWalkthrough,
  type WalkthroughCacheKey,
  WALKTHROUGH_PROMPT_VERSION,
  walkthroughHostedReviewScope,
  walkthroughLocalDiffScope,
  walkthroughRepositoryComparisonScope,
} from "@diffdash/domain/walkthrough"
import {
  WalkthroughArtifactReference,
  WalkthroughExpectedFailure,
  WalkthroughOperationFailureCode,
  WalkthroughOperationId,
  WalkthroughOperationIdentity,
  type WalkthroughOperation,
  type WalkthroughExpectedFailureCategory,
  type WalkthroughOperationIdentity as WalkthroughOperationIdentityType,
} from "@diffdash/domain/walkthrough-operation"
import {
  WalkthroughOperationStore,
  WalkthroughOperationStoreError,
} from "@diffdash/persistence/walkthrough-operation-store"
import {
  WalkthroughStore,
  type WalkthroughStoreError,
} from "@diffdash/persistence/walkthrough-store"
import { WalkthroughService } from "@diffdash/walkthrough"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Match,
  Option,
  Result,
  Semaphore,
  type Scope,
} from "effect"
import { randomUUID } from "node:crypto"

import {
  type CoreGetStoredWalkthroughFailure,
  type CoreWalkthroughFailure,
  type CoreWalkthroughOperationFailure,
  type CoreWalkthroughStartFailure,
  type GetStoredWalkthrough,
  type StartWalkthroughOperation,
  type WalkthroughOperationAccepted,
  WalkthroughOperationArtifactUnavailable,
  WalkthroughOperationCancelled,
  WalkthroughOperationCompleted,
  WalkthroughOperationDefect,
  WalkthroughOperationFailed,
  type WalkthroughOperationId as WalkthroughOperationIdType,
  WalkthroughOperationInterrupted,
  WalkthroughOperationNotFound,
  type WalkthroughOperationResult,
  WalkthroughOperationStateUnavailable,
  WalkthroughOperationSuperseded,
  WalkthroughOperationTerminalFailure,
} from "../core-contract"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import type { ReviewResolution } from "./review-resolution"

type HostedReviewTarget = Extract<ReviewThreadTarget, { readonly kind: "hosted" }>
type LocalReviewTarget = Extract<ReviewThreadTarget, { readonly kind: "local" }>
type RepositoryComparisonTarget = Extract<
  ReviewThreadTarget,
  { readonly kind: "repositoryComparison" }
>

interface ResolvedWalkthroughBase<Snapshot extends ReviewSnapshot> {
  readonly regenerate: boolean
  readonly repo: Repo
  readonly snapshot: Snapshot
  readonly prNumber: number | null
}

interface ResolvedHostedWalkthrough extends ResolvedWalkthroughBase<HostedReviewSnapshot> {
  readonly kind: "hosted"
  readonly target: HostedReviewTarget
}

interface ResolvedLocalWalkthrough extends ResolvedWalkthroughBase<LocalReviewSnapshot> {
  readonly kind: "local"
  readonly target: LocalReviewTarget
}

interface ResolvedRepositoryComparisonWalkthrough
  extends ResolvedWalkthroughBase<RepositoryComparisonSnapshot> {
  readonly kind: "repositoryComparison"
  readonly target: RepositoryComparisonTarget
}

type ResolvedWalkthrough =
  | ResolvedHostedWalkthrough
  | ResolvedLocalWalkthrough
  | ResolvedRepositoryComparisonWalkthrough

type WalkthroughWorkerObservation =
  | { readonly _tag: "none" }
  | { readonly _tag: "expected"; readonly failure: CoreWalkthroughFailure }
  | { readonly _tag: "defect"; readonly defect: unknown }

/** Scoped admission, observation, and cancellation for durable walkthrough operations. */
export interface WalkthroughLifecycle {
  readonly start: (
    request: StartWalkthroughOperation,
  ) => Effect.Effect<WalkthroughOperationAccepted, CoreWalkthroughStartFailure>
  readonly getOperation: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<WalkthroughOperationResult, CoreWalkthroughOperationFailure>
  readonly cancel: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<WalkthroughOperationResult, CoreWalkthroughOperationFailure>
}

/** Scoped walkthrough capability including generation and persistent cache access. */
export interface WalkthroughOperations extends WalkthroughLifecycle {
  readonly getStored: (
    request: GetStoredWalkthrough,
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, CoreGetStoredWalkthroughFailure>
  readonly getCached: (
    repoId: string,
    snapshot: ReviewSnapshot,
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, WalkthroughStoreError>
}

/** Acquires the complete scoped walkthrough capability. */
export const makeWalkthroughOperations = (
  reviews: ReviewResolution,
): Effect.Effect<
  WalkthroughOperations,
  never,
  | RepositoryComparisonSource
  | Scope.Scope
  | WalkthroughOperationStore
  | WalkthroughService
  | WalkthroughStore
> =>
  Effect.gen(function* () {
    const comparisons = yield* RepositoryComparisonSource
    const walkthroughService = yield* WalkthroughService
    const operationStore = yield* WalkthroughOperationStore
    const walkthroughStore = yield* WalkthroughStore
    const activeFibers = yield* FiberMap.make<
      WalkthroughOperationIdType,
      WalkthroughWorkerObservation,
      WalkthroughOperationStoreError
    >()
    const startSemaphore = yield* Semaphore.make(1)

    const getCached: WalkthroughOperations["getCached"] = Effect.fn("Core.Walkthroughs.getCached")(
      (repoId, snapshot) => walkthroughStore.get(walkthroughCacheKey(repoId, snapshot)),
    )

    const getStoredWalkthrough: WalkthroughOperations["getStored"] = Effect.fn(
      "Core.Walkthroughs.getStored",
    )(function* (request) {
      const { repo, snapshot } = yield* reviews.resolve(request.target)
      if (
        (request.expectedBaseRevision !== null &&
          snapshot.baseRevision !== request.expectedBaseRevision) ||
        (request.expectedHeadRevision !== null &&
          snapshot.headRevision !== request.expectedHeadRevision)
      ) {
        return Option.none()
      }
      return yield* getCached(repo.id, snapshot)
    })

    const resolveWalkthrough = Effect.fn("Core.Walkthroughs.resolve")(function (
      request: StartWalkthroughOperation,
    ): Effect.Effect<ResolvedWalkthrough, CoreWalkthroughStartFailure> {
      return Match.value(request.target).pipe(
        Match.when({ kind: "hosted" }, (target) =>
          reviews.resolveHosted(target).pipe(
            Effect.map((resolved) => ({
              kind: "hosted" as const,
              target,
              regenerate: request.regenerate,
              ...resolved,
            })),
          ),
        ),
        Match.when({ kind: "repositoryComparison" }, (target) =>
          reviews.resolveRepositoryComparison(target).pipe(
            Effect.map((resolved) => ({
              kind: "repositoryComparison" as const,
              target,
              regenerate: request.regenerate,
              ...resolved,
            })),
          ),
        ),
        Match.when({ kind: "local" }, (target) =>
          reviews.resolveLocal(target).pipe(
            Effect.map((resolved) => ({
              kind: "local" as const,
              target,
              regenerate: request.regenerate,
              ...resolved,
            })),
          ),
        ),
        Match.exhaustive,
      )
    })

    const loadOrGenerate = Effect.fn("Core.Walkthroughs.loadOrGenerate")(function* (
      resolved: ResolvedWalkthrough,
      generate: Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure>,
    ) {
      const cacheKey = walkthroughCacheKey(resolved.repo.id, resolved.snapshot)
      if (resolved.regenerate) return yield* generate
      const cached = yield* walkthroughStore.get(cacheKey)
      return yield* Option.match(cached, {
        onNone: () => generate,
        onSome: (walkthrough) => ensureExactWalkthrough(walkthroughStore, cacheKey, walkthrough),
      })
    })

    const generateResolved = Effect.fn("Core.Walkthroughs.generateResolved")(function (
      resolved: ResolvedWalkthrough,
    ): Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure> {
      return Match.value(resolved).pipe(
        Match.when({ kind: "hosted" }, (current) =>
          loadOrGenerate(
            current,
            Effect.gen(function* () {
              const cacheKey = walkthroughCacheKey(current.repo.id, current.snapshot)
              const promptInput = yield* prepareWalkthroughPromptInput(
                current.snapshot.parsedDiff.files,
                walkthroughHostedReviewScope(current.target.review),
              )
              const walkthrough = yield* walkthroughService.generate({
                review: { kind: "hosted", hostedReview: current.snapshot.detail },
                diff: promptInput.diff,
                hunkDigest: promptInput.hunkDigest,
                changedFileTree: promptInput.changedFileTree,
                generation: promptInput.generation,
                promptStats: promptInput.stats,
              })
              return yield* walkthroughStore.save({
                ...cacheKey,
                prNumber: current.prNumber,
                walkthrough,
              })
            }),
          ),
        ),
        Match.when({ kind: "repositoryComparison" }, (current) =>
          loadOrGenerate(
            current,
            Effect.gen(function* () {
              const cacheKey = walkthroughCacheKey(current.repo.id, current.snapshot)
              const promptInput = yield* prepareWalkthroughPromptInput(
                current.snapshot.parsedDiff.files,
                walkthroughRepositoryComparisonScope(current.snapshot.reviewKey),
              )
              const walkthrough = yield* comparisons.useWorkspace(
                current.target,
                (workingDirectory) =>
                  walkthroughService.generate({
                    review: {
                      kind: "repositoryComparison",
                      comparison: current.snapshot.detail,
                    },
                    diff: promptInput.diff,
                    hunkDigest: promptInput.hunkDigest,
                    changedFileTree: promptInput.changedFileTree,
                    generation: promptInput.generation,
                    promptStats: promptInput.stats,
                    workingDirectory,
                  }),
              )
              return yield* walkthroughStore.save({
                ...cacheKey,
                prNumber: null,
                walkthrough,
              })
            }),
          ),
        ),
        Match.when({ kind: "local" }, (current) =>
          loadOrGenerate(
            current,
            Effect.gen(function* () {
              const cacheKey = walkthroughCacheKey(current.repo.id, current.snapshot)
              const promptInput = yield* prepareWalkthroughPromptInput(
                current.snapshot.parsedDiff.files,
                walkthroughLocalDiffScope(current.snapshot.headRevision),
              )
              const walkthrough = yield* walkthroughService.generate({
                review: { kind: "localDiff", localReview: current.snapshot.detail },
                diff: promptInput.diff,
                hunkDigest: promptInput.hunkDigest,
                changedFileTree: promptInput.changedFileTree,
                generation: promptInput.generation,
                promptStats: promptInput.stats,
              })
              return yield* walkthroughStore.save({
                ...cacheKey,
                prNumber: null,
                walkthrough,
              })
            }),
          ),
        ),
        Match.exhaustive,
      )
    })

    const runOperation = Effect.fn("Core.Walkthroughs.runOperation")(
      function* (operation: WalkthroughOperation, resolved: ResolvedWalkthrough) {
        const running = yield* operationStore.markRunning({
          operationId: operation.id,
          expectedStateVersion: operation.stateVersion,
        })
        if (!running.won || running.operation.state !== "running") {
          return { _tag: "none" } as const
        }

        const exit = yield* Effect.exit(generateResolved(resolved))
        yield* persistTerminalExit(operationStore, running.operation, exit)
        return walkthroughObservationFromExit(exit)
      },
      (effect) =>
        effect.pipe(
          Effect.catchTag("WalkthroughOperationNotFoundError", (cause) =>
            Effect.fail(
              WalkthroughOperationStoreError.make({
                operation: "worker.transition",
                message: "Walkthrough operation disappeared during a lifecycle transition.",
                cause,
              }),
            ),
          ),
        ),
    )

    const start: WalkthroughLifecycle["start"] = Effect.fn("Core.Walkthroughs.start")(
      function* (request) {
        const resolved = yield* resolveWalkthrough(request)
        return yield* startSemaphore.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const acceptance = yield* operationStore.acceptOrGet({
                operationId: WalkthroughOperationId.make(randomUUID()),
                identity: operationIdentity(resolved.repo.id, resolved.snapshot),
                regenerate: request.regenerate,
              })
              if (acceptance.created) {
                if (acceptance.operation.regenerationOfOperationId !== null) {
                  yield* FiberMap.remove(
                    activeFibers,
                    acceptance.operation.regenerationOfOperationId,
                  )
                }
                yield* FiberMap.run(
                  activeFibers,
                  acceptance.operation.id,
                  runOperation(acceptance.operation, resolved),
                  { onlyIfMissing: true },
                )
              }
              return { operationId: acceptance.operation.id }
            }),
          ),
        )
      },
    )

    const materializeOperation: (
      operation: WalkthroughOperation,
    ) => Effect.Effect<WalkthroughOperationResult, CoreWalkthroughOperationFailure> = Effect.fn(
      "Core.Walkthroughs.materializeOperation",
    )(function* (operation) {
      switch (operation.state) {
        case "completed": {
          const walkthrough = yield* walkthroughStore.get(artifactCacheKey(operation.artifact))
          return yield* Option.match(walkthrough, {
            onNone: () =>
              Effect.fail(
                WalkthroughOperationArtifactUnavailable.make({ operationId: operation.id }),
              ),
            onSome: (stored) =>
              exactArtifactMatches(stored, operation.artifact)
                ? Effect.succeed(WalkthroughOperationCompleted.make({ walkthrough: stored }))
                : Effect.fail(
                    WalkthroughOperationArtifactUnavailable.make({ operationId: operation.id }),
                  ),
          })
        }
        case "failed":
          return WalkthroughOperationFailed.make({
            error: WalkthroughOperationTerminalFailure.make({
              operationId: operation.id,
              failure: operation.failure,
            }),
          })
        case "cancelled":
          return WalkthroughOperationCancelled.make({})
        case "superseded":
          return WalkthroughOperationSuperseded.make({
            supersededByOperationId: operation.supersededByOperationId,
          })
        case "interrupted":
          return WalkthroughOperationInterrupted.make({})
        case "accepted":
        case "running":
          return yield* WalkthroughOperationStateUnavailable.make({ operationId: operation.id })
      }
    })

    const getOperation: WalkthroughLifecycle["getOperation"] = Effect.fn(
      "Core.Walkthroughs.getOperation",
    )(function* (operationId) {
      const operation = yield* requireOperation(operationStore, operationId)
      const active = isActiveOperation(operation)
        ? yield* FiberMap.get(activeFibers, operation.id)
        : Option.none<Fiber.Fiber<WalkthroughWorkerObservation, WalkthroughOperationStoreError>>()
      const workerExit = Option.isSome(active)
        ? Option.some(yield* Fiber.await(active.value))
        : Option.none<Exit.Exit<WalkthroughWorkerObservation, WalkthroughOperationStoreError>>()
      const authoritative = yield* requireOperation(operationStore, operation.id)
      if (
        isActiveOperation(authoritative) &&
        Option.isSome(workerExit) &&
        Exit.isFailure(workerExit.value)
      ) {
        const failure = Cause.findErrorOption(workerExit.value.cause)
        if (Option.isSome(failure)) return yield* failure.value
        const defect = Cause.findDefect(workerExit.value.cause)
        if (Result.isSuccess(defect)) return yield* Effect.die(defect.success)
      }
      if (
        authoritative.state === "failed" &&
        Option.isSome(workerExit) &&
        Exit.isSuccess(workerExit.value) &&
        workerExit.value.value._tag !== "none"
      ) {
        return workerExit.value.value._tag === "expected"
          ? WalkthroughOperationFailed.make({ error: workerExit.value.value.failure })
          : WalkthroughOperationDefect.make({ defect: workerExit.value.value.defect })
      }
      return yield* materializeOperation(authoritative)
    })

    const cancel: WalkthroughLifecycle["cancel"] = Effect.fn("Core.Walkthroughs.cancel")(
      function* (operationId) {
        let operation = yield* requireOperation(operationStore, operationId)
        while (isActiveOperation(operation)) {
          const transition = yield* operationStore
            .requestCancellation({
              operationId,
              expectedStateVersion: operation.stateVersion,
            })
            .pipe(
              Effect.catchTag("WalkthroughOperationNotFoundError", () =>
                WalkthroughOperationNotFound.make({ operationId }),
              ),
            )
          operation = transition.operation
          if (transition.won) {
            yield* FiberMap.remove(activeFibers, operationId)
            break
          }
        }
        return yield* materializeOperation(operation)
      },
    )

    return { start, getOperation, cancel, getStored: getStoredWalkthrough, getCached }
  })

const persistTerminalExit = (
  store: WalkthroughOperationStore["Service"],
  running: Extract<WalkthroughOperation, { readonly state: "running" }>,
  exit: Exit.Exit<StoredWalkthrough, CoreWalkthroughFailure>,
) =>
  Exit.match(exit, {
    onSuccess: () =>
      store
        .completeSuccess({
          operationId: running.id,
          expectedStateVersion: running.stateVersion,
          artifact: WalkthroughArtifactReference.make(running.identity),
        })
        .pipe(Effect.asVoid),
    onFailure: (cause) => {
      const defect = Cause.findDefect(cause)
      if (Result.isSuccess(defect)) {
        return store
          .persistInternalFailure({
            operationId: running.id,
            expectedStateVersion: running.stateVersion,
          })
          .pipe(Effect.asVoid)
      }
      const failure = Cause.findErrorOption(cause)
      if (Option.isSome(failure)) {
        return store
          .persistExpectedFailure({
            operationId: running.id,
            expectedStateVersion: running.stateVersion,
            failure: classifyExpectedFailure(failure.value),
          })
          .pipe(Effect.asVoid)
      }
      return Cause.hasInterrupts(cause)
        ? Effect.void
        : store
            .persistInternalFailure({
              operationId: running.id,
              expectedStateVersion: running.stateVersion,
            })
            .pipe(Effect.asVoid)
    },
  })

const walkthroughObservationFromExit = (
  exit: Exit.Exit<StoredWalkthrough, CoreWalkthroughFailure>,
): WalkthroughWorkerObservation =>
  Exit.match(exit, {
    onSuccess: () => ({ _tag: "none" }),
    onFailure: (cause) => {
      const defect = Cause.findDefect(cause)
      if (Result.isSuccess(defect)) return { _tag: "defect", defect: defect.success }
      const failure = Cause.findErrorOption(cause)
      return Option.isSome(failure)
        ? { _tag: "expected", failure: failure.value }
        : { _tag: "none" }
    },
  })

const classifyExpectedFailure = (failure: CoreWalkthroughFailure) =>
  WalkthroughExpectedFailure.make({
    kind: "expected",
    category: expectedFailureCategory(failure),
    code: WalkthroughOperationFailureCode.make(expectedFailureCode(failure)),
  })

const expectedFailureCategory = (
  failure: CoreWalkthroughFailure,
): WalkthroughExpectedFailureCategory => {
  switch (failure._tag) {
    case "ReviewContextError":
    case "RepositoryLinkError":
    case "RepositoryComparisonSourceError":
      return "review-resolution"
    case "WalkthroughPromptPreparationError":
      return "prompt-preparation"
    case "WalkthroughStoreError":
      return "artifact-persistence"
    case "WalkthroughGenerationError":
    case "WalkthroughValidationError":
    case "InvalidAgentProviderResponseError":
      return "validation"
    default:
      return "provider"
  }
}

const expectedFailureCode = (failure: CoreWalkthroughFailure) =>
  failure._tag
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase()

const requireOperation: (
  store: WalkthroughOperationStore["Service"],
  operationId: WalkthroughOperationIdType,
) => Effect.Effect<
  WalkthroughOperation,
  WalkthroughOperationNotFound | WalkthroughOperationStoreError
> = Effect.fn("Core.Walkthroughs.requireOperation")(function* (store, operationId) {
  const operation = yield* store.get(operationId)
  return yield* Option.match(operation, {
    onNone: () => Effect.fail(WalkthroughOperationNotFound.make({ operationId })),
    onSome: Effect.succeed,
  })
})

const ensureExactWalkthrough = (
  store: WalkthroughStore["Service"],
  key: WalkthroughCacheKey,
  walkthrough: StoredWalkthrough,
) =>
  exactCacheKeyMatches(walkthrough, key)
    ? Effect.succeed(walkthrough)
    : store.save({ ...key, prNumber: walkthrough.prNumber, walkthrough: walkthrough.walkthrough })

const exactCacheKeyMatches = (walkthrough: StoredWalkthrough, key: WalkthroughCacheKey) =>
  walkthrough.repoId === key.repoId &&
  walkthrough.reviewKey === key.reviewKey &&
  walkthrough.baseSha === key.baseSha &&
  walkthrough.headSha === key.headSha &&
  walkthrough.promptVersion === key.promptVersion

const exactArtifactMatches = (
  walkthrough: StoredWalkthrough,
  artifact: WalkthroughArtifactReference,
) =>
  walkthrough.repoId === artifact.repoId &&
  walkthrough.reviewKey === artifact.reviewKey &&
  walkthrough.baseSha === artifact.baseRevision &&
  walkthrough.headSha === artifact.headRevision &&
  walkthrough.promptVersion === artifact.promptVersion

const isActiveOperation = (
  operation: WalkthroughOperation,
): operation is Extract<WalkthroughOperation, { readonly state: "accepted" | "running" }> =>
  operation.state === "accepted" || operation.state === "running"

const operationIdentity = (
  repoId: string,
  snapshot: ReviewSnapshot,
): WalkthroughOperationIdentityType =>
  WalkthroughOperationIdentity.make({
    repoId,
    reviewKey: snapshot.reviewKey,
    baseRevision: snapshot.baseRevision,
    headRevision: snapshot.headRevision,
    promptVersion: WALKTHROUGH_PROMPT_VERSION,
  })

const artifactCacheKey = (artifact: WalkthroughArtifactReference): WalkthroughCacheKey => ({
  repoId: artifact.repoId,
  reviewKey: artifact.reviewKey,
  baseSha: artifact.baseRevision,
  headSha: artifact.headRevision,
  promptVersion: artifact.promptVersion,
})

const walkthroughCacheKey = (repoId: string, snapshot: ReviewSnapshot): WalkthroughCacheKey => ({
  repoId,
  reviewKey: snapshot.reviewKey,
  baseSha: snapshot.baseRevision,
  headSha: snapshot.headRevision,
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
})
