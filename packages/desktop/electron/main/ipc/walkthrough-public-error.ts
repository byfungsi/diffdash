/* oxlint-disable eslint/no-underscore-dangle -- Effect errors use _tag discriminants. */
import {
  AgentCapabilityUnavailableError,
  AgentPolicyEnforcementError,
  AgentProviderId,
  AgentProviderOperationError,
  AgentProviderProbeError,
  InvalidAgentProviderResponseError,
  MissingAgentProviderError,
  UnsupportedAgentCapabilityError,
} from "@diffdash/agent-provider"
import { NoAgentProviderAvailableError } from "@diffdash/agent-provider/registry"
import { classifyProviderFailureText } from "@diffdash/agent-provider/runtime"
import {
  AgentProviderFailure,
  type AgentProviderFailureCategory,
} from "@diffdash/domain/provider-failure"
import {
  WalkthroughPromptPreparationError,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import {
  ProcessCleanupError,
  ProcessExitError,
  ProcessOutputError,
  ProcessSpawnError,
  ProcessStdinError,
  ProcessTimeoutError,
} from "@diffdash/process"
import { transportError, TransportErrorDiagnosticTrace } from "@diffdash/protocol/transport-error"
import { WalkthroughGenerationError, WalkthroughModelUnavailableError } from "@diffdash/walkthrough"
import { Either, Schema } from "effect"
import { ReviewContextError } from "@diffdash/core/legacy"
import { toPublicIpcError } from "./public-error"

const KnownProviderProcessFailure = Schema.Union(
  ProcessTimeoutError,
  ProcessSpawnError,
  ProcessExitError,
  ProcessOutputError,
  ProcessStdinError,
  ProcessCleanupError,
)

/** Adapts walkthrough failures to user-reportable diagnostics without exposing private causes. */
export const toPublicWalkthroughError = (error: unknown, operation: string) => {
  const capabilityUnavailable = Schema.decodeUnknownEither(AgentCapabilityUnavailableError)(error)
  if (Either.isRight(capabilityUnavailable)) {
    return transportError(
      "AgentCapabilityUnavailableError",
      `Provider ${publicProviderId(capabilityUnavailable.right.providerId)} is currently unavailable.`,
      operation,
      undefined,
      walkthroughProviderFailure(
        capabilityUnavailable.right.providerId,
        classifyProviderFailureText(capabilityUnavailable.right.reason) ?? "configuration",
      ),
    )
  }
  const policyFailure = Schema.decodeUnknownEither(AgentPolicyEnforcementError)(error)
  if (Either.isRight(policyFailure)) {
    return transportError(
      "AgentPolicyEnforcementError",
      `Provider ${publicProviderId(policyFailure.right.providerId)} cannot enforce DiffDash's required read-only policy.`,
      operation,
      undefined,
      walkthroughProviderFailure(policyFailure.right.providerId, "policy-violation"),
    )
  }
  const providerOperation = Schema.decodeUnknownEither(AgentProviderOperationError)(error)
  if (Either.isRight(providerOperation)) {
    return publicProviderOperationError(
      providerOperation.right,
      structuralCause(error),
      error,
      operation,
    )
  }
  const providerProbe = Schema.decodeUnknownEither(AgentProviderProbeError)(error)
  if (Either.isRight(providerProbe)) {
    return transportError(
      "AgentProviderProbeError",
      `DiffDash could not verify that provider ${publicProviderId(providerProbe.right.providerId)} is available.`,
      operation,
      undefined,
      walkthroughProviderFailure(providerProbe.right.providerId, "configuration"),
    )
  }
  const invalidProviderResponse = Schema.decodeUnknownEither(InvalidAgentProviderResponseError)(
    error,
  )
  if (Either.isRight(invalidProviderResponse)) {
    const failure = invalidResponseFailure(
      invalidProviderResponse.right.providerId,
      invalidProviderResponse.right.capability,
    )
    return transportError(
      "InvalidAgentProviderResponseError",
      `Provider ${publicProviderId(invalidProviderResponse.right.providerId)} completed without usable walkthrough text.`,
      operation,
      undefined,
      failure,
    )
  }
  const missingProvider = Schema.decodeUnknownEither(MissingAgentProviderError)(error)
  if (Either.isRight(missingProvider)) {
    return transportError(
      "MissingAgentProviderError",
      `Provider ${publicProviderId(missingProvider.right.providerId)} is not registered in this version of DiffDash.`,
      operation,
      undefined,
      walkthroughProviderFailure(missingProvider.right.providerId, "configuration"),
    )
  }
  const unsupportedCapability = Schema.decodeUnknownEither(UnsupportedAgentCapabilityError)(error)
  if (Either.isRight(unsupportedCapability)) {
    return transportError(
      "UnsupportedAgentCapabilityError",
      `Provider ${publicProviderId(unsupportedCapability.right.providerId)} does not support walkthrough generation.`,
      operation,
      undefined,
      walkthroughProviderFailure(unsupportedCapability.right.providerId, "configuration"),
    )
  }
  const noProvider = Schema.decodeUnknownEither(NoAgentProviderAvailableError)(error)
  if (Either.isRight(noProvider)) {
    return transportError(
      "NoAgentProviderAvailableError",
      "No configured AI provider is currently available for walkthrough generation.",
      operation,
      undefined,
      walkthroughProviderFailure("unavailable", "configuration"),
    )
  }
  const unavailableModel = Schema.decodeUnknownEither(WalkthroughModelUnavailableError)(error)
  if (Either.isRight(unavailableModel)) {
    return transportError(
      "WalkthroughModelUnavailableError",
      `Provider ${publicProviderId(unavailableModel.right.providerId)} has no compatible selected model for walkthrough generation.`,
      operation,
      undefined,
      walkthroughProviderFailure(unavailableModel.right.providerId, "model-unavailable"),
    )
  }
  if (Either.isRight(Schema.decodeUnknownEither(WalkthroughGenerationError)(error))) {
    return transportError(
      "WalkthroughGenerationError",
      "The AI agent returned invalid walkthrough data after retrying.",
      operation,
    )
  }
  if (Either.isRight(Schema.decodeUnknownEither(WalkthroughValidationError)(error))) {
    return transportError(
      "WalkthroughValidationError",
      "The AI agent returned a walkthrough that did not pass validation after retrying.",
      operation,
    )
  }
  const promptPreparation = Schema.decodeUnknownEither(WalkthroughPromptPreparationError)(error)
  if (Either.isRight(promptPreparation)) {
    return transportError(
      "WalkthroughPromptPreparationError",
      promptPreparation.right.message,
      operation,
    )
  }
  const reviewContext = Schema.decodeUnknownEither(ReviewContextError)(error)
  if (Either.isRight(reviewContext)) {
    return transportError("ReviewContextError", reviewContext.right.reason, operation)
  }
  const walkthroughStore = Schema.decodeUnknownEither(WalkthroughStoreError)(error)
  if (Either.isRight(walkthroughStore)) {
    const message = walkthroughStore.right.operation.startsWith("get")
      ? "DiffDash could not read the walkthrough cache."
      : "DiffDash could not save the generated walkthrough."
    return transportError("WalkthroughStoreError", message, operation)
  }

  const publicError = toPublicIpcError(error, operation)
  if (publicError.code !== "INTERNAL_ERROR") return publicError
  return transportError(
    "WALKTHROUGH_INTERNAL_ERROR",
    publicError.message,
    publicError.operation ?? operation,
    new TransportErrorDiagnosticTrace({
      provider: publicProviderId("unavailable"),
      errorTag: "WalkthroughInternalError",
      causeTag: errorName(error),
      exitCode: null,
      signal: null,
      reason: "Unexpected walkthrough failure.",
      stderr: "No provider diagnostics were emitted.",
      stackFrames: sanitizedInternalStackFrames(error),
    }),
  )
}

const publicProviderOperationError = (
  error: AgentProviderOperationError,
  cause: unknown,
  stackSource: unknown,
  operation: string,
) => {
  const provider = publicProviderId(error.providerId)
  const processFailure = Schema.decodeUnknownEither(KnownProviderProcessFailure)(cause)
  const causeTag = Either.isRight(processFailure) ? processFailure.right._tag : taggedCause(cause)
  const diagnostic = Either.isRight(processFailure)
    ? publicProcessDiagnostic(error, processFailure.right, stackSource, cause)
    : undefined
  const publicFailure = AgentProviderFailure.make({ ...error.failure })
  const typed = providerFailurePresentation(
    error.failure.category,
    provider,
    "walkthrough generation",
  )
  if (typed !== null) {
    return transportError(typed.code, typed.message, operation, diagnostic, publicFailure)
  }
  if (causeTag === "ProcessTimeoutError") {
    return transportError(
      "AgentProviderTimeoutError",
      `Provider ${provider} timed out during walkthrough generation.`,
      operation,
      diagnostic,
      publicFailure,
    )
  }
  if (causeTag === "ProcessSpawnError") {
    return transportError(
      "AgentProviderSpawnError",
      `DiffDash could not start provider ${provider}.`,
      operation,
      diagnostic,
      publicFailure,
    )
  }
  if (causeTag === "ProcessExitError") {
    return transportError(
      "AgentProviderExitError",
      `Provider ${provider} exited before completing the walkthrough.`,
      operation,
      diagnostic,
      publicFailure,
    )
  }
  if (causeTag === "ProcessOutputError" || causeTag === "ProcessStdinError") {
    return transportError(
      "AgentProviderIoError",
      `DiffDash could not exchange walkthrough data with provider ${provider}.`,
      operation,
      diagnostic,
      publicFailure,
    )
  }
  if (causeTag === "ProcessCleanupError") {
    return transportError(
      "AgentProviderCleanupError",
      `Provider ${provider} did not close cleanly after walkthrough generation.`,
      operation,
      diagnostic,
      publicFailure,
    )
  }
  return transportError(
    "AgentProviderOperationError",
    `Provider ${provider} could not complete walkthrough generation.`,
    operation,
    diagnostic,
    publicFailure,
  )
}

/** Maps a safe provider failure category to bounded user-facing transport copy. */
export const providerFailurePresentation = (
  category: AgentProviderFailureCategory,
  provider: AgentProviderId,
  task: "walkthrough generation" | "review response",
): { readonly code: string; readonly message: string } | null => {
  if (provider === "unavailable") {
    return {
      code: "NoAgentProviderAvailableError",
      message: "No configured AI provider is currently available.",
    }
  }
  switch (category) {
    case "authentication":
      return {
        code: "AgentProviderAuthenticationError",
        message: `Provider ${provider} authentication failed or expired. Sign in again, then retry.`,
      }
    case "authorization":
      return {
        code: "AgentProviderAuthorizationError",
        message: `Provider ${provider} denied access to the requested operation or model.`,
      }
    case "rate-limited":
      return {
        code: "AgentProviderRateLimitError",
        message: `Provider ${provider} is temporarily rate limited. Wait briefly, then retry.`,
      }
    case "usage-limited":
      return {
        code: "AgentProviderUsageLimitError",
        message: `Provider ${provider} reached a session or usage limit. Retry after the limit resets.`,
      }
    case "quota-exhausted":
      return {
        code: "AgentProviderQuotaError",
        message: `Provider ${provider} reached an account quota or billing limit.`,
      }
    case "timeout":
      return {
        code: "AgentProviderTimeoutError",
        message: `Provider ${provider} timed out while producing the ${task}.`,
      }
    case "network":
      return {
        code: "AgentProviderNetworkError",
        message: `Provider ${provider} could not connect to its service. Check the network, then retry.`,
      }
    case "model-unavailable":
      return {
        code: "AgentProviderModelUnavailableError",
        message: `Provider ${provider} could not use the selected model.`,
      }
    case "provider-unavailable":
      return {
        code: "AgentProviderUnavailableError",
        message: `Provider ${provider} is temporarily unavailable. Retry shortly.`,
      }
    case "configuration":
      return {
        code: "AgentProviderConfigurationError",
        message: `Provider ${provider} is not configured correctly for this operation.`,
      }
    case "invalid-response":
      return {
        code: "InvalidAgentProviderResponseError",
        message: `Provider ${provider} completed without a usable ${task}.`,
      }
    case "policy-violation":
      return {
        code: "AgentProviderPolicyError",
        message: `Provider ${provider} could not satisfy DiffDash's read-only execution policy.`,
      }
    case "process-failure":
    case "unknown":
      return null
  }
}

const publicProcessDiagnostic = (
  error: AgentProviderOperationError,
  cause: typeof KnownProviderProcessFailure.Type,
  stackSource: unknown,
  causeStackSource: unknown,
) =>
  new TransportErrorDiagnosticTrace({
    provider: publicProviderId(error.providerId),
    errorTag: error._tag,
    causeTag: cause._tag,
    exitCode: cause.exitCode,
    signal: cause.signal === null ? null : safeDiagnosticTag(cause.signal, "unknown"),
    reason: publicProviderDiagnostic(error.failure.category),
    stderr: publicProviderDiagnostic(error.failure.category),
    stackFrames: sanitizedInternalStackFrames(stackSource, causeStackSource),
  })

const publicProviderId = (providerId: string): AgentProviderId =>
  AgentProviderId.make(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(providerId) ? providerId : "custom")

const walkthroughProviderFailure = (providerId: string, category: AgentProviderFailureCategory) =>
  AgentProviderFailure.make({
    version: 1,
    providerId: publicProviderId(providerId),
    capability: "walkthrough",
    category,
    processKind: null,
    exitCode: null,
    signal: null,
    httpStatus: null,
    retryAfterSeconds: null,
    resetsAt: null,
  })

const taggedCause = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? safeDiagnosticTag(cause._tag, "UnknownCause")
    : null

const structuralCause = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined

const publicProviderDiagnostic = (category: AgentProviderFailureCategory) => {
  if (category === "authentication" || category === "authorization") {
    return "Authentication or authorization failure reported." as const
  }
  if (
    category === "rate-limited" ||
    category === "usage-limited" ||
    category === "quota-exhausted"
  ) {
    return "Rate limit or quota failure reported." as const
  }
  if (category === "network" || category === "provider-unavailable" || category === "timeout") {
    return "Network or connection failure reported." as const
  }
  return "Provider diagnostics were redacted." as const
}

const invalidResponseFailure = (providerId: string, capability: "walkthrough" | "review-thread") =>
  AgentProviderFailure.make({
    version: 1,
    providerId: publicProviderId(providerId),
    capability,
    category: "invalid-response",
    processKind: null,
    exitCode: null,
    signal: null,
    httpStatus: null,
    retryAfterSeconds: null,
    resetsAt: null,
  })

const sanitizedInternalStackFrames = (...errors: readonly unknown[]): readonly string[] => {
  const frames: string[] = []
  for (const error of errors) {
    const stack =
      typeof error === "object" &&
      error !== null &&
      "stack" in error &&
      typeof error.stack === "string"
        ? error.stack
        : ""
    for (const line of stack.split("\n").slice(1)) {
      const match = /^\s*at\s+(?:(?:async|new)\s+)?([A-Za-z_$][A-Za-z0-9_$.<>-]*)/u.exec(line)
      if (match?.[1] === undefined || match[1] === "file") continue
      const frame = `at ${match[1]}`
      if (!frames.includes(frame)) frames.push(frame)
      if (frames.length === 8) return frames
    }
  }
  return frames
}

const safeDiagnosticTag = (value: string, fallback: string): string =>
  /^[A-Za-z0-9._:-]{1,100}$/u.test(value) ? value : fallback

const errorName = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? safeDiagnosticTag(error.name, "UnknownCause")
    : "UnknownCause"
