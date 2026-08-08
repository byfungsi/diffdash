import {
  isPublicReasonTransportErrorCode,
  toTransportError,
  transportError,
  TransportError,
} from "@diffdash/protocol/transport-error"
import {
  ReviewThreadAnchorInvalidError,
  ReviewThreadRevisionChangedError,
} from "@diffdash/domain/review-thread"
import { ReviewSnapshotSearchResultTooLargeError } from "@diffdash/core"

/** Adapts one main-process failure to bounded renderer-safe protocol data. */
export const toPublicIpcError = (error: unknown, operation: string) => {
  if (error instanceof TransportError) return toTransportError(error, operation)
  if (error instanceof ReviewThreadRevisionChangedError) {
    return transportError(
      "REVIEW_CHANGED",
      "Review changed before the local thread was created.",
      operation,
    )
  }
  if (error instanceof ReviewThreadAnchorInvalidError) {
    return transportError(
      "INVALID_REVIEW_ANCHOR",
      "Review thread anchor does not exist in the expected review revision.",
      operation,
    )
  }
  if (error instanceof ReviewSnapshotSearchResultTooLargeError) {
    return transportError(
      "PAYLOAD_TOO_LARGE",
      "One review search result exceeds the bounded response size.",
      operation,
    )
  }

  const domainFailure = safeDomainFailure(error)
  return domainFailure === null
    ? toTransportError(error, operation)
    : transportError(domainFailure.code, domainFailure.reason, operation)
}

const safeDomainFailure = (error: unknown) => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    typeof error["_tag"] !== "string" ||
    !isPublicReasonTransportErrorCode(error["_tag"]) ||
    !("reason" in error) ||
    typeof error.reason !== "string"
  ) {
    return null
  }
  return { code: error["_tag"], reason: error.reason }
}
