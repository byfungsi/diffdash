import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import {
  WalkthroughOperationId,
  WalkthroughOperationStateVersion,
} from "@diffdash/domain/walkthrough-operation"
import { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Schema } from "effect"

const BoundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)),
)
const BoundedProviderId = AgentProviderId.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
)
const BoundedModelId = AgentModelId.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)),
)

/** Application identity retained across the Electron walkthrough bridge. */
export const WalkthroughApplicationInstanceId = BoundedIdentity.pipe(
  Schema.brand("WalkthroughApplicationInstanceId"),
)

/** Application identity retained across the Electron walkthrough bridge. */
export type WalkthroughApplicationInstanceId = typeof WalkthroughApplicationInstanceId.Type

/** Core process epoch retained across the Electron walkthrough bridge. */
export const WalkthroughProcessEpoch = BoundedIdentity.pipe(Schema.brand("WalkthroughProcessEpoch"))

/** Core process epoch retained across the Electron walkthrough bridge. */
export type WalkthroughProcessEpoch = typeof WalkthroughProcessEpoch.Type

/** Host request identity retained across the Electron walkthrough bridge. */
export const WalkthroughRequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^h:[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  Schema.brand("WalkthroughRequestId"),
)

/** Host request identity retained across the Electron walkthrough bridge. */
export type WalkthroughRequestId = typeof WalkthroughRequestId.Type

/** Renderer-owned identity that must be retained when retrying the same start intent. */
export const WalkthroughBridgeIdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^w:[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  Schema.brand("WalkthroughBridgeIdempotencyKey"),
)

/** Renderer-owned identity that must be retained when retrying the same start intent. */
export type WalkthroughBridgeIdempotencyKey = typeof WalkthroughBridgeIdempotencyKey.Type

/** Source-neutral request to durably accept one walkthrough operation. */
export const WalkthroughBridgeStartRequest = Schema.Struct({
  target: ReviewThreadTarget,
  regenerate: Schema.Boolean,
  idempotencyKey: WalkthroughBridgeIdempotencyKey,
}).annotate({ identifier: "WalkthroughBridgeStartRequest" })

/** Source-neutral request to durably accept one walkthrough operation. */
export type WalkthroughBridgeStartRequest = typeof WalkthroughBridgeStartRequest.Type

const AttemptIdentity = {
  providerId: BoundedProviderId,
  modelId: Schema.NullOr(BoundedModelId),
  attempt: Schema.Literals([1, 2]),
} as const

/** Privacy-safe evidence for one provider candidate stage. */
export const WalkthroughBridgeAttemptSummary = Schema.Union([
  Schema.Struct({
    ...AttemptIdentity,
    stage: Schema.Literal("probe"),
    outcome: Schema.Literals(["ready", "unavailable", "policy-unsupported", "probe-failed"]),
  }),
  Schema.Struct({
    ...AttemptIdentity,
    stage: Schema.Literal("execute"),
    outcome: Schema.Literals([
      "succeeded",
      "spawn-failed",
      "provider-exit",
      "provider-failed",
      "timeout",
      "io-failed",
      "options-invalid",
      "cleanup-failed",
      "authentication-failed",
      "authorization-failed",
      "rate-limited",
      "usage-limited",
      "quota-exhausted",
      "network-failed",
      "provider-unavailable",
      "configuration-failed",
      "invalid-response",
      "policy-unsupported",
      "output-too-large",
      "model-unavailable",
      "cancelled",
      "interrupted",
    ]),
  }),
  Schema.Struct({
    ...AttemptIdentity,
    stage: Schema.Literal("parse"),
    outcome: Schema.Literals(["succeeded", "empty-response", "invalid-json", "output-too-large"]),
  }),
  Schema.Struct({
    ...AttemptIdentity,
    stage: Schema.Literal("validate"),
    outcome: Schema.Literals(["succeeded", "validation-failed"]),
  }),
]).annotate({ identifier: "WalkthroughBridgeAttemptSummary" })

/** Privacy-safe evidence for one provider candidate stage. */
export type WalkthroughBridgeAttemptSummary = typeof WalkthroughBridgeAttemptSummary.Type

const DiagnosticSymbol = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9._:-]*$/u)),
)
const InternalFrame = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$.<>:-]*$/u)),
)
const ProcessSignal = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(32)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
)
const unsafeExcerptPatterns = [
  /(?<![:/])\/(?!\/)(?:[^\s/"')\]}>]+\/)+[^\s/"')\]}>]*/u,
  /(?:[A-Za-z]:\\|\\\\)[^\s"')\]}>]+/u,
  /\b(?:authorization|api[-_ ]?key|token|password)\s*[:=]/iu,
  /\bbearer\s+\S+/iu,
  /\b(?:gh[pousr]_|sk-[A-Za-z0-9]|xox[baprs]-|AKIA[0-9A-Z])/u,
  /(?:^|\n)(?:error code|method|operation id|retry class):/iu,
  /(?:^|\n)at\s+\S+\s*\([^\n]+:\d+:\d+\)/u,
  /file:\/\//iu,
] as const
const SafeDiagnosticExcerpt = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        if (new TextEncoder().encode(value).byteLength > 2_048) return false
        const lines = value.split("\n")
        if (
          lines.length > 16 ||
          lines.some((line) => new TextEncoder().encode(line).byteLength > 240)
        ) {
          return false
        }
        for (const character of value) {
          const codePoint = character.codePointAt(0)
          if (
            codePoint === undefined ||
            (codePoint < 0x20 && codePoint !== 0x0a) ||
            codePoint === 0x7f ||
            (codePoint >= 0x80 && codePoint <= 0x9f) ||
            codePoint === 0x2028 ||
            codePoint === 0x2029
          ) {
            return false
          }
        }
        return unsafeExcerptPatterns.every((pattern) => !pattern.test(value))
      },
      { message: "Unsafe walkthrough bridge diagnostic excerpt" },
    ),
  ),
)

/** Already-sanitized diagnostic data safe to expose through contextBridge. */
export class WalkthroughBridgeSafeDiagnostic extends Schema.Class<WalkthroughBridgeSafeDiagnostic>(
  "WalkthroughBridgeSafeDiagnostic",
)({
  causeTags: Schema.Array(DiagnosticSymbol).pipe(Schema.check(Schema.isMaxLength(8))),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(ProcessSignal),
  providerExcerpt: Schema.NullOr(SafeDiagnosticExcerpt),
  internalFrames: Schema.Array(InternalFrame).pipe(Schema.check(Schema.isMaxLength(8))),
  truncated: Schema.Boolean,
}) {}

/** Stable `Walkthroughs.start` failure classifications exposed to the renderer. */
export const WalkthroughStartBridgeFailureCode = Schema.Literals([
  "NO_AGENT_PROVIDER_AVAILABLE",
  "AGENT_PROVIDER_UNAVAILABLE",
  "AGENT_PROVIDER_POLICY_UNSUPPORTED",
  "AGENT_PROVIDER_AUTHENTICATION",
  "AGENT_PROVIDER_AUTHORIZATION",
  "AGENT_PROVIDER_RATE_LIMITED",
  "AGENT_PROVIDER_USAGE_LIMITED",
  "AGENT_PROVIDER_QUOTA_EXHAUSTED",
  "AGENT_PROVIDER_NETWORK",
  "AGENT_PROVIDER_CONFIGURATION",
  "AGENT_PROVIDER_FAILURE",
  "AGENT_PROVIDER_SPAWN",
  "AGENT_PROVIDER_EXIT",
  "AGENT_PROVIDER_TIMEOUT",
  "AGENT_PROVIDER_IO",
  "AGENT_PROVIDER_CLEANUP",
  "AGENT_PROVIDER_EMPTY_RESPONSE",
  "AGENT_PROVIDER_OUTPUT_TOO_LARGE",
  "WALKTHROUGH_MODEL_UNAVAILABLE",
  "WALKTHROUGH_PROMPT_PREPARATION",
  "WALKTHROUGH_INVALID_JSON",
  "WALKTHROUGH_VALIDATION",
  "WALKTHROUGH_REVIEW_GENERATION_CHANGED",
  "WALKTHROUGH_REVIEW_RESOLUTION",
  "WALKTHROUGH_OPERATION_STORE",
  "WALKTHROUGH_STORE",
  "WALKTHROUGH_SUPERSEDED",
  "WALKTHROUGH_CANCELLED",
  "WALKTHROUGH_INTERRUPTED",
  "WALKTHROUGH_INTERNAL_ERROR",
  "CORE_UNAVAILABLE",
  "CORE_RESTARTED",
  "CORE_DRAINING",
  "CORE_RPC_ERROR",
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "REQUEST_DEADLINE_EXCEEDED",
  "REQUEST_CANCELLED",
  "WALKTHROUGH_TRANSPORT_ERROR",
  "WALKTHROUGH_RENDERER_ERROR",
])

/** Stable `Walkthroughs.start` failure classifications exposed to the renderer. */
export type WalkthroughStartBridgeFailureCode = typeof WalkthroughStartBridgeFailureCode.Type

const admissionCodes = new Set<WalkthroughStartBridgeFailureCode>([
  "CORE_UNAVAILABLE",
  "CORE_RESTARTED",
  "CORE_DRAINING",
  "CORE_RPC_ERROR",
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "REQUEST_DEADLINE_EXCEEDED",
  "REQUEST_CANCELLED",
])
const preAcceptanceCodes = new Set<WalkthroughStartBridgeFailureCode>([
  "WALKTHROUGH_REVIEW_GENERATION_CHANGED",
  "WALKTHROUGH_OPERATION_STORE",
  "WALKTHROUGH_INTERNAL_ERROR",
  "WALKTHROUGH_TRANSPORT_ERROR",
  "WALKTHROUGH_RENDERER_ERROR",
])
const hasRequiredProviderIdentity = (failure: {
  readonly code: string
  readonly providerId: string | null
  readonly modelId: string | null
}) => {
  const providerFailure =
    failure.code.startsWith("AGENT_PROVIDER_") ||
    failure.code === "WALKTHROUGH_MODEL_UNAVAILABLE" ||
    failure.code === "WALKTHROUGH_INVALID_JSON" ||
    failure.code === "WALKTHROUGH_VALIDATION"
  return (
    (!providerFailure || failure.providerId !== null) &&
    (failure.modelId === null || failure.providerId !== null)
  )
}
const hasMatchingFailureAttempt = (failure: {
  readonly attempts: ReadonlyArray<{
    readonly modelId: string | null
    readonly outcome: string
    readonly providerId: string
  }>
  readonly providerId: string | null
  readonly modelId: string | null
}) =>
  failure.providerId === null ||
  failure.attempts.some(
    (attempt) =>
      attempt.providerId === failure.providerId &&
      attempt.modelId === failure.modelId &&
      attempt.outcome !== "ready" &&
      attempt.outcome !== "succeeded",
  )
const hasValidOperationIdentity = (failure: {
  readonly attempts: ReadonlyArray<{ readonly stage: string }>
  readonly code: WalkthroughStartBridgeFailureCode
  readonly diagnostic: WalkthroughBridgeSafeDiagnostic | null
  readonly modelId: string | null
  readonly operationId: WalkthroughOperationId | null
  readonly providerId: string | null
}) => {
  if (admissionCodes.has(failure.code)) {
    return (
      failure.operationId === null &&
      failure.attempts.length === 0 &&
      failure.providerId === null &&
      failure.modelId === null &&
      failure.diagnostic === null
    )
  }
  if (failure.operationId !== null) return true
  return (
    preAcceptanceCodes.has(failure.code) &&
    failure.attempts.length === 0 &&
    failure.providerId === null &&
    failure.modelId === null
  )
}
const isSafeMessage = (value: string) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      codePoint === 0x85 ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return false
    }
  }
  return true
}

/** Classified plain `Walkthroughs.start` failure returned through contextBridge. */
export const WalkthroughStartBridgeFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  applicationInstanceId: WalkthroughApplicationInstanceId,
  processEpoch: WalkthroughProcessEpoch,
  requestId: WalkthroughRequestId,
  method: Schema.Literal("Walkthroughs.start"),
  operationId: Schema.NullOr(WalkthroughOperationId),
  code: WalkthroughStartBridgeFailureCode,
  providerId: Schema.NullOr(BoundedProviderId),
  modelId: Schema.NullOr(BoundedModelId),
  retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
  remediation: Schema.Literals([
    "retry",
    "waitAndRetry",
    "reauthenticateProvider",
    "configureProvider",
    "selectDifferentModel",
    "updateProvider",
    "reopenReview",
    "regenerate",
    "restartDiffDash",
    "freeStorage",
    "contactSupport",
    "none",
  ]),
  safeMessage: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(240)),
    Schema.check(
      Schema.makeFilter(isSafeMessage, { message: "Invalid walkthrough bridge safe message" }),
    ),
  ),
  attempts: Schema.Array(WalkthroughBridgeAttemptSummary).pipe(
    Schema.check(Schema.isMaxLength(32)),
  ),
  diagnostic: Schema.NullOr(WalkthroughBridgeSafeDiagnostic),
})
  .pipe(
    Schema.check(
      Schema.makeFilter(hasRequiredProviderIdentity, {
        message: "Walkthrough bridge provider failures require provider identity",
      }),
    ),
    Schema.check(
      Schema.makeFilter(hasMatchingFailureAttempt, {
        message: "Walkthrough bridge failure identity must occur in its attempt history",
      }),
    ),
    Schema.check(
      Schema.makeFilter(hasValidOperationIdentity, {
        message: "Walkthrough bridge failure requires its allocated operation identity",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughStartBridgeFailure" })

/** Classified plain `Walkthroughs.start` failure returned through contextBridge. */
export type WalkthroughStartBridgeFailure = typeof WalkthroughStartBridgeFailure.Type

/** Promptly returned operation identity exposed after walkthrough acceptance. */
export const WalkthroughBridgeOperationAccepted = Schema.Struct({
  applicationInstanceId: WalkthroughApplicationInstanceId,
  processEpoch: WalkthroughProcessEpoch,
  requestId: WalkthroughRequestId,
  operationId: WalkthroughOperationId,
  stateVersion: WalkthroughOperationStateVersion,
  created: Schema.Boolean,
}).annotate({ identifier: "WalkthroughBridgeOperationAccepted" })

/** Promptly returned operation identity exposed after walkthrough acceptance. */
export type WalkthroughBridgeOperationAccepted = typeof WalkthroughBridgeOperationAccepted.Type

/** Final plain success or classified failure value for walkthrough acceptance. */
export const WalkthroughStartBridgeResult = Schema.Union([
  Schema.TaggedStruct("Success", { value: WalkthroughBridgeOperationAccepted }),
  Schema.TaggedStruct("Failure", { error: WalkthroughStartBridgeFailure }),
]).annotate({ identifier: "WalkthroughStartBridgeResult" })

/** Final plain success or classified failure value for walkthrough acceptance. */
export type WalkthroughStartBridgeResult = typeof WalkthroughStartBridgeResult.Type
