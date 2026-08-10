import { AgentProviderId } from "@diffdash/agent-provider"
import { transportError } from "@diffdash/protocol/transport-error"
import { ReviewAgentProviderFailureError } from "@diffdash/core"
import { Schema } from "effect"
import { toPublicIpcError } from "./public-error"
import { providerFailurePresentation } from "./walkthrough-public-error"

/** Adapts review-thread failures without exposing provider output or orchestration causes. */
export const toPublicReviewThreadError = <A>(error: A, operation: string) => {
  if (!Schema.is(ReviewAgentProviderFailureError)(error)) {
    return toPublicIpcError(error, operation)
  }
  const failure = error.failure
  const provider = AgentProviderId.make(failure.providerId)
  const presentation = providerFailurePresentation(failure.category, provider, "review response")
  return transportError(
    presentation?.code ?? "AgentProviderOperationError",
    presentation?.message ?? `Provider ${provider} could not complete the review response.`,
    operation,
    undefined,
    failure,
  )
}
