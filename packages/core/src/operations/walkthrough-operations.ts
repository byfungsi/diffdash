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
  type AcceptWalkthroughOperationInput,
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
  type WalkthroughOperationId as WalkthroughOperationIdType,
  WalkthroughOperationNotFound,
} from "../core-contract"
import { CoreEventHub } from "../core-event-hub"
import { ReviewContextError } from "../services/git-provider"
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

/** Scoped walkthrough capability including generation and persistent cache access. */
export interface WalkthroughOperations {
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
  | CoreEventHub
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
    const events = yield* CoreEventHub
    const activeWorkers = yield* makeWalkthroughActiveWorkers
    const startSemaphore = yield* Semaphore.make(1)
    const publishTerminal = (operation: WalkthroughTerminalOperation) =>
      publishWalkthroughTerminalHint(events, operation)

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
        yield* persistWalkthroughTerminalExit(
          operationStore,
          running.operation,
          exit,
          publishTerminal,
        )
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
            const acceptance = yield* acceptWalkthroughOperation(
              operationStore,
              {
                operationId: WalkthroughOperationId.make(randomUUID()),
                identity: operationIdentity(resolved.repoId, resolved),
                regenerate: resolved.regenerate,
                acceptanceEvidence,
              },
              publishTerminal,
            )
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

    const getSnapshot: WalkthroughOperations["getSnapshot"] = Effect.fn(
      "Core.Walkthroughs.getSnapshot",
    )((operationId) => requireOperation(operationStore, operationId))

    const cancelSnapshot: WalkthroughOperations["cancelSnapshot"] = Effect.fn(
      "Core.Walkthroughs.cancelSnapshot",
    )(function* (operationId) {
      let operation = yield* requireOperation(operationStore, operationId)
      while (isActiveOperation(operation)) {
        const transition = yield* requestWalkthroughCancellation(
          operationStore,
          {
            operationId,
            expectedStateVersion: operation.stateVersion,
          },
          publishTerminal,
        ).pipe(
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

    return {
      startGeneration,
      getSnapshot,
      cancelSnapshot,
      getStored: getStoredWalkthrough,
      getStoredGeneration,
      getCached,
    }
  })

/** Authoritative persisted walkthrough state that no longer has active work. */
export type WalkthroughTerminalOperation = Exclude<
  WalkthroughOperation,
  { readonly state: "accepted" | "running" }
>

/** Best-effort sink for one authoritative terminal walkthrough state. */
export type WalkthroughTerminalPublisher = (
  operation: WalkthroughTerminalOperation,
) => Effect.Effect<void, Error>

const isTerminalOperation = (
  operation: WalkthroughOperation,
): operation is WalkthroughTerminalOperation =>
  operation.state !== "accepted" && operation.state !== "running"

const publishTerminalIsolated = (
  operation: WalkthroughOperation,
  publish: WalkthroughTerminalPublisher,
) =>
  isTerminalOperation(operation) ? Effect.exit(publish(operation)).pipe(Effect.asVoid) : Effect.void

/** Publishes a privacy-safe hint containing only durable walkthrough identity and scope. */
export const publishWalkthroughTerminalHint = (
  events: CoreEventHub["Service"],
  operation: WalkthroughTerminalOperation,
) =>
  events
    .publish({
      topic: "walkthrough.operation.terminal",
      schemaVersion: 1,
      scopes: [
        { name: "project", id: operation.identity.repoId },
        { name: "review", id: operation.identity.reviewKey },
      ],
      source: "walkthrough-operation",
      reason: "terminal-state-committed",
      subject: { kind: "operation", operationId: operation.id },
      kind: "operationTerminal",
      stateVersion: operation.stateVersion,
    })
    .pipe(Effect.asVoid)

/** Accepts durable work and hints when regeneration atomically supersedes prior work. */
export const acceptWalkthroughOperation = Effect.fn("Core.Walkthroughs.acceptOperation")(function* (
  store: WalkthroughOperationStore["Service"],
  input: AcceptWalkthroughOperationInput,
  publish: WalkthroughTerminalPublisher,
) {
  const acceptance = yield* store.acceptOrGet(input)
  const supersededId = acceptance.created ? acceptance.operation.regenerationOfOperationId : null
  if (supersededId !== null) {
    const superseded = yield* Effect.exit(store.get(supersededId))
    if (Exit.isSuccess(superseded) && Option.isSome(superseded.value)) {
      yield* publishTerminalIsolated(superseded.value.value, publish)
    }
  }
  return acceptance
})

/** Commits cancellation before publishing its best-effort reconciliation hint. */
export const requestWalkthroughCancellation = Effect.fn("Core.Walkthroughs.cancelOperation")(
  function* (
    store: WalkthroughOperationStore["Service"],
    input: Parameters<WalkthroughOperationStore["Service"]["requestCancellation"]>[0],
    publish: WalkthroughTerminalPublisher,
  ) {
    const transition = yield* store.requestCancellation(input)
    if (transition.won) {
      yield* publishTerminalIsolated(transition.operation, publish)
    }
    return transition
  },
)

/** Recovers abandoned active operations before publishing interruption hints. */
export const recoverInterruptedWalkthroughOperations = Effect.fn(
  "Core.Walkthroughs.recoverInterrupted",
)(function* (store: WalkthroughOperationStore["Service"], publish: WalkthroughTerminalPublisher) {
  const interrupted = yield* store.recoverActiveAsInterrupted
  yield* Effect.forEach(interrupted, (operation) => publishTerminalIsolated(operation, publish), {
    discard: true,
  })
  return interrupted
})

const publishWonTerminal = (
  transition: { readonly won: boolean; readonly operation: WalkthroughOperation },
  publish: WalkthroughTerminalPublisher,
) => (transition.won ? publishTerminalIsolated(transition.operation, publish) : Effect.void)

/** Persists a worker terminal exit before publishing its best-effort reconciliation hint. */
export const persistWalkthroughTerminalExit = (
  store: WalkthroughOperationStore["Service"],
  running: Extract<WalkthroughOperation, { readonly state: "running" }>,
  exit: Exit.Exit<StoredWalkthrough, CoreWalkthroughFailure>,
  publish: WalkthroughTerminalPublisher,
) =>
  Exit.match(exit, {
    onSuccess: () =>
      store
        .completeSuccess({
          operationId: running.id,
          expectedStateVersion: running.stateVersion,
          artifact: WalkthroughArtifactReference.make(running.identity),
        })
        .pipe(Effect.flatMap((transition) => publishWonTerminal(transition, publish))),
    onFailure: (cause) => {
      const defect = Cause.findDefect(cause)
      if (Result.isSuccess(defect)) {
        return store
          .persistInternalFailure({
            operationId: running.id,
            expectedStateVersion: running.stateVersion,
          })
          .pipe(Effect.flatMap((transition) => publishWonTerminal(transition, publish)))
      }
      const failure = Cause.findErrorOption(cause)
      if (Option.isSome(failure)) {
        return store
          .persistExpectedFailure({
            operationId: running.id,
            expectedStateVersion: running.stateVersion,
            failure: classifyExpectedFailure(failure.value),
          })
          .pipe(Effect.flatMap((transition) => publishWonTerminal(transition, publish)))
      }
      return Cause.hasInterrupts(cause)
        ? Effect.void
        : store
            .persistInternalFailure({
              operationId: running.id,
              expectedStateVersion: running.stateVersion,
            })
            .pipe(Effect.flatMap((transition) => publishWonTerminal(transition, publish)))
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
    category: "acquisitionFailed",
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

const isActiveOperation = (
  operation: WalkthroughOperation,
): operation is Extract<WalkthroughOperation, { readonly state: "accepted" | "running" }> =>
  operation.state === "accepted" || operation.state === "running"

const operationSnapshotIdentity = (
  operation: WalkthroughOperation,
  resolved: ResolvedWalkthrough,
): OperationSnapshotIdentity => {
  const accepted = operation.acceptanceEvidence?.acceptedRequest
  if (accepted === undefined) {
    throw new Error("Walkthrough operation is missing authenticated acceptance evidence.")
  }
  return {
    applicationInstanceId: ApplicationInstanceId.make(accepted.applicationInstanceId),
    processEpoch: CoreProcessEpoch.make(accepted.processEpoch),
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
