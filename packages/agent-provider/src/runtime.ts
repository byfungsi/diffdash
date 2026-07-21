import { Effect, Predicate } from "effect"

import {
  AgentCapabilityPolicyUnsupported,
  AgentCapabilityReady,
  AgentCapabilityUnavailable,
  type AgentCapability,
  type AgentCapabilityProbe,
  type AgentProviderId,
  AgentProviderOperationError,
} from "./agent-provider"
import { type ProviderDiagnosticExtraRedaction, sanitizeProviderDiagnostic } from "./security"

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
}

/** Cohesive constructors for cause-backed and reason-only provider operation errors. */
export interface AgentProviderOperationErrorFactory {
  readonly fromCause: (
    capability: AgentCapability,
  ) => (cause: unknown) => AgentProviderOperationError
  readonly fromReason: (capability: AgentCapability, reason: string) => AgentProviderOperationError
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
  cause: unknown,
  fallback: string,
  extraRedaction?: ProviderDiagnosticExtraRedaction,
  maximumLength = DEFAULT_PROVIDER_REASON_MAX_LENGTH,
) => {
  let reason = fallback
  if (
    Predicate.isReadonlyRecord(cause) &&
    typeof cause.stderr === "string" &&
    cause.stderr.trim().length > 0
  ) {
    reason = cause.stderr
  } else if (
    Predicate.isReadonlyRecord(cause) &&
    typeof cause.reason === "string" &&
    cause.reason.trim().length > 0
  ) {
    reason = cause.reason
  } else if (isGenericProcessSpawnFailure(cause)) {
    reason = fallback
  } else if (cause instanceof Error && cause.message.trim().length > 0) {
    reason = cause.message
  }
  return boundedProviderDiagnostic(reason, extraRedaction, maximumLength)
}

const isGenericProcessSpawnFailure = (cause: unknown) => {
  const message =
    Predicate.isReadonlyRecord(cause) && typeof cause.message === "string"
      ? cause.message
      : cause instanceof Error
        ? cause.message
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
    Effect.catchAll((cause) =>
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
  fromCause: (capability) => (cause) =>
    AgentProviderOperationError.make({
      providerId: options.providerId,
      capability,
      reason: boundedProviderReason(cause, options.fallbackReason, options.extraRedaction),
      cause,
    }),
  fromReason: (capability, reason) =>
    AgentProviderOperationError.make({
      providerId: options.providerId,
      capability,
      reason: boundedProviderDiagnostic(reason, options.extraRedaction),
    }),
})
