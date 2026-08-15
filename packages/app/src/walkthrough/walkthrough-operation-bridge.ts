import { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import {
  WalkthroughApplicationInstanceId,
  WalkthroughProcessEpoch,
  WalkthroughRequestId,
  WalkthroughStartBridgeFailure,
  WalkthroughStartBridgeResult,
} from "@diffdash/protocol/walkthrough-operation"
import { Result, Schema } from "effect"

/** Known request context retained locally when decoding a walkthrough bridge response. */
export interface WalkthroughBridgeRequestContext {
  readonly applicationInstanceId: WalkthroughApplicationInstanceId
  readonly processEpoch: WalkthroughProcessEpoch
  readonly requestId: WalkthroughRequestId
  readonly operationId: WalkthroughOperationId | null
}

/** Validates a cloned walkthrough result or returns a request-scoped plain transport failure. */
export const decodeWalkthroughStartBridgeResult = (
  value: Schema.Json | undefined,
  context: WalkthroughBridgeRequestContext,
): WalkthroughStartBridgeResult => {
  const decoded = Schema.decodeUnknownResult(WalkthroughStartBridgeResult)(value)
  if (Result.isSuccess(decoded) && matchesRequestContext(decoded.success, context)) {
    return decoded.success
  }

  return {
    _tag: "Failure",
    error: Schema.decodeUnknownSync(WalkthroughStartBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      ...context,
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

const matchesRequestContext = (
  result: WalkthroughStartBridgeResult,
  context: WalkthroughBridgeRequestContext,
) => {
  const value = result._tag === "Success" ? result.value : result.error
  return (
    value.applicationInstanceId === context.applicationInstanceId &&
    value.processEpoch === context.processEpoch &&
    value.requestId === context.requestId &&
    (context.operationId === null || value.operationId === context.operationId)
  )
}
