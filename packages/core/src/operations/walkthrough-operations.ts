import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import type {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
  ReviewSnapshot,
} from "@diffdash/domain/review-context"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import type { ReviewProjectId as ReviewProjectIdType } from "@diffdash/domain/review-identity"
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
  WalkthroughReviewGenerationChangedError,
} from "../core-contract"
import { ReviewSnapshotService } from "../services/review-snapshot"
import { captureCoreDefect } from "../core-defect-boundary"
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
  readonly repoId: ReviewProjectIdType
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

type WalkthroughWorkerObservation = Option.Option<Cause.Cause<CoreWalkthroughFailure>>

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
    snapshot: ReviewSnapshot,
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
  | ReviewSnapshotService
  | WalkthroughOperationStore
  | WalkthroughService
  | WalkthroughStore
> =>
  Effect.gen(function* () {
    const comparisons = yield* RepositoryComparisonSource
    const walkthroughService = yield* WalkthroughService
    const operationStore = yield* WalkthroughOperationStore
    const walkthroughStore = yield* WalkthroughStore
    const reviewSnapshots = yield* ReviewSnapshotService
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
              ...resolved,
            })),
          )
        case "repositoryComparison":
          return reviews.resolveRepositoryComparison(target).pipe(
            Effect.map((resolved) => ({
              kind: "repositoryComparison" as const,
              target,
              regenerate: request.regenerate,
              repoId: resolved.repo.id,
              ...resolved,
            })),
          )
        case "local":
          return reviews.resolveLocal(target).pipe(
            Effect.map((resolved) => ({
              kind: "local" as const,
              target,
              regenerate: request.regenerate,
              repoId: resolved.repo.id,
              ...resolved,
            })),
          )
      }
    })

    const loadOrGenerate = Effect.fn("Core.Walkthroughs.loadOrGenerate")(function* (
      resolved: ResolvedWalkthrough,
      generate: Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure>,
    ) {
      const cacheKey = walkthroughCacheKey(resolved.repoId, resolved.snapshot)
      if (resolved.regenerate) return yield* generate
      const cached = yield* walkthroughStore.get(cacheKey)
      return yield* Option.match(cached, {
        onNone: () => generate,
        onSome: (walkthrough) => ensureExactWalkthrough(walkthroughStore, cacheKey, walkthrough),
      })
    })

    const generateResolved = Effect.fn("Core.Walkthroughs.generateResolved")(function (
      resolved: ResolvedWalkthrough,
      route: WalkthroughPreparedRoute,
    ): Effect.Effect<StoredWalkthrough, CoreWalkthroughFailure> {
      switch (resolved.kind) {
        case "hosted":
          return loadOrGenerate(
            resolved,
            Effect.gen(function* () {
              const cacheKey = walkthroughCacheKey(resolved.repoId, resolved.snapshot)
              const promptInput = yield* prepareWalkthroughPromptInput(
                resolved.snapshot.parsedDiff.files,
                walkthroughHostedReviewScope(resolved.target.review),
              )
              const walkthrough = yield* walkthroughService.generatePrepared(
                WalkthroughGenerationInput.make({
                  review: WalkthroughReviewContext.make({
                    kind: "hosted",
                    hostedReview: resolved.snapshot.detail,
                  }),
                  diff: promptInput.diff,
                  hunkDigest: promptInput.hunkDigest,
                  changedFileTree: promptInput.changedFileTree,
                  generation: promptInput.generation,
                  promptStats: Option.some(promptInput.stats),
                  workingDirectory: Option.none(),
                }),
                route,
              )
              return yield* walkthroughStore.save({
                ...cacheKey,
                prNumber: resolved.prNumber,
                walkthrough,
              })
            }),
          )
        case "repositoryComparison":
          return loadOrGenerate(
            resolved,
            Effect.gen(function* () {
              const cacheKey = walkthroughCacheKey(resolved.repoId, resolved.snapshot)
              const promptInput = yield* prepareWalkthroughPromptInput(
                resolved.snapshot.parsedDiff.files,
                walkthroughRepositoryComparisonScope(resolved.snapshot.reviewKey),
              )
              const walkthrough = yield* comparisons.useWorkspace(
                resolved.target,
                (workingDirectory) =>
                  walkthroughService.generatePrepared(
                    WalkthroughGenerationInput.make({
                      review: WalkthroughReviewContext.make({
                        kind: "repositoryComparison",
                        comparison: resolved.snapshot.detail,
                      }),
                      diff: promptInput.diff,
                      hunkDigest: promptInput.hunkDigest,
                      changedFileTree: promptInput.changedFileTree,
                      generation: promptInput.generation,
                      promptStats: Option.some(promptInput.stats),
                      workingDirectory: Option.some(workingDirectory),
                    }),
                    route,
                  ),
              )
              return yield* walkthroughStore.save({
                ...cacheKey,
                prNumber: null,
                walkthrough,
              })
            }),
          )
        case "local":
          return loadOrGenerate(
            resolved,
            Effect.gen(function* () {
              const cacheKey = walkthroughCacheKey(resolved.repoId, resolved.snapshot)
              const promptInput = yield* prepareWalkthroughPromptInput(
                resolved.snapshot.parsedDiff.files,
                walkthroughLocalDiffScope(resolved.snapshot.headRevision),
              )
              const walkthrough = yield* walkthroughService.generatePrepared(
                WalkthroughGenerationInput.make({
                  review: WalkthroughReviewContext.make({
                    kind: "localDiff",
                    localReview: resolved.snapshot.detail,
                  }),
                  diff: promptInput.diff,
                  hunkDigest: promptInput.hunkDigest,
                  changedFileTree: promptInput.changedFileTree,
                  generation: promptInput.generation,
                  promptStats: Option.some(promptInput.stats),
                  workingDirectory: Option.none(),
                }),
                route,
              )
              return yield* walkthroughStore.save({
                ...cacheKey,
                prNumber: null,
                walkthrough,
              })
            }),
          )
      }
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

        const exit = yield* Effect.exit(generateResolved(resolved, route))
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
              identity: operationIdentity(resolved.repoId, resolved.snapshot),
              regenerate: resolved.regenerate,
              acceptanceEvidence,
            })
            if (acceptance.created) {
              if (acceptance.operation.regenerationOfOperationId !== null) {
                yield* FiberMap.remove(activeFibers, acceptance.operation.regenerationOfOperationId)
              }
              yield* FiberMap.run(
                activeFibers,
                acceptance.operation.id,
                runOperation(acceptance.operation, resolved, route),
                { onlyIfMissing: true },
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
      const snapshot = yield* reviewSnapshots
        .getForProject(request.reviewGeneration.snapshotId, request.reviewGeneration.projectId)
        .pipe(
          Effect.mapError(() =>
            WalkthroughReviewGenerationChangedError.make({
              snapshotId: request.reviewGeneration.snapshotId,
              reason: "unavailable",
            }),
          ),
        )
      if (!matchesReviewGeneration(snapshot, request.reviewGeneration)) {
        return yield* WalkthroughReviewGenerationChangedError.make({
          snapshotId: request.reviewGeneration.snapshotId,
          reason: "mismatched",
        })
      }
      const route = yield* walkthroughService.prepareRoute
      const resolved = resolvedFromGeneration(
        snapshot,
        request.reviewGeneration.projectId,
        request.regenerate,
      )
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
        Option.isSome(workerExit.value.value)
      ) {
        const cause = workerExit.value.value.value
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
          yield* FiberMap.remove(activeFibers, operationId)
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

const operationIdentity = (
  repoId: ReviewProjectIdType,
  snapshot: ReviewSnapshot,
): WalkthroughOperationIdentityType =>
  WalkthroughOperationIdentity.make({
    repoId,
    reviewKey: snapshot.reviewKey,
    baseRevision: snapshot.baseRevision,
    headRevision: snapshot.headRevision,
    promptVersion: WALKTHROUGH_PROMPT_VERSION,
  })

const matchesReviewGeneration = (
  snapshot: ReviewSnapshot,
  generation: WalkthroughOperationReviewGeneration,
) =>
  Match.valueTags(snapshot, {
    hosted: () => generation.kind === "hosted",
    local: () => generation.kind === "local",
    repositoryComparison: () => generation.kind === "repositoryComparison",
  }) &&
  snapshot.snapshotId === generation.snapshotId &&
  snapshot.reviewKey === generation.reviewKey &&
  snapshot.baseRevision === generation.baseRevision &&
  snapshot.headRevision === generation.headRevision

const resolvedFromGeneration = (
  snapshot: ReviewSnapshot,
  repoId: ReviewProjectIdType,
  regenerate: boolean,
): ResolvedWalkthrough =>
  Match.valueTags(snapshot, {
    hosted: (hosted) => ({
      kind: "hosted" as const,
      target: { kind: "hosted" as const, review: hosted.detail.summary.locator },
      regenerate,
      repoId,
      snapshot: hosted,
      prNumber: hosted.detail.summary.locator.number,
    }),
    local: (local) => ({
      kind: "local" as const,
      target: {
        kind: "local" as const,
        rootPath: local.detail.rootPath,
        comparison: local.detail.comparison,
      },
      regenerate,
      repoId,
      snapshot: local,
      prNumber: null,
    }),
    repositoryComparison: (comparison) => ({
      kind: "repositoryComparison" as const,
      target: comparison.detail.target,
      regenerate,
      repoId,
      snapshot: comparison,
      prNumber: null,
    }),
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
  snapshot: ReviewSnapshot,
): WalkthroughCacheKey => ({
  repoId,
  reviewKey: snapshot.reviewKey,
  baseSha: snapshot.baseRevision,
  headSha: snapshot.headRevision,
  promptVersion: WALKTHROUGH_PROMPT_VERSION,
})
