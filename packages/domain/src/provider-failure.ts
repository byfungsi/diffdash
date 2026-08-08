import { Schema } from "effect"

/** Stable categories for provider failures that may be persisted or shown to users. */
export const AgentProviderFailureCategory = Schema.Literals([
  "authentication",
  "authorization",
  "rate-limited",
  "usage-limited",
  "quota-exhausted",
  "timeout",
  "network",
  "model-unavailable",
  "provider-unavailable",
  "configuration",
  "invalid-response",
  "policy-violation",
  "process-failure",
  "unknown",
])

/** Stable categories for provider failures that may be persisted or shown to users. */
export type AgentProviderFailureCategory = typeof AgentProviderFailureCategory.Type

/** Provider capability that failed. */
export const AgentProviderFailureCapability = Schema.Literals(["walkthrough", "review-thread"])

/** Provider capability that failed. */
export type AgentProviderFailureCapability = typeof AgentProviderFailureCapability.Type

/** Local process stage that failed before a provider operation completed. */
export const AgentProviderProcessFailureKind = Schema.Literals([
  "options",
  "spawn",
  "stdin",
  "output",
  "timeout",
  "cleanup",
  "exit",
])

/** Local process stage that failed before a provider operation completed. */
export type AgentProviderProcessFailureKind = typeof AgentProviderProcessFailureKind.Type

const PublicProviderId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
)
const ProcessSignal = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
)
const isUtcTimestamp = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z")
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === normalized
}
const AgentProviderFailureResetAt = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(
    Schema.makeFilter(isUtcTimestamp, { message: "Invalid UTC provider reset timestamp" }),
  ),
)

/** Closed provider failure data safe for persistence, IPC, display, and copied reports. */
export class AgentProviderFailure extends Schema.Class<AgentProviderFailure>(
  "AgentProviderFailure",
)({
  version: Schema.Literal(1),
  providerId: PublicProviderId,
  capability: AgentProviderFailureCapability,
  category: AgentProviderFailureCategory,
  processKind: Schema.NullOr(AgentProviderProcessFailureKind),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(ProcessSignal),
  httpStatus: Schema.NullOr(Schema.Int),
  retryAfterSeconds: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  resetsAt: Schema.NullOr(AgentProviderFailureResetAt),
}) {}
