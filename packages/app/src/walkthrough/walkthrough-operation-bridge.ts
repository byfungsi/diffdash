import { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import {
  WalkthroughApplicationInstanceId,
  WalkthroughProcessEpoch,
  WalkthroughRequestId,
  WalkthroughStartBridgeFailure,
  WalkthroughStartBridgeResult,
} from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughGetOperationBridgeFailure,
  WalkthroughGetOperationBridgeResult,
} from "@diffdash/protocol/walkthrough-operation-state"
import { Match, Option, Result, Schema } from "effect"

interface WalkthroughBridgeRequestIdentity {
  readonly applicationInstanceId: WalkthroughApplicationInstanceId
  readonly processEpoch: WalkthroughProcessEpoch
  readonly requestId: WalkthroughRequestId
}

/** Start request context retained locally while operation acceptance is optional. */
export interface WalkthroughStartBridgeRequestContext extends WalkthroughBridgeRequestIdentity {
  readonly operationId: Option.Option<WalkthroughOperationId>
}

/** Operation request context retained locally after an operation has been accepted. */
export interface WalkthroughOperationBridgeRequestContext extends WalkthroughBridgeRequestIdentity {
  readonly operationId: WalkthroughOperationId
}

/** Validates a cloned walkthrough result or returns a request-scoped plain transport failure. */
export const decodeWalkthroughStartBridgeResult = (
  value: Schema.Json | undefined,
  context: WalkthroughStartBridgeRequestContext,
): WalkthroughStartBridgeResult => {
  const decoded = Schema.decodeUnknownResult(WalkthroughStartBridgeResult)(value)
  if (Result.isSuccess(decoded)) {
    const response = Match.valueTags(decoded.success, {
      Success: (success) => success.value,
      Failure: (failure) => failure.error,
    })
    const operationMatches = Option.match(context.operationId, {
      onNone: () => true,
      onSome: (operationId) => response.operationId === operationId,
    })
    if (matchesRequestIdentity(response, context) && operationMatches) return decoded.success
  }

  return {
    _tag: "Failure",
    error: Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      ...context,
      operationId: Option.getOrNull(context.operationId),
      method: "Walkthroughs.start",
      code: "WALKTHROUGH_TRANSPORT_ERROR",
      providerId: null,
      modelId: null,
      retryClass: "notRetryable",
      remediation: "retry",
      safeMessage: "DiffDash received an invalid walkthrough response.",
      attempts: [],
      diagnostic: null,
    }),
  }
}

/** Validates a cloned operation-state result or returns a request-scoped transport failure. */
export const decodeWalkthroughGetOperationBridgeResult = (
  value: Schema.Json | undefined,
  context: WalkthroughOperationBridgeRequestContext,
): WalkthroughGetOperationBridgeResult => {
  const decoded = Schema.decodeUnknownResult(WalkthroughGetOperationBridgeResult)(value)
  if (Result.isSuccess(decoded)) {
    const response = Match.valueTags(decoded.success, {
      Success: (success) => success.value,
      Failure: (failure) => failure.error,
    })
    if (matchesRequestIdentity(response, context) && response.operationId === context.operationId) {
      return decoded.success
    }
  }

  return {
    _tag: "Failure",
    error: Schema.decodeUnknownSync(WalkthroughGetOperationBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      ...context,
      method: "Walkthroughs.getOperation",
      code: "WALKTHROUGH_TRANSPORT_ERROR",
      providerId: null,
      modelId: null,
      retryClass: "notRetryable",
      remediation: "retry",
      safeMessage: "DiffDash received an invalid walkthrough operation response.",
      attempts: [],
      diagnostic: null,
    }),
  }
}

const matchesRequestIdentity = (
  response: WalkthroughBridgeRequestIdentity,
  context: WalkthroughBridgeRequestIdentity,
) =>
  response.applicationInstanceId === context.applicationInstanceId &&
  response.processEpoch === context.processEpoch &&
  response.requestId === context.requestId
