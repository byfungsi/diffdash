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
import { Effect, Option, Schema } from "effect"

import { CoreOperationService, type CoreReviewAgentStartError } from "./core-operation-service"

/** Core-backed handlers for durable review-agent acceptance, state, and cancellation. */
export const coreReviewAgentRpcHandlersLayer = ReviewAgentBusinessRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* CoreOperationService
    return {
      "ReviewAgents.start": (request) =>
        core.reviewAgents.start(request).pipe(
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
        core.reviewAgents.getOperation(request.runId).pipe(
          Effect.mapError(() => getOperationFailure(request, false)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(getOperationFailure(request, true)),
              onSome: Effect.succeed,
            }),
          ),
        ),
      "ReviewAgents.cancel": (request) =>
        core.reviewAgents.cancel(request.runId).pipe(
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

const startFailure = (
  request: StartReviewAgentOperationRequest,
  error: CoreReviewAgentStartError,
) =>
  ReviewAgentStartFailure.make({
    ...requestIdentity(request),
    method: "ReviewAgents.start",
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
