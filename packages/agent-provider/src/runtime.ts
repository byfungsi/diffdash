import { Effect, Match, Predicate } from "effect"

import {
  AgentCapabilityPolicyUnsupported,
  AgentCapabilityReady,
  AgentCapabilityUnavailable,
  type AgentCapability,
  type AgentCapabilityProbe,
  AgentProviderFailure,
  type AgentProviderCause,
  type AgentProviderDiagnosticCause,
  type AgentProviderFailureCategory,
  AgentProviderId,
  AgentProviderOperationError,
  type AgentProviderProcessFailureKind,
} from "./agent-provider"
import { type ProviderDiagnosticExtraRedaction, sanitizeProviderDiagnostic } from "./security"

export type { AgentProviderFailureCategory } from "./agent-provider"

type ProviderFailureInput = Parameters<typeof JSON.stringify>[0]

/** Default maximum persisted or displayed length of a provider failure reason. */
export const DEFAULT_PROVIDER_REASON_MAX_LENGTH = 600

/** Successful provider runtime probe before capability projection. */
export interface AgentRuntimeProbeReady {
  readonly status: "ready"
  readonly version: string | null
}

/** Unsuccessful provider runtime probe before capability projection. */
export interface AgentRuntimeProbeUnavailable {
  readonly status: "unavailable"
  readonly reason: string
}

/** Provider runtime status shared by every declared capability. */
export type AgentRuntimeProbeResult = AgentRuntimeProbeReady | AgentRuntimeProbeUnavailable

/** Inputs for a provider-owned version command projected into a shared runtime status. */
export interface ProbeAgentRuntimeOptions<E, R> {
  readonly versionOutput: Effect.Effect<string, E, R>
  readonly unavailableReason: string
  readonly extraRedaction?: ProviderDiagnosticExtraRedaction
}

/** Options for constructing one provider's bounded operation errors. */
export interface AgentProviderOperationErrorFactoryOptions {
  readonly providerId: AgentProviderId
  readonly fallbackReason: string
  readonly extraRedaction?: ProviderDiagnosticExtraRedaction
  readonly classify?: (
    cause: AgentProviderCause,
    reason: string,
  ) => AgentProviderFailureCategory | null
}

/** Cohesive constructors for cause-backed and reason-only provider operation errors. */
export interface AgentProviderOperationErrorFactory {
  readonly fromCause: (
    capability: AgentCapability,
    category?: AgentProviderFailureCategory,
  ) => (cause: ProviderFailureInput) => AgentProviderOperationError
  readonly fromReason: (
    capability: AgentCapability,
    reason: string,
    category?: AgentProviderFailureCategory,
  ) => AgentProviderOperationError
}

/** Extracts a bounded runtime version from provider command output. */
export const parseAgentRuntimeVersion = (output: string) => {
  const value = output.trim()
  if (value.length === 0) return null
  const match = /(?:^|\s)v?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)(?:\s|$)/u.exec(value)
  return match?.[1] ?? value.slice(0, 100)
}

/** Extracts a provider failure reason and applies the provider's diagnostic redaction policy. */
export const boundedProviderReason = (
  value: ProviderFailureInput,
  fallback: string,
  extraRedaction?: ProviderDiagnosticExtraRedaction,
  maximumLength = DEFAULT_PROVIDER_REASON_MAX_LENGTH,
) => {
  const cause = parseAgentProviderCause(value)
  let reason = fallback
  if (
    isDiagnosticCause(cause) &&
    Predicate.isString(cause.stderr) &&
    cause.stderr.trim().length > 0
  ) {
    reason = cause.stderr
  } else if (
    isDiagnosticCause(cause) &&
    Predicate.isString(cause.reason) &&
    cause.reason.trim().length > 0
  ) {
    reason = cause.reason
  } else if (isGenericProcessSpawnFailure(cause)) {
    reason = fallback
  } else if (Predicate.isError(cause) && cause.message.trim().length > 0) {
    reason = cause.message
  }
  return boundedProviderDiagnostic(reason, extraRedaction, maximumLength)
}

const isGenericProcessSpawnFailure = (cause: AgentProviderCause) => {
  const message = Predicate.isError(cause)
    ? cause.message
    : isDiagnosticCause(cause)
      ? (cause.message ?? null)
      : null
  return message !== null && message.trim().toLowerCase() === "failed to spawn command"
}

/** Sanitizes and bounds a provider-owned diagnostic string. */
export const boundedProviderDiagnostic = (
  value: string,
  extraRedaction?: ProviderDiagnosticExtraRedaction,
  maximumLength = DEFAULT_PROVIDER_REASON_MAX_LENGTH,
): string => {
  const limit =
    Number.isSafeInteger(maximumLength) && maximumLength > 0
      ? maximumLength
      : DEFAULT_PROVIDER_REASON_MAX_LENGTH
  return sanitizeProviderDiagnostic(value, extraRedaction).slice(-limit)
}

/** Classifies provider-owned text without retaining the source text in public data. */
export const classifyProviderFailureText = (value: string): AgentProviderFailureCategory | null => {
  if (/\b(?:429|rate[ -]?limit(?:ed)?|too many requests|throttl(?:e|ed|ing))\b/iu.test(value)) {
    return "rate-limited"
  }
  if (
    /\b(?:session|daily|weekly|monthly|usage)\s+(?:cap|limit)|(?:cap|limit)\s+(?:reached|resets?)\b/iu.test(
      value,
    )
  ) {
    return "usage-limited"
  }
  if (/\b(?:billing|credits?|payment required|spend(?:ing)?\s+limit|quota)\b/iu.test(value)) {
    return "quota-exhausted"
  }
  if (
    /\b(?:auth|authenticate(?:d)?|authentication|credentials?|login|sign[ -]?in|oauth|unauthorized|401)\b/iu.test(
      value,
    )
  ) {
    return "authentication"
  }
  if (
    /\b(?:authorization|authorized|forbidden|permission denied|access denied|not authorized|403)\b/iu.test(
      value,
    )
  ) {
    return "authorization"
  }
  if (/\b(?:model).*(?:not found|unavailable|unsupported|access)\b/iu.test(value)) {
    return "model-unavailable"
  }
  if (
    /\b(?:connect(?:ion|ivity)?|dns|network|offline|socket|econn(?:refused|reset)|enotfound)\b/iu.test(
      value,
    )
  ) {
    return "network"
  }
  if (
    /\b(?:service unavailable|temporarily unavailable|overloaded|bad gateway|502|503|504)\b/iu.test(
      value,
    )
  ) {
    return "provider-unavailable"
  }
  if (/\b(?:timed?[ -]?out|timeout)\b/iu.test(value)) {
    return "timeout"
  }
  if (
    /\b(?:configuration|config|invalid option|unknown (?:argument|flag|option))\b/iu.test(value)
  ) {
    return "configuration"
  }
  return null
}

const processKind = (cause: AgentProviderCause): AgentProviderProcessFailureKind | null => {
  const tag = taggedString(cause, "_tag")
  return Match.value(tag).pipe(
    Match.when("InvalidProcessOptionsError", () => "options" as const),
    Match.when("ProcessSpawnError", () => "spawn" as const),
    Match.when("ProcessStdinError", () => "stdin" as const),
    Match.when("ProcessOutputError", () => "output" as const),
    Match.when("ProcessTimeoutError", () => "timeout" as const),
    Match.when("ProcessCleanupError", () => "cleanup" as const),
    Match.when("ProcessExitError", () => "exit" as const),
    Match.orElse(() => null),
  )
}

const classificationText = (cause: AgentProviderCause, reason: string) => {
  if (Predicate.isNull(cause)) return reason
  if (!isDiagnosticCause(cause)) return reason
  return [cause.stdout, cause.stderr, cause.reason, cause.message, reason]
    .filter(Predicate.isString)
    .join("\n")
}

const taggedString = (value: AgentProviderCause, key: "_tag" | "signal"): string | null => {
  if (Predicate.isNull(value) || !isDiagnosticCause(value)) return null
  return value[key] ?? null
}

const taggedInteger = (
  value: AgentProviderCause,
  key: "status" | "statusCode" | "exitCode",
): number | null => {
  if (Predicate.isNull(value) || !isDiagnosticCause(value)) return null
  const selected =
    key === "status" ? value.status : key === "statusCode" ? value.statusCode : value.exitCode
  return Predicate.isNumber(selected) && Number.isSafeInteger(selected) ? selected : null
}

const safeProviderId = (providerId: AgentProviderId) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(providerId)
    ? providerId
    : AgentProviderId.make("custom")

const makeFailure = (
  options: AgentProviderOperationErrorFactoryOptions,
  capability: AgentCapability,
  cause: AgentProviderCause,
  reason: string,
  category?: AgentProviderFailureCategory,
) => {
  const processFailure = processKind(cause)
  const httpStatus = taggedInteger(cause, "status") ?? taggedInteger(cause, "statusCode")
  const statusCategory =
    httpStatus === 401
      ? "authentication"
      : httpStatus === 402
        ? "quota-exhausted"
        : httpStatus === 403
          ? "authorization"
          : httpStatus === 408
            ? "timeout"
            : httpStatus === 429
              ? "rate-limited"
              : httpStatus !== null && httpStatus >= 500
                ? "provider-unavailable"
                : null
  const classified =
    category ??
    options.classify?.(cause, reason) ??
    statusCategory ??
    classifyProviderFailureText(classificationText(cause, reason))
  return AgentProviderFailure.make({
    version: 1,
    providerId: safeProviderId(options.providerId),
    capability,
    category:
      classified ??
      (processFailure === "timeout"
        ? "timeout"
        : processFailure === null
          ? "unknown"
          : "process-failure"),
    processKind: processFailure,
    exitCode: taggedInteger(cause, "exitCode"),
    signal: taggedString(cause, "signal"),
    httpStatus,
    retryAfterSeconds: null,
    resetsAt: null,
  })
}

/** Probes one provider version command and converts expected command failures to unavailable status. */
export const probeAgentRuntime = <E, R>(
  options: ProbeAgentRuntimeOptions<E, R>,
): Effect.Effect<AgentRuntimeProbeResult, never, R> =>
  options.versionOutput.pipe(
    Effect.map(
      (output): AgentRuntimeProbeResult => ({
        status: "ready",
        version: parseAgentRuntimeVersion(output),
      }),
    ),
    Effect.catch((cause) =>
      Effect.succeed<AgentRuntimeProbeResult>({
        status: "unavailable",
        reason: boundedProviderReason(cause, options.unavailableReason, options.extraRedaction),
      }),
    ),
  )

/** Projects one shared runtime probe into a capability probe with an optional local policy check. */
export const projectAgentCapabilityProbe = <E, R>(
  runtimeProbe: Effect.Effect<AgentRuntimeProbeResult, E, R>,
  capability: AgentCapability,
  policyUnsupportedReason: () => string | null = () => null,
): Effect.Effect<AgentCapabilityProbe, E, R> =>
  runtimeProbe.pipe(
    Effect.map((result): AgentCapabilityProbe => {
      if (result.status === "unavailable") {
        return AgentCapabilityUnavailable.make({ capability, reason: result.reason })
      }
      const unsupportedReason = policyUnsupportedReason()
      return unsupportedReason === null
        ? AgentCapabilityReady.make({ capability, runtimeVersion: result.version })
        : AgentCapabilityPolicyUnsupported.make({ capability, reason: unsupportedReason })
    }),
  )

/** Creates authoritative bounded operation-error constructors for one provider. */
export const makeAgentProviderOperationErrorFactory = (
  options: AgentProviderOperationErrorFactoryOptions,
): AgentProviderOperationErrorFactory => ({
  fromCause: (capability, category) => (cause) => {
    const reason = boundedProviderReason(cause, options.fallbackReason, options.extraRedaction)
    const parsedCause = parseAgentProviderCause(cause)
    return AgentProviderOperationError.make({
      providerId: options.providerId,
      capability,
      failure: makeFailure(options, capability, parsedCause, reason, category),
      reason,
      cause: parsedCause,
    })
  },
  fromReason: (capability, reason, category) => {
    const boundedReason = boundedProviderDiagnostic(reason, options.extraRedaction)
    return AgentProviderOperationError.make({
      providerId: options.providerId,
      capability,
      failure: makeFailure(options, capability, null, boundedReason, category),
      reason: boundedReason,
    })
  },
})

const parseAgentProviderCause = (value: ProviderFailureInput): AgentProviderCause => {
  if (Predicate.isError(value) || Predicate.isNull(value)) return value
  if (isDiagnosticCause(value)) return value
  return { reason: "Unknown provider failure" }
}

const isDiagnosticCause = (value: ProviderFailureInput): value is AgentProviderDiagnosticCause =>
  Predicate.isReadonlyObject(value)
