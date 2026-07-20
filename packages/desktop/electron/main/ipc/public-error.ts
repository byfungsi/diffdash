import {
  toTransportError,
  transportError,
  TransportError,
} from "@diffdash/protocol/transport-error"

const SAFE_REASON_TAGS = new Set([
  "LocalReviewTargetError",
  "RepositoryLinkError",
  "ReviewAgentFinalizeError",
  "ReviewAgentServiceError",
  "ReviewTurnRejectedError",
  "ReviewTurnTargetError",
])

/** Adapts one main-process failure to bounded renderer-safe protocol data. */
export const toPublicIpcError = (error: unknown, operation: string) => {
  if (error instanceof TransportError) return toTransportError(error, operation)

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
    !SAFE_REASON_TAGS.has(error["_tag"]) ||
    !("reason" in error) ||
    typeof error.reason !== "string"
  ) {
    return null
  }
  return { code: error["_tag"], reason: error.reason }
}
