import {
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderOperationError,
  AgentProviderProbeError,
  InvalidAgentProviderResponseError,
  MissingAgentProviderError,
  UnsupportedAgentCapabilityError,
} from "@diffdash/agent-provider"
import { NoAgentProviderAvailableError } from "@diffdash/agent-provider/registry"
import {
  WalkthroughPromptPreparationError,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import { transportError } from "@diffdash/protocol/transport-error"
import { WalkthroughGenerationError, WalkthroughModelUnavailableError } from "@diffdash/walkthrough"
import { ReviewContextError } from "../../../src/main/services/review-context"
import { toPublicIpcError } from "./public-error"

/** Adapts walkthrough failures to user-reportable diagnostics without exposing private causes. */
export const toPublicWalkthroughError = (error: unknown, operation: string) => {
  if (error instanceof AgentCapabilityUnavailableError) {
    return transportError(
      "AgentCapabilityUnavailableError",
      `Provider ${publicProviderId(error.providerId)} is currently unavailable.`,
      operation,
    )
  }
  if (error instanceof AgentPolicyEnforcementError) {
    return transportError(
      "AgentPolicyEnforcementError",
      `Provider ${publicProviderId(error.providerId)} cannot enforce DiffDash's required read-only policy.`,
      operation,
    )
  }
  if (error instanceof AgentProviderOperationError) {
    return publicProviderOperationError(error.providerId, error.cause, operation)
  }
  if (error instanceof AgentProviderProbeError) {
    return transportError(
      "AgentProviderProbeError",
      `DiffDash could not verify that provider ${publicProviderId(error.providerId)} is available.`,
      operation,
    )
  }
  if (error instanceof InvalidAgentProviderResponseError) {
    return transportError(
      "InvalidAgentProviderResponseError",
      `Provider ${publicProviderId(error.providerId)} completed without usable walkthrough text.`,
      operation,
    )
  }

  if (error instanceof MissingAgentProviderError) {
    return transportError(
      "MissingAgentProviderError",
      `Provider ${publicProviderId(error.providerId)} is not registered in this version of DiffDash.`,
      operation,
    )
  }
  if (error instanceof UnsupportedAgentCapabilityError) {
    return transportError(
      "UnsupportedAgentCapabilityError",
      `Provider ${publicProviderId(error.providerId)} does not support walkthrough generation.`,
      operation,
    )
  }
  if (error instanceof NoAgentProviderAvailableError) {
    return transportError(
      "NoAgentProviderAvailableError",
      "No configured AI provider is currently available for walkthrough generation.",
      operation,
    )
  }
  if (error instanceof WalkthroughModelUnavailableError) {
    return transportError(
      "WalkthroughModelUnavailableError",
      `Provider ${publicProviderId(error.providerId)} has no compatible selected model for walkthrough generation.`,
      operation,
    )
  }
  if (error instanceof WalkthroughGenerationError) {
    return transportError(
      "WalkthroughGenerationError",
      "The AI agent returned invalid walkthrough data after retrying.",
      operation,
    )
  }
  if (error instanceof WalkthroughValidationError) {
    return transportError(
      "WalkthroughValidationError",
      "The AI agent returned a walkthrough that did not pass validation after retrying.",
      operation,
    )
  }
  if (error instanceof WalkthroughPromptPreparationError) {
    return transportError("WalkthroughPromptPreparationError", error.message, operation)
  }
  if (error instanceof ReviewContextError) {
    return transportError("ReviewContextError", error.reason, operation)
  }
  if (error instanceof WalkthroughStoreError) {
    const message = error.operation.startsWith("get")
      ? "DiffDash could not read the walkthrough cache."
      : "DiffDash could not save the generated walkthrough."
    return transportError("WalkthroughStoreError", message, operation)
  }

  return toPublicIpcError(error, operation)
}

const publicProviderOperationError = (providerId: string, cause: unknown, operation: string) => {
  const provider = publicProviderId(providerId)
  const tag = taggedCause(cause)
  if (tag === "ProcessTimeoutError") {
    return transportError(
      "AgentProviderTimeoutError",
      `Provider ${provider} timed out during walkthrough generation.`,
      operation,
    )
  }
  if (tag === "ProcessSpawnError") {
    return transportError(
      "AgentProviderSpawnError",
      `DiffDash could not start provider ${provider}.`,
      operation,
    )
  }
  if (tag === "ProcessExitError") {
    return transportError(
      "AgentProviderExitError",
      `Provider ${provider} exited before completing the walkthrough.`,
      operation,
    )
  }
  if (tag === "ProcessOutputError" || tag === "ProcessStdinError") {
    return transportError(
      "AgentProviderIoError",
      `DiffDash could not exchange walkthrough data with provider ${provider}.`,
      operation,
    )
  }
  if (tag === "ProcessCleanupError") {
    return transportError(
      "AgentProviderCleanupError",
      `Provider ${provider} did not close cleanly after walkthrough generation.`,
      operation,
    )
  }
  return transportError(
    "AgentProviderOperationError",
    `Provider ${provider} could not complete walkthrough generation.`,
    operation,
  )
}

const publicProviderId = (providerId: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(providerId) ? providerId : "custom"

const taggedCause = (cause: unknown): string | null =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause["_tag"] === "string"
    ? cause["_tag"]
    : null
