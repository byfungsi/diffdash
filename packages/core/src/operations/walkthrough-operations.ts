import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import {
  HostedReviewDescriptor,
  LocalReviewDescriptor,
  RepositoryComparisonReviewDescriptor,
  type ReviewDescriptor,
} from "@diffdash/domain/review-context"
import {
  ReviewFileId,
  ReviewHunkId,
  type ReviewKey,
  type ReviewProjectId as ReviewProjectIdType,
  type ReviewRevision,
  type ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  DEFAULT_WALKTHROUGH_PROMPT_BUDGET,
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
  type WalkthroughOperationAcceptance,
  WalkthroughOperationAcceptanceEvidence,
  WalkthroughOperationCandidatePlanFingerprint,
  WalkthroughOperationIdempotencyKey,
  WalkthroughExpectedFailure,
  WalkthroughOperationFailureCode,
  WalkthroughOperationId,
  WalkthroughOperationIdentity,
  type WalkthroughOperation,
  type WalkthroughOperationAcceptedRequest,
  type WalkthroughOperationReviewGeneration,
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
import {
  WALKTHROUGH_PROMPT_CONTEXT_LIMITS,
  WalkthroughGenerationInput,
  type WalkthroughPreparedRoute,
  WalkthroughReviewContext,
  WalkthroughService,
} from "@diffdash/agents/walkthrough"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Match,
  Option,
  Result,
  Schema,
  Semaphore,
  type Scope,
} from "effect"
import { createHash, randomUUID } from "node:crypto"

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
import { ReviewContextError } from "../services/git-provider"
import { captureCoreDefect } from "../core-defect-boundary"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import {
  OPERATION_SNAPSHOT_HUNK_LIMIT,
  OPERATION_SNAPSHOT_INVENTORY_LIMIT,
  OperationSnapshotReader,
  type OperationSnapshotHandle,
  type OperationSnapshotIdentity,
} from "../services/operation-snapshot-reader"
import {
  decodeSnapshotHunkLines,
  projectSnapshotFile,
  projectSnapshotHunk,
  reviewPromptFile,
  reviewPromptIdentity,
} from "../services/operation-snapshot-projection"
import type { ReviewResolution } from "./review-resolution"

interface ResolvedWalkthroughBase {
  readonly regenerate: boolean
  readonly repoId: ReviewProjectIdType
  readonly snapshotId: ReviewSnapshotId
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
  readonly prNumber: number | null
}

interface ResolvedHostedWalkthrough extends ResolvedWalkthroughBase {
  readonly kind: "hosted"
}

interface ResolvedLocalWalkthrough extends ResolvedWalkthroughBase {
  readonly kind: "local"
}

interface ResolvedRepositoryComparisonWalkthrough extends ResolvedWalkthroughBase {
  readonly kind: "repositoryComparison"
}

type ResolvedWalkthrough =
  | ResolvedHostedWalkthrough
  | ResolvedLocalWalkthrough
  | ResolvedRepositoryComparisonWalkthrough

type WalkthroughWorkerObservation = Option.Option<Cause.Cause<CoreWalkthroughFailure>>
type WalkthroughWorkerExit = Exit.Exit<WalkthroughWorkerObservation, WalkthroughOperationStoreError>

/** Active-only FiberMap lifecycle for walkthrough workers. */
export interface WalkthroughActiveWorkers {
  readonly run: (
    operationId: WalkthroughOperationIdType,
    worker: Effect.Effect<WalkthroughWorkerObservation, WalkthroughOperationStoreError>,
  ) => Effect.Effect<Fiber.Fiber<WalkthroughWorkerExit>>
  readonly get: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<Option.Option<Fiber.Fiber<WalkthroughWorkerExit>>>
  readonly cancel: (operationId: WalkthroughOperationIdType) => Effect.Effect<void>
  readonly size: Effect.Effect<number>
}

/** Creates scoped active-worker tracking without retaining terminal results. */
export const makeWalkthroughActiveWorkers: Effect.Effect<
  WalkthroughActiveWorkers,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<WalkthroughOperationIdType, WalkthroughWorkerExit, never>()

  return {
    run: Effect.fn("Core.Walkthroughs.ActiveWorkers.run")((operationId, worker) =>
      FiberMap.run(fibers, operationId, Effect.exit(worker), { onlyIfMissing: true }),
    ),
    get: Effect.fn("Core.Walkthroughs.ActiveWorkers.get")((operationId) =>
      FiberMap.get(fibers, operationId),
    ),
    cancel: Effect.fn("Core.Walkthroughs.ActiveWorkers.cancel")((operationId) =>
      FiberMap.remove(fibers, operationId),
    ),
    size: FiberMap.size(fibers),
  }
})

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
  readonly startGeneration: (
    request: StartWalkthroughGeneration,
  ) => Effect.Effect<WalkthroughOperationAcceptance, CoreWalkthroughStartFailure>
  readonly getSnapshot: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<WalkthroughOperation, CoreWalkthroughOperationFailure>
  readonly cancelSnapshot: (
    operationId: WalkthroughOperationIdType,
  ) => Effect.Effect<WalkthroughOperation, CoreWalkthroughOperationFailure>
  readonly getStoredGeneration: (
    generation: WalkthroughOperationReviewGeneration,
    promptVersion: string,
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, WalkthroughStoreError>
  readonly getStored: (
    request: GetStoredWalkthrough,
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, CoreGetStoredWalkthroughFailure>
  readonly getCached: (
    repoId: ReviewProjectIdType,
    snapshot: {
      readonly reviewKey: ReviewKey
      readonly baseRevision: ReviewRevision
      readonly headRevision: ReviewRevision
    },
  ) => Effect.Effect<Option.Option<StoredWalkthrough>, WalkthroughStoreError>
}

/** RPC-oriented immutable generation intent accepted without re-resolving a renderer target. */
export interface StartWalkthroughGeneration {
  readonly acceptedRequest: WalkthroughOperationAcceptedRequest
  readonly idempotencyKey: WalkthroughOperationIdempotencyKey
  readonly reviewGeneration: WalkthroughOperationReviewGeneration
  readonly regenerate: boolean
}

/** Acquires the complete scoped walkthrough capability. */
export const makeWalkthroughOperations = (
  reviews: ReviewResolution,
): Effect.Effect<
  WalkthroughOperations,
  never,
  | RepositoryComparisonSource
  | Scope.Scope
  | OperationSnapshotReader
  | WalkthroughOperationStore
  | WalkthroughService
  | WalkthroughStore
> =>
  Effect.gen(function* () {
    const comparisons = yield* RepositoryComparisonSource
    const walkthroughService = yield* WalkthroughService
    const operationStore = yield* WalkthroughOperationStore
    const walkthroughStore = yield* WalkthroughStore
    const snapshotReader = yield* OperationSnapshotReader
    const activeWorkers = yield* makeWalkthroughActiveWorkers
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

    const getStoredGeneration: WalkthroughOperations["getStoredGeneration"] = Effect.fn(
      "Core.Walkthroughs.getStoredGeneration",
    )((generation, promptVersion) =>
      walkthroughStore.get({
        repoId: generation.projectId,
        reviewKey: generation.reviewKey,
        baseSha: generation.baseRevision,
        headSha: generation.headRevision,
        promptVersion,
      }),
    )

    const resolveWalkthrough = Effect.fn("Core.Walkthroughs.resolve")(function (
      request: StartWalkthroughOperation,
    ): Effect.Effect<ResolvedWalkthrough, CoreWalkthroughStartFailure> {
      const target = request.target
      switch (target.kind) {
        case "hosted":
          return reviews.resolveHosted(target).pipe(
            Effect.map((resolved) => ({
              kind: "hosted" as const,
              target,
              regenerate: request.regenerate,
              repoId: resolved.repo.id,
              snapshotId: resolved.snapshot.snapshotId,
              reviewKey: resolved.snapshot.reviewKey,
              baseRevision: resolved.snapshot.baseRevision,
              headRevision: resolved.snapshot.headRevision,
              prNumber: resolved.prNumber,
            })),
          )
        case "repositoryComparison":
          return reviews.resolveRepositoryComparison(target).pipe(
            Effect.map((resolved) => ({
              kind: "repositoryComparison" as const,
              target,
              regenerate: request.regenerate,
              repoId: resolved.repo.id,
              snapshotId: resolved.snapshot.snapshotId,
              reviewKey: resolved.snapshot.reviewKey,
              baseRevision: resolved.snapshot.baseRevision,
              headRevision: resolved.snapshot.headRevision,
              prNumber: null,
            })),
          )
        case "local":
          return reviews.resolveLocal(target).pipe(
            Effect.map((resolved) => ({
              kind: "local" as const,
              target,
              regenerate: request.regenerate,
              repoId: resolved.repo.id,
              snapshotId: resolved.snapshot.snapshotId,
              reviewKey: resolved.snapshot.reviewKey,
              baseRevision: resolved.snapshot.baseRevision,
              headRevision: resolved.snapshot.headRevision,
              prNumber: null,
            })),
          )
      }
    })

    const loadOrGenerate = Effect.fn("Core.Walkthroughs.loadOrGenerate")(function* (
      resolved: ResolvedWalkthrough,
      generate: Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure>,
    ) {
      const cacheKey = walkthroughCacheKey(resolved.repoId, resolved)
      if (resolved.regenerate) return yield* generate
      const cached = yield* walkthroughStore.get(cacheKey)
      return yield* Option.match(cached, {
        onNone: () => generate,
        onSome: (walkthrough) => ensureExactWalkthrough(walkthroughStore, cacheKey, walkthrough),
      })
    })

    const generateResolved = Effect.fn("Core.Walkthroughs.generateResolved")(function* (
      resolved: ResolvedWalkthrough,
      route: WalkthroughPreparedRoute,
      identity: OperationSnapshotIdentity,
    ) {
      return yield* loadOrGenerate(
        resolved,
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* snapshotReader
              .open(identity)
              .pipe(Effect.mapError(snapshotReviewError))
            if (
              handle.snapshot.baseRevision !== resolved.baseRevision ||
              handle.snapshot.headRevision !== resolved.headRevision ||
              !descriptorMatchesKind(handle.snapshot.descriptor, resolved.kind)
            ) {
              return yield* snapshotReviewError(
                new Error(
                  "The durable snapshot does not match the accepted walkthrough generation",
                ),
              )
            }
            const bounded = yield* prepareBoundedWalkthrough(handle).pipe(
              Effect.mapError(snapshotReviewError),
            )
            const descriptor = handle.snapshot.descriptor
            const promptReview = reviewPromptIdentity(handle.snapshot)
            const scope = walkthroughScope(
              descriptor,
              promptReview.reviewKey,
              promptReview.headRevision,
            )
            const promptInput = yield* prepareWalkthroughPromptInput(bounded.files, scope)
            const input = (workingDirectory: Option.Option<string>) =>
              WalkthroughGenerationInput.make({
                review: WalkthroughReviewContext.make({
                  review: promptReview,
                  files: bounded.inventory,
                }),
                diff: promptInput.diff,
                hunkDigest: promptInput.hunkDigest,
                changedFileTree: promptInput.changedFileTree,
                generation: {
                  ...promptInput.generation,
                  totalFiles: bounded.totalFiles,
                },
                promptStats: Option.some({
                  ...promptInput.stats,
                  totalFiles: bounded.totalFiles,
                  totalHunks: bounded.totalHunks,
                  omittedFiles: Math.max(0, bounded.totalFiles - promptInput.stats.selectedFiles),
                  omittedHunks: Math.max(0, bounded.totalHunks - promptInput.stats.selectedHunks),
                }),
                workingDirectory,
              })
            const walkthrough = Schema.is(RepositoryComparisonReviewDescriptor)(descriptor)
              ? yield* comparisons.useWorkspace(descriptor.target, (workingDirectory) =>
                  walkthroughService.generatePrepared(input(Option.some(workingDirectory)), route),
                )
              : yield* walkthroughService.generatePrepared(input(Option.none()), route)
            return yield* walkthroughStore.save({
              ...walkthroughCacheKey(resolved.repoId, resolved),
              prNumber: Schema.is(HostedReviewDescriptor)(descriptor)
                ? descriptor.review.number
                : resolved.prNumber,
              walkthrough,
            })
          }),
        ),
      )
    })

    const runOperation = Effect.fn("Core.Walkthroughs.runOperation")(
      function* (
        operation: WalkthroughOperation,
        resolved: ResolvedWalkthrough,
        route: WalkthroughPreparedRoute,
      ) {
        const running = yield* operationStore.markRunning({
          operationId: operation.id,
          expectedStateVersion: operation.stateVersion,
        })
        if (!running.won || running.operation.state !== "running") {
          return Option.none()
        }

        const exit = yield* Effect.exit(
          generateResolved(resolved, route, operationSnapshotIdentity(operation, resolved)),
        )
        yield* persistTerminalExit(operationStore, running.operation, exit)
        return Exit.match(exit, {
          onSuccess: () => Option.none(),
          onFailure: Option.some,
        })
      },
      (effect) =>
        effect.pipe(
          Effect.catchTag("WalkthroughOperationNotFoundError", (cause) =>
            Effect.fail(
              WalkthroughOperationStoreError.make({
                operation: DiagnosticOperation.make("worker.transition"),
                message: "Walkthrough operation disappeared during a lifecycle transition.",
                cause,
              }),
            ),
          ),
        ),
    )

    const acceptAndRun = Effect.fn("Core.Walkthroughs.acceptAndRun")(function* (
      resolved: ResolvedWalkthrough,
      route: WalkthroughPreparedRoute,
      acceptanceEvidence: WalkthroughOperationAcceptanceEvidence | null,
    ) {
      return yield* startSemaphore.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const acceptance = yield* operationStore.acceptOrGet({
              operationId: WalkthroughOperationId.make(randomUUID()),
              identity: operationIdentity(resolved.repoId, resolved),
              regenerate: resolved.regenerate,
              acceptanceEvidence,
            })
            if (acceptance.created) {
              if (acceptance.operation.regenerationOfOperationId !== null) {
                yield* activeWorkers.cancel(acceptance.operation.regenerationOfOperationId)
              }
              yield* activeWorkers.run(
                acceptance.operation.id,
                runOperation(acceptance.operation, resolved, route),
              )
            }
            return acceptance
          }),
        ),
      )
    })

    const start: WalkthroughLifecycle["start"] = Effect.fn("Core.Walkthroughs.start")(
      function* (request) {
        const resolved = yield* resolveWalkthrough(request)
        const route = yield* walkthroughService.prepareRoute
        const acceptance = yield* acceptAndRun(resolved, route, null)
        return { operationId: acceptance.operation.id }
      },
    )

    const startGeneration: WalkthroughOperations["startGeneration"] = Effect.fn(
      "Core.Walkthroughs.startGeneration",
    )(function* (request) {
      const route = yield* walkthroughService.prepareRoute
      const resolved = resolvedFromGeneration(request.reviewGeneration, request.regenerate)
      return yield* acceptAndRun(
        resolved,
        route,
        WalkthroughOperationAcceptanceEvidence.make({
          acceptedRequest: request.acceptedRequest,
          idempotencyKey: request.idempotencyKey,
          reviewGeneration: request.reviewGeneration,
          regenerate: request.regenerate,
          configuredRoute: configuredRoute(route),
          candidatePlanFingerprint: candidatePlanFingerprint(route),
          attempts: [],
        }),
      )
    })

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
        ? yield* activeWorkers.get(operation.id)
        : Option.none<Fiber.Fiber<WalkthroughWorkerExit>>()
      const workerExit = Option.isSome(active)
        ? Option.some(yield* Fiber.await(active.value))
        : Option.none<Exit.Exit<WalkthroughWorkerExit>>()
      const authoritative = yield* requireOperation(operationStore, operation.id)
      if (
        isActiveOperation(authoritative) &&
        Option.isSome(workerExit) &&
        Exit.isSuccess(workerExit.value) &&
        Exit.isFailure(workerExit.value.value)
      ) {
        const failure = Cause.findErrorOption(workerExit.value.value.cause)
        if (Option.isSome(failure)) return yield* failure.value
        const defect = Cause.findDefect(workerExit.value.value.cause)
        if (Result.isSuccess(defect)) return yield* Effect.die(defect.success)
      }
      if (
        authoritative.state === "failed" &&
        Option.isSome(workerExit) &&
        Exit.isSuccess(workerExit.value) &&
        Exit.isSuccess(workerExit.value.value) &&
        Option.isSome(workerExit.value.value.value)
      ) {
        const cause = workerExit.value.value.value.value
        const defect = Cause.findDefect(cause)
        if (Result.isSuccess(defect)) {
          return WalkthroughOperationDefect.make({
            defect: captureCoreDefect(defect.success).summary,
          })
        }
        const failure = Cause.findErrorOption(cause)
        if (Option.isSome(failure)) {
          return WalkthroughOperationFailed.make({ error: failure.value })
        }
      }
      return yield* materializeOperation(authoritative)
    })

    const getSnapshot: WalkthroughOperations["getSnapshot"] = Effect.fn(
      "Core.Walkthroughs.getSnapshot",
    )((operationId) => requireOperation(operationStore, operationId))

    const cancelSnapshot: WalkthroughOperations["cancelSnapshot"] = Effect.fn(
      "Core.Walkthroughs.cancelSnapshot",
    )(function* (operationId) {
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
          yield* activeWorkers.cancel(operationId)
          break
        }
      }
      return operation
    })

    const cancel: WalkthroughLifecycle["cancel"] = Effect.fn("Core.Walkthroughs.cancel")(
      function* (operationId) {
        const operation = yield* cancelSnapshot(operationId)
        return yield* materializeOperation(operation)
      },
    )

    return {
      start,
      startGeneration,
      getOperation,
      getSnapshot,
      cancel,
      cancelSnapshot,
      getStored: getStoredWalkthrough,
      getStoredGeneration,
      getCached,
    }
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

export { summarizeCoreDefect } from "../core-defect-boundary"

const expectedFailure = (category: WalkthroughExpectedFailureCategory, code: string) =>
  WalkthroughExpectedFailure.make({
    kind: "expected",
    category,
    code: WalkthroughOperationFailureCode.make(code),
  })

const snapshotReviewError = (cause: Error) =>
  ReviewContextError.make({
    operation: "local.snapshot",
    reason: "The durable review snapshot is unavailable to the walkthrough operation.",
    cause,
  })

const classifyExpectedFailure = Match.typeTags<
  CoreWalkthroughFailure,
  WalkthroughExpectedFailure
>()({
  ReviewContextError: () => expectedFailure("review-resolution", "review-context-error"),
  RepositoryLinkError: () => expectedFailure("review-resolution", "repository-link-error"),
  RepositoryComparisonSourceError: () =>
    expectedFailure("review-resolution", "repository-comparison-source-error"),
  WalkthroughPromptPreparationError: () =>
    expectedFailure("prompt-preparation", "walkthrough-prompt-preparation-error"),
  WalkthroughStoreError: () => expectedFailure("artifact-persistence", "walkthrough-store-error"),
  WalkthroughGenerationError: () => expectedFailure("validation", "walkthrough-generation-error"),
  WalkthroughValidationError: () => expectedFailure("validation", "walkthrough-validation-error"),
  InvalidAgentProviderResponseError: () =>
    expectedFailure("validation", "invalid-agent-provider-response-error"),
  WalkthroughModelUnavailableError: () =>
    expectedFailure("provider", "walkthrough-model-unavailable-error"),
  MissingAgentProviderError: () => expectedFailure("provider", "missing-agent-provider-error"),
  UnsupportedAgentCapabilityError: () =>
    expectedFailure("provider", "unsupported-agent-capability-error"),
  AgentCapabilityUnavailableError: () =>
    expectedFailure("provider", "agent-capability-unavailable-error"),
  AgentPolicyEnforcementError: () => expectedFailure("provider", "agent-policy-enforcement-error"),
  AgentProviderProbeError: () => expectedFailure("provider", "agent-provider-probe-error"),
  InvalidAgentProviderRegistrationError: () =>
    expectedFailure("provider", "invalid-agent-provider-registration-error"),
  NoAgentProviderAvailableError: () =>
    expectedFailure("provider", "no-agent-provider-available-error"),
  AgentProviderOperationError: () => expectedFailure("provider", "agent-provider-operation-error"),
})

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

const operationSnapshotIdentity = (
  operation: WalkthroughOperation,
  resolved: ResolvedWalkthrough,
): OperationSnapshotIdentity => {
  const accepted = operation.acceptanceEvidence?.acceptedRequest
  return {
    applicationInstanceId: ApplicationInstanceId.make(
      accepted?.applicationInstanceId ?? "embedded-core",
    ),
    processEpoch: CoreProcessEpoch.make(accepted?.processEpoch ?? "embedded-epoch"),
    operationId: operation.id,
    projectId: resolved.repoId,
    reviewKey: resolved.reviewKey,
    snapshotId: resolved.snapshotId,
  }
}

const prepareBoundedWalkthrough = Effect.fn("Core.Walkthroughs.prepareBoundedSnapshot")(function* (
  handle: OperationSnapshotHandle,
) {
  const selected: Parameters<typeof reviewPromptFile>[0][] = []
  let totalFiles = 0
  let totalHunks = 0
  for (;;) {
    const page = yield* handle.inventory(totalFiles, OPERATION_SNAPSHOT_INVENTORY_LIMIT)
    totalFiles += page.length
    totalHunks += page.reduce((total, file) => total + file.hunkCount, 0)
    for (const file of page) {
      if (selected.length < WALKTHROUGH_PROMPT_CONTEXT_LIMITS.maxFiles) selected.push(file)
    }
    if (page.length < OPERATION_SNAPSHOT_INVENTORY_LIMIT) break
  }

  const files: ParsedDiffFile[] = []
  let selectedHunks = 0
  let selectedChars = 0
  for (const file of selected) {
    const hunks = []
    let offset = 0
    while (
      selectedHunks < DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxHunks &&
      selectedChars < DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxDiffChars
    ) {
      const page = yield* handle.hunks(
        ReviewFileId.make(file.fileId),
        offset,
        Math.min(
          OPERATION_SNAPSHOT_HUNK_LIMIT,
          DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxHunks - selectedHunks,
        ),
      )
      for (const hunk of page) {
        const read = yield* handle.readHunk(
          ReviewFileId.make(file.fileId),
          ReviewHunkId.make(hunk.id),
        )
        const decoded = yield* decodeSnapshotHunkLines(read.bytes)
        const remaining = DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxDiffChars - selectedChars
        const lines: string[] = []
        for (const line of decoded.slice(0, DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxLinesPerHunk)) {
          if (lines.join("\n").length + line.length + hunk.header.length + 1 > remaining) break
          lines.push(line)
        }
        if (lines.length === 0) break
        hunks.push(projectSnapshotHunk(hunk, lines))
        selectedHunks += 1
        selectedChars += hunk.header.length + lines.join("\n").length + 1
      }
      if (
        page.length < OPERATION_SNAPSHOT_HUNK_LIMIT ||
        selectedChars >= DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxDiffChars
      )
        break
      offset += page.length
    }
    files.push(projectSnapshotFile(file, handle.snapshot.reviewKey, hunks))
    if (selectedHunks >= DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxHunks) break
  }
  return {
    files,
    inventory: selected.map(reviewPromptFile),
    totalFiles,
    totalHunks,
  }
})

const walkthroughScope = (
  descriptor: ReviewDescriptor,
  reviewKey: ReviewKey,
  headRevision: ReviewRevision,
) => {
  if (Schema.is(HostedReviewDescriptor)(descriptor))
    return walkthroughHostedReviewScope(descriptor.review)
  if (Schema.is(RepositoryComparisonReviewDescriptor)(descriptor))
    return walkthroughRepositoryComparisonScope(reviewKey)
  if (Schema.is(LocalReviewDescriptor)(descriptor)) return walkthroughLocalDiffScope(headRevision)
  return descriptor satisfies never
}

const descriptorMatchesKind = (
  descriptor: ReviewDescriptor,
  kind: ResolvedWalkthrough["kind"],
): boolean =>
  Match.valueTags(descriptor, {
    hosted: () => kind === "hosted",
    local: () => kind === "local",
    repositoryComparison: () => kind === "repositoryComparison",
  })

const operationIdentity = (
  repoId: ReviewProjectIdType,
  snapshot: Pick<ResolvedWalkthroughBase, "reviewKey" | "baseRevision" | "headRevision">,
): WalkthroughOperationIdentityType =>
  WalkthroughOperationIdentity.make({
    repoId,
    reviewKey: snapshot.reviewKey,
    baseRevision: snapshot.baseRevision,
    headRevision: snapshot.headRevision,
    promptVersion: WALKTHROUGH_PROMPT_VERSION,
  })

const resolvedFromGeneration = (
  generation: WalkthroughOperationReviewGeneration,
  regenerate: boolean,
): ResolvedWalkthrough => ({
  kind: generation.kind,
  regenerate,
  repoId: generation.projectId,
  snapshotId: generation.snapshotId,
  reviewKey: generation.reviewKey,
  baseRevision: generation.baseRevision,
  headRevision: generation.headRevision,
  prNumber: null,
})

const configuredRoute = (route: WalkthroughPreparedRoute) =>
  Match.valueTags(route.selection, {
    Automatic: ({ quality }) => ({ mode: "auto" as const, quality }),
    Pinned: ({ providerId, modelId }) => ({
      mode: "provider" as const,
      providerId: AgentProviderId.make(providerId),
      modelId: modelId === null ? null : AgentModelId.make(modelId),
    }),
  })

const candidatePlanFingerprint = (route: WalkthroughPreparedRoute) =>
  WalkthroughOperationCandidatePlanFingerprint.make(
    `walkthrough-plan:v1:${createHash("sha256")
      .update(
        JSON.stringify(
          route.candidates.map(({ providerId, modelIds }) => ({ providerId, modelIds })),
        ),
      )
      .digest("hex")}`,
  )

const artifactCacheKey = (artifact: WalkthroughArtifactReference): WalkthroughCacheKey => ({
  repoId: artifact.repoId,
  reviewKey: artifact.reviewKey,
  baseSha: artifact.baseRevision,
  headSha: artifact.headRevision,
  promptVersion: artifact.promptVersion,
})

const walkthroughCacheKey = (
  repoId: ReviewProjectIdType,
  snapshot: Pick<ResolvedWalkthroughBase, "reviewKey" | "baseRevision" | "headRevision">,
): WalkthroughCacheKey => ({
  repoId,
  reviewKey: snapshot.reviewKey,
  baseSha: snapshot.baseRevision,
  headSha: snapshot.headRevision,
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
})
