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
import { ReviewContextError } from "../../../src/main/services/review-context"
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
    )
  }
  const policyFailure = Schema.decodeUnknownEither(AgentPolicyEnforcementError)(error)
  if (Either.isRight(policyFailure)) {
    return transportError(
      "AgentPolicyEnforcementError",
      `Provider ${publicProviderId(policyFailure.right.providerId)} cannot enforce DiffDash's required read-only policy.`,
      operation,
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
    )
  }
  const invalidProviderResponse = Schema.decodeUnknownEither(InvalidAgentProviderResponseError)(
    error,
  )
  if (Either.isRight(invalidProviderResponse)) {
    return transportError(
      "InvalidAgentProviderResponseError",
      `Provider ${publicProviderId(invalidProviderResponse.right.providerId)} completed without usable walkthrough text.`,
      operation,
    )
  }
  const missingProvider = Schema.decodeUnknownEither(MissingAgentProviderError)(error)
  if (Either.isRight(missingProvider)) {
    return transportError(
      "MissingAgentProviderError",
      `Provider ${publicProviderId(missingProvider.right.providerId)} is not registered in this version of DiffDash.`,
      operation,
    )
  }
  const unsupportedCapability = Schema.decodeUnknownEither(UnsupportedAgentCapabilityError)(error)
  if (Either.isRight(unsupportedCapability)) {
    return transportError(
      "UnsupportedAgentCapabilityError",
      `Provider ${publicProviderId(unsupportedCapability.right.providerId)} does not support walkthrough generation.`,
      operation,
    )
  }
  const noProvider = Schema.decodeUnknownEither(NoAgentProviderAvailableError)(error)
  if (Either.isRight(noProvider)) {
    return transportError(
      "NoAgentProviderAvailableError",
      "No configured AI provider is currently available for walkthrough generation.",
      operation,
    )
  }
  const unavailableModel = Schema.decodeUnknownEither(WalkthroughModelUnavailableError)(error)
  if (Either.isRight(unavailableModel)) {
    return transportError(
      "WalkthroughModelUnavailableError",
      `Provider ${publicProviderId(unavailableModel.right.providerId)} has no compatible selected model for walkthrough generation.`,
      operation,
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
  if (causeTag === "ProcessTimeoutError") {
    return transportError(
      "AgentProviderTimeoutError",
      `Provider ${provider} timed out during walkthrough generation.`,
      operation,
      diagnostic,
    )
  }
  if (causeTag === "ProcessSpawnError") {
    return transportError(
      "AgentProviderSpawnError",
      `DiffDash could not start provider ${provider}.`,
      operation,
      diagnostic,
    )
  }
  if (causeTag === "ProcessExitError") {
    return transportError(
      "AgentProviderExitError",
      `Provider ${provider} exited before completing the walkthrough.`,
      operation,
      diagnostic,
    )
  }
  if (causeTag === "ProcessOutputError" || causeTag === "ProcessStdinError") {
    return transportError(
      "AgentProviderIoError",
      `DiffDash could not exchange walkthrough data with provider ${provider}.`,
      operation,
      diagnostic,
    )
  }
  if (causeTag === "ProcessCleanupError") {
    return transportError(
      "AgentProviderCleanupError",
      `Provider ${provider} did not close cleanly after walkthrough generation.`,
      operation,
      diagnostic,
    )
  }
  return transportError(
    "AgentProviderOperationError",
    `Provider ${provider} could not complete walkthrough generation.`,
    operation,
  )
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
    reason: publicProviderDiagnostic(error.reason),
    stderr: publicProviderDiagnostic(cause.stderr),
    stackFrames: sanitizedInternalStackFrames(stackSource, causeStackSource),
  })

const publicProviderId = (providerId: string): AgentProviderId =>
  AgentProviderId.make(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(providerId) ? providerId : "custom")

const taggedCause = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? safeDiagnosticTag(cause._tag, "UnknownCause")
    : null

const structuralCause = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined

const publicProviderDiagnostic = (value: string) => {
  if (value.trim().length === 0) return "No provider diagnostics were emitted." as const
  if (
    /\b(?:auth(?:entication|orization)?|credentials?|forbidden|login|sign[ -]?in|unauthorized)\b/iu.test(
      value,
    )
  ) {
    return "Authentication or authorization failure reported." as const
  }
  if (/\b(?:429|quota|rate[ -]?limit|too many requests)\b/iu.test(value)) {
    return "Rate limit or quota failure reported." as const
  }
  if (
    /\b(?:connect(?:ion|ivity)?|dns|network|offline|socket|timed?[ -]?out|timeout)\b/iu.test(value)
  ) {
    return "Network or connection failure reported." as const
  }
  return "Provider diagnostics were redacted." as const
}

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
