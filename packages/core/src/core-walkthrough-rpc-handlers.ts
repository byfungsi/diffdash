import { WalkthroughOperationId as DomainWalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import {
  WalkthroughOperationAcceptanceEvidence,
  WalkthroughOperationIdempotencyKey,
  WalkthroughOperationReviewGeneration,
  type WalkthroughOperation,
} from "@diffdash/domain/walkthrough-operation"
import {
  GetStoredWalkthroughResult,
  WalkthroughCancelFailure,
  WalkthroughCancelResult,
  WalkthroughCandidatePlanFingerprint,
  WalkthroughConfiguredRoute,
  WalkthroughGetOperationFailure,
  WalkthroughGetStoredFailure,
  WalkthroughIdempotencyKey,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughReviewGeneration,
  WalkthroughStartFailure,
  type CancelWalkthroughRequest,
  type GetStoredWalkthroughRequest,
  type GetWalkthroughOperationRequest,
  type StartWalkthroughRequest,
} from "@diffdash/core-rpc/walkthrough"
import { WalkthroughBusinessRpcs } from "@diffdash/core-rpc/walkthrough-rpc"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import { Effect, Layer, Match, Option, Schema } from "effect"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"

import { CoreOperationService } from "./core-operation-service"
import type { CoreThreadResolutionFailure, CoreWalkthroughOperationFailure } from "./core-contract"
import { CoreRuntimeServices } from "./core-runtime-services"
import { coreRuntimeOperationsLayer } from "./core-runtime-services"

/** Core-backed handlers for durable walkthrough acceptance, state, cancellation, and artifacts. */
export const coreWalkthroughRpcHandlersWithRuntimeLayer = WalkthroughBusinessRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    const core = runtime.operations

    return {
      "Walkthroughs.start": (request) =>
        core
          .pipe(
            Effect.flatMap((operations) =>
              operations.walkthroughs.resolveGeneration(request.target).pipe(
                Effect.flatMap((reviewGeneration) =>
                  operations.walkthroughs.startGeneration({
                    acceptedRequest: request,
                    idempotencyKey: WalkthroughOperationIdempotencyKey.make(request.idempotencyKey),
                    reviewGeneration,
                    regenerate: request.regenerate,
                  }),
                ),
              ),
            ),
          )
          .pipe(
            Effect.map((acceptance) =>
              WalkthroughOperationAccepted.make({
                applicationInstanceId: request.applicationInstanceId,
                processEpoch: request.processEpoch,
                requestId: request.requestId,
                operationId: acceptance.operation.id,
                stateVersion: acceptance.operation.stateVersion,
                created: acceptance.created,
              }),
            ),
            Effect.mapError((error) =>
              startFailure(
                request,
                Match.value(error).pipe(
                  Match.tag(
                    "WalkthroughReviewGenerationChangedError",
                    () => "WALKTHROUGH_REVIEW_GENERATION_CHANGED" as const,
                  ),
                  Match.tag("ReviewContextError", () => "WALKTHROUGH_REVIEW_RESOLUTION" as const),
                  Match.tag("RepositoryLinkError", () => "WALKTHROUGH_REVIEW_RESOLUTION" as const),
                  Match.tag(
                    "RepositoryComparisonSourceError",
                    () => "WALKTHROUGH_REVIEW_RESOLUTION" as const,
                  ),
                  Match.orElse(() => "WALKTHROUGH_OPERATION_STORE" as const),
                ),
              ),
            ),
          ),
      "Walkthroughs.getOperation": (request) =>
        core.pipe(
          Effect.flatMap((operations) =>
            operations.walkthroughs
              .getSnapshot(DomainWalkthroughOperationId.make(request.operationId))
              .pipe(Effect.flatMap((operation) => operationSnapshot(operations, operation))),
          ),
          Effect.mapError((error) => operationFailure(request, error)),
        ),
      "Walkthroughs.cancel": (request) =>
        core
          .pipe(
            Effect.flatMap((operations) =>
              operations.walkthroughs
                .cancelSnapshot(DomainWalkthroughOperationId.make(request.operationId))
                .pipe(Effect.map((operation) => ({ operation, operations }))),
            ),
          )
          .pipe(
            Effect.flatMap(({ operation, operations }) => operationSnapshot(operations, operation)),
            Effect.map((operation) =>
              Schema.decodeUnknownSync(WalkthroughCancelResult)({
                status: operation.state === "cancelled" ? "cancelled" : "alreadyCompleted",
                operation,
              }),
            ),
            Effect.mapError((error) => cancelFailure(request, error)),
          ),
      "Walkthroughs.getStored": (request) =>
        core
          .pipe(
            Effect.flatMap((operations) =>
              operations.walkthroughs
                .resolveGeneration(request.target)
                .pipe(
                  Effect.flatMap((generation) =>
                    operations.walkthroughs
                      .getStoredGeneration(generation, request.promptVersion)
                      .pipe(Effect.map((stored) => ({ generation, stored }))),
                  ),
                ),
            ),
          )
          .pipe(
            Effect.map(({ generation, stored }) =>
              Option.match(stored, {
                onNone: () =>
                  Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
                    status: "notFound",
                    reviewGeneration: rpcGeneration(generation),
                    promptVersion: request.promptVersion,
                  }),
                onSome: (artifact) =>
                  Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
                    status: "found",
                    stored: storedArtifact(rpcGeneration(generation), artifact),
                  }),
              }),
            ),
            Effect.mapError((error) => getStoredFailure(request, error)),
          ),
    }
  }),
)

/** Walkthrough handlers backed directly by an already-composed operation service. */
export const coreWalkthroughRpcHandlersLayer = coreWalkthroughRpcHandlersWithRuntimeLayer.pipe(
  Layer.provide(coreRuntimeOperationsLayer),
)

const rpcGeneration = (generation: WalkthroughOperationReviewGeneration) =>
  WalkthroughReviewGeneration.make(generation)

const commonSnapshot = (
  operation: WalkthroughOperation,
  evidence: WalkthroughOperationAcceptanceEvidence,
) => ({
  acceptedRequest: HostRequestContext.make({
    applicationInstanceId: ApplicationInstanceId.make(
      evidence.acceptedRequest.applicationInstanceId,
    ),
    processEpoch: CoreProcessEpoch.make(evidence.acceptedRequest.processEpoch),
    requestId: HostRequestId.make(evidence.acceptedRequest.requestId),
  }),
  operationId: operation.id,
  stateVersion: operation.stateVersion,
  idempotencyKey: WalkthroughIdempotencyKey.make(evidence.idempotencyKey),
  reviewGeneration: rpcGeneration(evidence.reviewGeneration),
  promptVersion: operation.identity.promptVersion,
  configuredRoute: WalkthroughConfiguredRoute.make(evidence.configuredRoute),
  candidatePlanFingerprint: WalkthroughCandidatePlanFingerprint.make(
    evidence.candidatePlanFingerprint,
  ),
  attempts: evidence.attempts,
  acceptedAt: operation.acceptedAt,
  updatedAt: operation.updatedAt,
})

const operationSnapshot = Effect.fn("Core.Walkthroughs.rpcSnapshot")(function* (
  core: CoreOperationService["Service"],
  operation: WalkthroughOperation,
) {
  const evidence = operation.acceptanceEvidence
  if (evidence === null) return yield* legacyOperationFailure(operation.id)
  const common = commonSnapshot(operation, evidence)
  switch (operation.state) {
    case "accepted":
      return yield* decodeSnapshot({ ...common, state: "active", phase: "queued" })
    case "running":
      return yield* decodeSnapshot({ ...common, state: "active", phase: "running" })
    case "completed": {
      const stored = yield* core.walkthroughs.getStoredGeneration(
        evidence.reviewGeneration,
        operation.identity.promptVersion,
      )
      const artifact = yield* Effect.fromOption(stored, () => legacyOperationError(operation.id))
      return yield* decodeSnapshot({
        ...common,
        state: "completed",
        stored: storedArtifact(rpcGeneration(evidence.reviewGeneration), artifact),
        terminalAt: operation.terminalAt,
      })
    }
    case "failed":
      return yield* decodeSnapshot({
        ...common,
        state: "failed",
        failure: persistedFailure(operation),
        terminalAt: operation.terminalAt,
      })
    case "cancelled":
      return yield* decodeSnapshot({
        ...common,
        state: "cancelled",
        terminalAt: operation.terminalAt,
      })
    case "superseded":
      return yield* decodeSnapshot({
        ...common,
        state: "superseded",
        supersededByOperationId: operation.supersededByOperationId,
        terminalAt: operation.terminalAt,
      })
    case "interrupted":
      return yield* decodeSnapshot({
        ...common,
        state: "interrupted",
        terminalAt: operation.terminalAt,
      })
  }
})

const decodeSnapshot = (input: WalkthroughOperationSnapshot) =>
  Schema.decodeUnknownEffect(WalkthroughOperationSnapshot)(input).pipe(Effect.orDie)

const storedArtifact = (
  reviewGeneration: WalkthroughReviewGeneration,
  stored: StoredWalkthrough,
) => ({
  reviewGeneration,
  promptVersion: stored.promptVersion,
  walkthrough: stored.walkthrough,
  createdAt: stored.createdAt,
})

const persistedFailure = (
  operation: Extract<WalkthroughOperation, { readonly state: "failed" }>,
) => {
  const code =
    operation.failure.kind === "internal"
      ? "WALKTHROUGH_INTERNAL_ERROR"
      : operation.failure.category === "review-resolution"
        ? "WALKTHROUGH_REVIEW_RESOLUTION"
        : operation.failure.category === "prompt-preparation"
          ? "WALKTHROUGH_PROMPT_PREPARATION"
          : operation.failure.category === "provider"
            ? "AGENT_PROVIDER_FAILURE"
            : operation.failure.category === "validation"
              ? "WALKTHROUGH_VALIDATION"
              : operation.failure.category === "artifact-persistence"
                ? "WALKTHROUGH_STORE"
                : operation.failure.category === "operation-persistence"
                  ? "WALKTHROUGH_OPERATION_STORE"
                  : "WALKTHROUGH_INTERNAL_ERROR"
  return {
    code,
    providerId: null,
    modelId: null,
    retryClass: "userAction",
    remediation: code === "WALKTHROUGH_INTERNAL_ERROR" ? "contactSupport" : "retry",
    safeMessage: "DiffDash could not complete this walkthrough operation.",
    diagnostic: null,
  } as const
}

const failureDetail = (code: string, safeMessage: string) => ({
  code,
  providerId: null,
  modelId: null,
  retryClass: "userAction" as const,
  remediation: "retry" as const,
  safeMessage,
  attempts: [],
  diagnostic: null,
})

const startFailure = (
  request: StartWalkthroughRequest,
  code:
    | "WALKTHROUGH_REVIEW_GENERATION_CHANGED"
    | "WALKTHROUGH_REVIEW_RESOLUTION"
    | "WALKTHROUGH_OPERATION_STORE",
) =>
  Schema.decodeUnknownSync(WalkthroughStartFailure)({
    _tag: "WalkthroughPublicFailure",
    ...requestIdentity(request),
    method: "Walkthroughs.start",
    operationId: null,
    ...failureDetail(code, "DiffDash could not accept this walkthrough generation."),
  })

const operationFailure = (
  request: GetWalkthroughOperationRequest,
  error: CoreWalkthroughOperationFailure | ReturnType<typeof legacyOperationError>,
) =>
  Schema.decodeUnknownSync(WalkthroughGetOperationFailure)({
    _tag: "WalkthroughPublicFailure",
    ...requestIdentity(request),
    method: "Walkthroughs.getOperation",
    operationId: request.operationId,
    ...failureDetail(
      Match.valueTags(error, {
        WalkthroughOperationNotFound: () => "WALKTHROUGH_OPERATION_NOT_FOUND" as const,
        WalkthroughOperationStateUnavailable: () =>
          "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE" as const,
        WalkthroughOperationArtifactUnavailable: () =>
          "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE" as const,
        WalkthroughOperationStoreError: () => "WALKTHROUGH_OPERATION_STORE" as const,
        WalkthroughStoreError: () => "WALKTHROUGH_OPERATION_STORE" as const,
      }),
      "DiffDash could not read this walkthrough operation.",
    ),
  })

const cancelFailure = (
  request: CancelWalkthroughRequest,
  error: CoreWalkthroughOperationFailure | ReturnType<typeof legacyOperationError>,
) =>
  Schema.decodeUnknownSync(WalkthroughCancelFailure)({
    _tag: "WalkthroughPublicFailure",
    ...requestIdentity(request),
    method: "Walkthroughs.cancel",
    operationId: request.operationId,
    ...failureDetail(
      Match.valueTags(error, {
        WalkthroughOperationNotFound: () => "WALKTHROUGH_OPERATION_NOT_FOUND" as const,
        WalkthroughOperationStateUnavailable: () => "WALKTHROUGH_OPERATION_STORE" as const,
        WalkthroughOperationArtifactUnavailable: () => "WALKTHROUGH_OPERATION_STORE" as const,
        WalkthroughOperationStoreError: () => "WALKTHROUGH_OPERATION_STORE" as const,
        WalkthroughStoreError: () => "WALKTHROUGH_OPERATION_STORE" as const,
      }),
      "DiffDash could not cancel this walkthrough operation.",
    ),
  })

const getStoredFailure = (
  request: GetStoredWalkthroughRequest,
  error: CoreThreadResolutionFailure | WalkthroughStoreError,
) =>
  Schema.decodeUnknownSync(WalkthroughGetStoredFailure)({
    _tag: "WalkthroughPublicFailure",
    ...requestIdentity(request),
    method: "Walkthroughs.getStored",
    operationId: null,
    ...failureDetail(
      Match.valueTags(error, {
        ReviewContextError: () => "WALKTHROUGH_REVIEW_RESOLUTION" as const,
        RepositoryLinkError: () => "WALKTHROUGH_REVIEW_RESOLUTION" as const,
        RepositoryComparisonSourceError: () => "WALKTHROUGH_REVIEW_RESOLUTION" as const,
        WalkthroughStoreError: () => "WALKTHROUGH_STORE" as const,
      }),
      "DiffDash could not read the stored walkthrough.",
    ),
  })

const legacyOperationFailure = (operationId: DomainWalkthroughOperationId) =>
  Effect.fail(legacyOperationError(operationId))

const legacyOperationError = (operationId: DomainWalkthroughOperationId) =>
  ({ _tag: "WalkthroughOperationStateUnavailable", operationId }) as const

const requestIdentity = (
  request:
    | StartWalkthroughRequest
    | GetWalkthroughOperationRequest
    | CancelWalkthroughRequest
    | GetStoredWalkthroughRequest,
) => ({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
})
