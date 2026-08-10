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
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import {
  WalkthroughPromptPreparationError,
  WalkthroughValidationError,
} from "@diffdash/domain/walkthrough"
import { WalkthroughStoreError } from "@diffdash/persistence/walkthrough-store"
import { WalkthroughOperationStoreError } from "@diffdash/persistence/walkthrough-operation-store"
import {
  ProcessCleanupError,
  ProcessExitError,
  ProcessOutputError,
  ProcessSpawnError,
  ProcessStdinError,
  ProcessTimeoutError,
} from "@diffdash/process"
import { transportError, TransportErrorDiagnosticTrace } from "@diffdash/protocol/transport-error"
import {
  WalkthroughGenerationError,
  WalkthroughModelUnavailableError,
} from "@diffdash/agents/walkthrough"
import { Match, Option, Predicate, Result, Schema } from "effect"
import {
  ReviewContextError,
  WalkthroughOperationArtifactUnavailable,
  WalkthroughOperationCancelled,
  WalkthroughOperationInterrupted,
  WalkthroughOperationNotFound,
  WalkthroughOperationStateUnavailable,
  WalkthroughOperationSuperseded,
  WalkthroughOperationTerminalFailure,
} from "@diffdash/core"
import { toPublicIpcError } from "./public-error"

const KnownProviderProcessFailure = Schema.Union([
  ProcessTimeoutError,
  ProcessSpawnError,
  ProcessExitError,
  ProcessOutputError,
  ProcessStdinError,
  ProcessCleanupError,
])
type TransportFailure = Schema.Json | object | bigint | symbol | undefined

/** Adapts walkthrough failures to user-reportable diagnostics without exposing private causes. */
export const toPublicWalkthroughError = <A>(input: A, operation: string) => {
  const error = toTransportFailure(input)
  if (Schema.is(AgentCapabilityUnavailableError)(error)) {
    return transportError(
      "AgentCapabilityUnavailableError",
      `Provider ${publicProviderId(error.providerId)} is currently unavailable.`,
      operation,
      undefined,
      walkthroughProviderFailure(
        error.providerId,
        classifyProviderFailureText(error.reason) ?? "configuration",
      ),
    )
  }
  if (Schema.is(AgentPolicyEnforcementError)(error)) {
    return transportError(
      "AgentPolicyEnforcementError",
      `Provider ${publicProviderId(error.providerId)} cannot enforce DiffDash's required read-only policy.`,
      operation,
      undefined,
      walkthroughProviderFailure(error.providerId, "policy-violation"),
    )
  }
  const providerOperation = parseProviderOperationError(error)
  if (providerOperation !== null) {
    return publicProviderOperationError(providerOperation, structuralCause(error), error, operation)
  }
  if (Schema.is(AgentProviderProbeError)(error)) {
    return transportError(
      "AgentProviderProbeError",
      `DiffDash could not verify that provider ${publicProviderId(error.providerId)} is available.`,
      operation,
      undefined,
      walkthroughProviderFailure(error.providerId, "configuration"),
    )
  }
  if (Schema.is(InvalidAgentProviderResponseError)(error)) {
    const failure = invalidResponseFailure(error.providerId, error.capability)
    return transportError(
      "InvalidAgentProviderResponseError",
      `Provider ${publicProviderId(error.providerId)} completed without usable walkthrough text.`,
      operation,
      undefined,
      failure,
    )
  }
  if (Schema.is(MissingAgentProviderError)(error)) {
    return transportError(
      "MissingAgentProviderError",
      `Provider ${publicProviderId(error.providerId)} is not registered in this version of DiffDash.`,
      operation,
      undefined,
      walkthroughProviderFailure(error.providerId, "configuration"),
    )
  }
  if (Schema.is(UnsupportedAgentCapabilityError)(error)) {
    return transportError(
      "UnsupportedAgentCapabilityError",
      `Provider ${publicProviderId(error.providerId)} does not support walkthrough generation.`,
      operation,
      undefined,
      walkthroughProviderFailure(error.providerId, "configuration"),
    )
  }
  if (Schema.is(NoAgentProviderAvailableError)(error)) {
    return transportError(
      "NoAgentProviderAvailableError",
      "No configured AI provider is currently available for walkthrough generation.",
      operation,
      undefined,
      walkthroughProviderFailure("unavailable", "configuration"),
    )
  }
  if (Schema.is(WalkthroughModelUnavailableError)(error)) {
    return transportError(
      "WalkthroughModelUnavailableError",
      `Provider ${publicProviderId(error.providerId)} has no compatible selected model for walkthrough generation.`,
      operation,
      undefined,
      walkthroughProviderFailure(error.providerId, "model-unavailable"),
    )
  }
  if (Schema.is(WalkthroughGenerationError)(error)) {
    return transportError(
      "WalkthroughGenerationError",
      "The AI agent returned invalid walkthrough data after retrying.",
      operation,
    )
  }
  if (Schema.is(WalkthroughValidationError)(error)) {
    return transportError(
      "WalkthroughValidationError",
      "The AI agent returned a walkthrough that did not pass validation after retrying.",
      operation,
    )
  }
  if (Schema.is(WalkthroughPromptPreparationError)(error)) {
    return transportError("WalkthroughPromptPreparationError", error.message, operation)
  }
  if (Schema.is(ReviewContextError)(error)) {
    return transportError("ReviewContextError", error.reason, operation)
  }
  if (Schema.is(WalkthroughStoreError)(error)) {
    const message = error.operation.startsWith("get")
      ? "DiffDash could not read the walkthrough cache."
      : "DiffDash could not save the generated walkthrough."
    return transportError("WalkthroughStoreError", message, operation)
  }
  if (Schema.is(WalkthroughOperationStoreError)(error)) {
    return transportError(
      "WALKTHROUGH_OPERATION_STORE",
      "DiffDash could not persist walkthrough operation state.",
      operation,
    )
  }
  if (Schema.is(WalkthroughOperationTerminalFailure)(error)) {
    return persistedWalkthroughFailure(error, operation)
  }
  if (Schema.is(WalkthroughOperationNotFound)(error)) {
    return transportError(
      "WALKTHROUGH_OPERATION_NOT_FOUND",
      "DiffDash could not find the requested walkthrough operation.",
      operation,
    )
  }
  if (Schema.is(WalkthroughOperationArtifactUnavailable)(error)) {
    return transportError(
      "WALKTHROUGH_STORE",
      "DiffDash could not load the completed walkthrough.",
      operation,
    )
  }
  if (Schema.is(WalkthroughOperationStateUnavailable)(error)) {
    return transportError(
      "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE",
      "DiffDash could not reconcile the walkthrough operation with the current Core process.",
      operation,
    )
  }
  if (Schema.is(WalkthroughOperationCancelled)(error)) {
    return transportError(
      "WALKTHROUGH_CANCELLED",
      "Walkthrough generation was cancelled.",
      operation,
    )
  }
  if (Schema.is(WalkthroughOperationSuperseded)(error)) {
    return transportError(
      "WALKTHROUGH_SUPERSEDED",
      "A newer walkthrough generation replaced this operation.",
      operation,
    )
  }
  if (Schema.is(WalkthroughOperationInterrupted)(error)) {
    return transportError(
      "WALKTHROUGH_INTERRUPTED",
      "Walkthrough generation was interrupted when DiffDash restarted. Retry to generate it again.",
      operation,
    )
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

const persistedWalkthroughFailure = (
  error: WalkthroughOperationTerminalFailure,
  operation: string,
) => {
  switch (error.failure.category) {
    case "review-resolution":
      return transportError(
        "WALKTHROUGH_REVIEW_RESOLUTION",
        "DiffDash could not resolve the review generation for this walkthrough.",
        operation,
      )
    case "prompt-preparation":
      return transportError(
        "WALKTHROUGH_PROMPT_PREPARATION",
        "DiffDash could not prepare this review for walkthrough generation.",
        operation,
      )
    case "provider":
      return transportError(
        "WALKTHROUGH_PROVIDER_ERROR",
        "The configured AI provider could not complete walkthrough generation.",
        operation,
      )
    case "validation":
      return transportError(
        "WALKTHROUGH_VALIDATION",
        "The AI provider returned walkthrough data that did not pass validation.",
        operation,
      )
    case "artifact-persistence":
      return transportError(
        "WALKTHROUGH_STORE",
        "DiffDash could not save the generated walkthrough.",
        operation,
      )
    case "operation-persistence":
      return transportError(
        "WALKTHROUGH_OPERATION_STORE",
        "DiffDash could not persist walkthrough operation state.",
        operation,
      )
    case "internal":
      return transportError(
        "WALKTHROUGH_INTERNAL_ERROR",
        "DiffDash could not complete the walkthrough because of an internal error.",
        operation,
      )
  }
}

const publicProviderOperationError = (
  error: AgentProviderOperationError,
  cause: TransportFailure,
  stackSource: TransportFailure,
  operation: string,
) => {
  const provider = publicProviderId(error.providerId)
  const processFailure = parseKnownProviderProcessFailure(cause)
  const causeTag = Match.value(processFailure).pipe(
    Match.when(null, () => taggedCause(cause)),
    Match.when(Schema.is(ProcessTimeoutError), () => "ProcessTimeoutError"),
    Match.when(Schema.is(ProcessSpawnError), () => "ProcessSpawnError"),
    Match.when(Schema.is(ProcessExitError), () => "ProcessExitError"),
    Match.when(Schema.is(ProcessOutputError), () => "ProcessOutputError"),
    Match.when(Schema.is(ProcessStdinError), () => "ProcessStdinError"),
    Match.when(Schema.is(ProcessCleanupError), () => "ProcessCleanupError"),
    Match.orElse(() => taggedCause(cause)),
  )
  const diagnostic =
    processFailure === null
      ? undefined
      : publicProcessDiagnostic(error, processFailure, stackSource, cause)
  const publicFailure = AgentProviderFailure.make({
    ...error.failure,
    providerId: publicReviewAgentProviderId(error.failure.providerId),
  })
  const typed = providerFailurePresentation(
    error.failure.category,
    provider,
    "walkthrough generation",
  )
  if (typed !== null) {
    return transportError(typed.code, typed.message, operation, diagnostic, publicFailure)
  }
  return Match.value(causeTag).pipe(
    Match.when("ProcessTimeoutError", () =>
      transportError(
        "AgentProviderTimeoutError",
        `Provider ${provider} timed out during walkthrough generation.`,
        operation,
        diagnostic,
        publicFailure,
      ),
    ),
    Match.when("ProcessSpawnError", () =>
      transportError(
        "AgentProviderSpawnError",
        `DiffDash could not start provider ${provider}.`,
        operation,
        diagnostic,
        publicFailure,
      ),
    ),
    Match.when("ProcessExitError", () =>
      transportError(
        "AgentProviderExitError",
        `Provider ${provider} exited before completing the walkthrough.`,
        operation,
        diagnostic,
        publicFailure,
      ),
    ),
    Match.whenOr("ProcessOutputError", "ProcessStdinError", () =>
      transportError(
        "AgentProviderIoError",
        `DiffDash could not exchange walkthrough data with provider ${provider}.`,
        operation,
        diagnostic,
        publicFailure,
      ),
    ),
    Match.when("ProcessCleanupError", () =>
      transportError(
        "AgentProviderCleanupError",
        `Provider ${provider} did not close cleanly after walkthrough generation.`,
        operation,
        diagnostic,
        publicFailure,
      ),
    ),
    Match.orElse(() =>
      transportError(
        "AgentProviderOperationError",
        `Provider ${provider} could not complete walkthrough generation.`,
        operation,
        diagnostic,
        publicFailure,
      ),
    ),
  )
}

const parseProviderOperationError = (
  input: TransportFailure,
): AgentProviderOperationError | null => {
  if (Schema.is(AgentProviderOperationError)(input)) return input
  return Result.getOrNull(Schema.decodeUnknownResult(AgentProviderOperationError)(input))
}

const parseKnownProviderProcessFailure = (
  input: TransportFailure,
): typeof KnownProviderProcessFailure.Type | null => {
  if (Schema.is(KnownProviderProcessFailure)(input)) return input
  return Result.getOrNull(Schema.decodeUnknownResult(KnownProviderProcessFailure)(input))
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
  stackSource: TransportFailure,
  causeStackSource: TransportFailure,
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

const publicReviewAgentProviderId = (providerId: string) =>
  ReviewAgentProviderId.make(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(providerId) ? providerId : "custom",
  )

const walkthroughProviderFailure = (providerId: string, category: AgentProviderFailureCategory) =>
  AgentProviderFailure.make({
    version: 1,
    providerId: publicReviewAgentProviderId(providerId),
    capability: "walkthrough",
    category,
    processKind: null,
    exitCode: null,
    signal: null,
    httpStatus: null,
    retryAfterSeconds: null,
    resetsAt: null,
  })

const taggedCause = (cause: TransportFailure): string | null => {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))(cause)
  const value = Option.getOrNull(decoded)
  return value === null ? null : safeDiagnosticTag(value._tag, "UnknownCause")
}

const structuralCause = (error: TransportFailure): TransportFailure => {
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ cause: Schema.Union([Schema.Json, Schema.ErrorInstance()]) }),
  )(error)
  return Option.getOrNull(decoded)?.cause
}

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
    providerId: publicReviewAgentProviderId(providerId),
    capability,
    category: "invalid-response",
    processKind: null,
    exitCode: null,
    signal: null,
    httpStatus: null,
    retryAfterSeconds: null,
    resetsAt: null,
  })

const sanitizedInternalStackFrames = (
  ...errors: readonly TransportFailure[]
): readonly string[] => {
  const frames: string[] = []
  for (const error of errors) {
    const stack = Schema.is(Schema.ErrorInstance())(error) ? (error.stack ?? "") : ""
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

const errorName = (error: TransportFailure): string =>
  Schema.is(Schema.ErrorInstance())(error)
    ? safeDiagnosticTag(error.name, "UnknownCause")
    : "UnknownCause"

const toTransportFailure = <A>(error: A): TransportFailure =>
  Schema.is(Schema.Json)(error) ||
  Schema.is(Schema.ErrorInstance())(error) ||
  Predicate.isObject(error)
    ? error
    : undefined
