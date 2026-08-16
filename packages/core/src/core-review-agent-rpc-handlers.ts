import {
  ReviewAgentCancelFailure,
  ReviewAgentGetOperationFailure,
  ReviewAgentOperationAccepted,
  ReviewAgentStartFailure,
  type ReviewAgentOperationRequest,
  type StartReviewAgentOperationRequest,
} from "@diffdash/core-rpc/review-agent"
import { ReviewAgentBusinessRpcs } from "@diffdash/core-rpc/review-agent-rpc"
import {
  ReviewTurnRejectedError,
  ReviewTurnTargetError,
} from "@diffdash/persistence/review-turn-store"
import { Effect, Layer, Option, Schema } from "effect"

import type { CoreReviewAgentStartError } from "./core-operation-service"
import { CoreRuntimeServices } from "./core-runtime-services"
import { coreRuntimeOperationsLayer } from "./core-runtime-services"

/** Core-backed handlers for durable review-agent acceptance, state, and cancellation. */
export const coreReviewAgentRpcHandlersWithRuntimeLayer = ReviewAgentBusinessRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    const core = runtime.operations
    return {
      "ReviewThreads.runAgent": (request) =>
        core.pipe(
          Effect.flatMap((operations) => operations.reviewAgents.start(request)),
          Effect.map((runId) =>
            ReviewAgentOperationAccepted.make({
              applicationInstanceId: request.applicationInstanceId,
              processEpoch: request.processEpoch,
              requestId: request.requestId,
              runId,
            }),
          ),
          Effect.mapError((error) => startFailure(request, error)),
        ),
      "ReviewAgents.getOperation": (request) =>
        core.pipe(
          Effect.flatMap((operations) => operations.reviewAgents.getOperation(request.runId)),
          Effect.mapError(() => getOperationFailure(request, false)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(getOperationFailure(request, true)),
              onSome: Effect.succeed,
            }),
          ),
        ),
      "ReviewAgents.cancel": (request) =>
        core.pipe(
          Effect.flatMap((operations) => operations.reviewAgents.cancel(request.runId)),
          Effect.mapError(() => cancelFailure(request, false)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(cancelFailure(request, true)),
              onSome: Effect.succeed,
            }),
          ),
        ),
    }
  }),
)

/** Review-agent handlers backed directly by an already-composed operation service. */
export const coreReviewAgentRpcHandlersLayer = coreReviewAgentRpcHandlersWithRuntimeLayer.pipe(
  Layer.provide(coreRuntimeOperationsLayer),
)

const startFailure = (
  request: StartReviewAgentOperationRequest,
  error: CoreReviewAgentStartError,
) =>
  ReviewAgentStartFailure.make({
    ...requestIdentity(request),
    method: "ReviewThreads.runAgent",
    runId: null,
    code:
      Schema.is(ReviewTurnTargetError)(error) || Schema.is(ReviewTurnRejectedError)(error)
        ? "REVIEW_AGENT_OPERATION_REJECTED"
        : "REVIEW_AGENT_OPERATION_STORE",
    safeMessage: "DiffDash could not accept this review-agent operation.",
  })

const getOperationFailure = (request: ReviewAgentOperationRequest, notFound: boolean) =>
  ReviewAgentGetOperationFailure.make({
    ...requestIdentity(request),
    method: "ReviewAgents.getOperation",
    runId: request.runId,
    code: notFound ? "REVIEW_AGENT_OPERATION_NOT_FOUND" : "REVIEW_AGENT_OPERATION_STORE",
    safeMessage: "DiffDash could not read this review-agent operation.",
  })

const cancelFailure = (request: ReviewAgentOperationRequest, notFound: boolean) =>
  ReviewAgentCancelFailure.make({
    ...requestIdentity(request),
    method: "ReviewAgents.cancel",
    runId: request.runId,
    code: notFound ? "REVIEW_AGENT_OPERATION_NOT_FOUND" : "REVIEW_AGENT_OPERATION_STORE",
    safeMessage: "DiffDash could not cancel this review-agent operation.",
  })

const requestIdentity = (
  request: StartReviewAgentOperationRequest | ReviewAgentOperationRequest,
) => ({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
})
