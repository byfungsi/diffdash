import { AgentModelQuality } from "@diffdash/domain/ai-settings"
import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import {
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { utf8ByteLength } from "@diffdash/domain/utf8"
import {
  WALKTHROUGH_PROMPT_VERSION,
  WalkthroughChapterId,
  WalkthroughGenerationMode,
  WalkthroughHunkId,
  WalkthroughRisk,
  WalkthroughStopId,
  WalkthroughSupportItemId,
} from "@diffdash/domain/walkthrough"
import {
  WalkthroughOperationId,
  WalkthroughOperationPromptVersion,
  WalkthroughOperationStateVersion,
  WalkthroughOperationTimestamp,
} from "@diffdash/domain/walkthrough-operation"
import { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Schema } from "effect"

/** Current walkthrough prompt identity used for exact stored-artifact lookups. */
export const CurrentWalkthroughPromptVersion = WALKTHROUGH_PROMPT_VERSION

import { CoreRpcRetryClass, CoreRpcSafeMessage } from "./failure"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestContext,
  HostRequestId,
} from "./identity"

const BoundedReviewProjectId = ReviewProjectId.pipe(Schema.check(Schema.isMaxLength(100)))
const BoundedReviewKey = ReviewKey.pipe(Schema.check(Schema.isMaxLength(512)))
const BoundedReviewRevision = ReviewRevision.pipe(Schema.check(Schema.isMaxLength(200)))
const BoundedAgentProviderId = AgentProviderId.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
)
const BoundedAgentModelId = AgentModelId.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)),
)
const BoundedPromptVersion = WalkthroughOperationPromptVersion.pipe(
  Schema.check(Schema.isMaxLength(100)),
)

const boundedText = (maxBytes: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMaxLength(maxBytes)),
    Schema.check(
      Schema.makeFilter((value) => utf8ByteLength(value) <= maxBytes, {
        message: `Expected at most ${maxBytes} UTF-8 bytes`,
      }),
    ),
  )

const boundedNonEmptyText = (maxBytes: number) =>
  boundedText(maxBytes).pipe(Schema.check(Schema.isMinLength(1)))

/** Idempotency identity reused only when retrying the same walkthrough acceptance intent. */
export const WalkthroughIdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^w:[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  Schema.brand("WalkthroughIdempotencyKey"),
)

/** Idempotency identity reused only when retrying the same walkthrough acceptance intent. */
export type WalkthroughIdempotencyKey = typeof WalkthroughIdempotencyKey.Type

/** SHA-256 identity of the immutable ordered provider candidate plan accepted by Core. */
export const WalkthroughCandidatePlanFingerprint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^walkthrough-plan:v1:[0-9a-f]{64}$/u)),
  Schema.brand("WalkthroughCandidatePlanFingerprint"),
)

/** SHA-256 identity of the immutable ordered provider candidate plan accepted by Core. */
export type WalkthroughCandidatePlanFingerprint = typeof WalkthroughCandidatePlanFingerprint.Type

/** Exact immutable review generation accepted for one walkthrough operation. */
export class WalkthroughReviewGeneration extends Schema.Class<WalkthroughReviewGeneration>(
  "WalkthroughReviewGeneration",
)({
  kind: Schema.Literals(["hosted", "local", "repositoryComparison"]),
  projectId: BoundedReviewProjectId,
  snapshotId: ReviewSnapshotId,
  reviewKey: BoundedReviewKey,
  baseRevision: BoundedReviewRevision,
  headRevision: BoundedReviewRevision,
}) {}

/** Configured walkthrough route captured before provider resolution starts. */
export const WalkthroughConfiguredRoute = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("auto"), quality: AgentModelQuality }),
  Schema.Struct({
    mode: Schema.Literal("provider"),
    providerId: BoundedAgentProviderId,
    modelId: Schema.NullOr(BoundedAgentModelId),
  }),
]).annotate({ identifier: "WalkthroughConfiguredRoute" })

/** Configured walkthrough route captured before provider resolution starts. */
export type WalkthroughConfiguredRoute = typeof WalkthroughConfiguredRoute.Type

const WalkthroughAttemptIdentity = {
  providerId: BoundedAgentProviderId,
  modelId: Schema.NullOr(BoundedAgentModelId),
  attempt: Schema.Literals([1, 2]),
} as const

/** Privacy-safe evidence for one bounded provider candidate stage. */
export const WalkthroughAttemptSummary = Schema.Union([
  Schema.Struct({
    ...WalkthroughAttemptIdentity,
    stage: Schema.Literal("probe"),
    outcome: Schema.Literals(["ready", "unavailable", "policy-unsupported", "probe-failed"]),
  }),
  Schema.Struct({
    ...WalkthroughAttemptIdentity,
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
    ...WalkthroughAttemptIdentity,
    stage: Schema.Literal("parse"),
    outcome: Schema.Literals(["succeeded", "empty-response", "invalid-json", "output-too-large"]),
  }),
  Schema.Struct({
    ...WalkthroughAttemptIdentity,
    stage: Schema.Literal("validate"),
    outcome: Schema.Literals(["succeeded", "validation-failed"]),
  }),
]).annotate({ identifier: "WalkthroughAttemptSummary" })

/** Privacy-safe evidence for one bounded provider candidate stage. */
export type WalkthroughAttemptSummary = typeof WalkthroughAttemptSummary.Type

/** Complete bounded attempt history exposed for one walkthrough operation or failure. */
export const WalkthroughAttemptSummaries = Schema.Array(WalkthroughAttemptSummary).pipe(
  Schema.check(Schema.isMaxLength(32)),
)

/** Complete bounded attempt history exposed for one walkthrough operation or failure. */
export type WalkthroughAttemptSummaries = typeof WalkthroughAttemptSummaries.Type

const BoundedWalkthroughChapterId = WalkthroughChapterId.pipe(Schema.check(Schema.isMaxLength(128)))
const BoundedWalkthroughStopId = WalkthroughStopId.pipe(Schema.check(Schema.isMaxLength(128)))
const BoundedWalkthroughSupportItemId = WalkthroughSupportItemId.pipe(
  Schema.check(Schema.isMaxLength(128)),
)
const BoundedWalkthroughHunkId = WalkthroughHunkId.pipe(Schema.check(Schema.isMaxLength(1_024)))
const WalkthroughHunkReferences = Schema.Array(BoundedWalkthroughHunkId).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(160)),
)
const WalkthroughPublicStop = Schema.Struct({
  id: BoundedWalkthroughStopId,
  title: boundedNonEmptyText(256),
  summary: boundedNonEmptyText(4_096),
  risk: WalkthroughRisk,
  hunkIds: WalkthroughHunkReferences,
})
const WalkthroughPublicChapter = Schema.Struct({
  id: BoundedWalkthroughChapterId,
  title: boundedNonEmptyText(256),
  summary: boundedNonEmptyText(4_096),
  stops: Schema.Array(WalkthroughPublicStop).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(64)),
  ),
})
const WalkthroughPublicSupportItem = Schema.Struct({
  id: BoundedWalkthroughSupportItemId,
  title: boundedNonEmptyText(256),
  reason: boundedNonEmptyText(4_096),
  hunkIds: WalkthroughHunkReferences,
})
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const WalkthroughPublicGenerationDetails = Schema.Struct({
  mode: WalkthroughGenerationMode,
  totalFiles: NonNegativeInt,
  analyzedFiles: NonNegativeInt,
  totalFolders: NonNegativeInt,
  analyzedFolders: NonNegativeInt,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (details) =>
        details.analyzedFiles <= details.totalFiles &&
        details.analyzedFolders <= details.totalFolders,
      { message: "Walkthrough analyzed counts cannot exceed totals" },
    ),
  ),
)
const WalkthroughPublicArtifactValue = Schema.Struct({
  title: boundedNonEmptyText(256),
  summary: boundedNonEmptyText(4_096),
  chapters: Schema.Array(WalkthroughPublicChapter).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(32)),
  ),
  support: Schema.Array(WalkthroughPublicSupportItem).pipe(Schema.check(Schema.isMaxLength(160))),
  generation: Schema.optional(WalkthroughPublicGenerationDetails),
})
const WALKTHROUGH_PUBLIC_ARTIFACT_TEXT_BYTES = 256 * 1_024

const publicArtifactTextBytes = (walkthrough: typeof WalkthroughPublicArtifactValue.Type) => {
  let total = utf8ByteLength(walkthrough.title) + utf8ByteLength(walkthrough.summary)
  for (const chapter of walkthrough.chapters) {
    total +=
      utf8ByteLength(chapter.id) + utf8ByteLength(chapter.title) + utf8ByteLength(chapter.summary)
    for (const stop of chapter.stops) {
      total += utf8ByteLength(stop.id) + utf8ByteLength(stop.title) + utf8ByteLength(stop.summary)
      for (const hunkId of stop.hunkIds) total += utf8ByteLength(hunkId)
    }
  }
  for (const support of walkthrough.support) {
    total +=
      utf8ByteLength(support.id) + utf8ByteLength(support.title) + utf8ByteLength(support.reason)
    for (const hunkId of support.hunkIds) total += utf8ByteLength(hunkId)
  }
  return total
}

/** Bounded walkthrough content safe to return through Core RPC. */
export const WalkthroughPublicArtifact = WalkthroughPublicArtifactValue.pipe(
  Schema.check(
    Schema.makeFilter(
      (walkthrough) => {
        const stops = walkthrough.chapters.flatMap((chapter) => chapter.stops)
        const hunkReferences = [...stops, ...walkthrough.support].flatMap((item) => item.hunkIds)
        const chapterIds = new Set(walkthrough.chapters.map((chapter) => chapter.id))
        const stopIds = new Set(stops.map((stop) => stop.id))
        const supportIds = new Set(walkthrough.support.map((support) => support.id))
        return (
          stops.length <= 160 &&
          hunkReferences.length <= 160 &&
          chapterIds.size === walkthrough.chapters.length &&
          stopIds.size === stops.length &&
          supportIds.size === walkthrough.support.length &&
          new Set(hunkReferences).size === hunkReferences.length &&
          publicArtifactTextBytes(walkthrough) <= WALKTHROUGH_PUBLIC_ARTIFACT_TEXT_BYTES
        )
      },
      {
        message:
          "Walkthrough content contains duplicate identity or exceeds its global item, reference, or text budget",
      },
    ),
  ),
).annotate({ identifier: "WalkthroughPublicArtifact" })

/** Bounded walkthrough content safe to return through Core RPC. */
export type WalkthroughPublicArtifact = typeof WalkthroughPublicArtifact.Type

/** Exact persisted walkthrough artifact returned for one immutable review generation. */
export const WalkthroughStoredArtifact = Schema.Struct({
  reviewGeneration: WalkthroughReviewGeneration,
  promptVersion: BoundedPromptVersion,
  walkthrough: WalkthroughPublicArtifact,
  createdAt: WalkthroughOperationTimestamp,
}).annotate({ identifier: "WalkthroughStoredArtifact" })

/** Exact persisted walkthrough artifact returned for one immutable review generation. */
export type WalkthroughStoredArtifact = typeof WalkthroughStoredArtifact.Type

/** Stable failure classifications emitted for walkthrough operations. */
export const WalkthroughFailureCode = Schema.Literals([
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
  "WALKTHROUGH_OPERATION_NOT_FOUND",
  "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE",
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
])

/** Stable failure classifications emitted for walkthrough operations. */
export type WalkthroughFailureCode = typeof WalkthroughFailureCode.Type

const WalkthroughStartFailureCode = Schema.Literals([
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
])
const WalkthroughGetOperationFailureCode = Schema.Literals([
  "WALKTHROUGH_OPERATION_NOT_FOUND",
  "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE",
  "WALKTHROUGH_OPERATION_STORE",
  "WALKTHROUGH_INTERNAL_ERROR",
])
const WalkthroughCancelFailureCode = Schema.Literals([
  "WALKTHROUGH_OPERATION_NOT_FOUND",
  "WALKTHROUGH_OPERATION_STORE",
  "WALKTHROUGH_INTERNAL_ERROR",
])
const WalkthroughGetStoredFailureCode = Schema.Literals([
  "WALKTHROUGH_REVIEW_RESOLUTION",
  "WALKTHROUGH_STORE",
  "WALKTHROUGH_INTERNAL_ERROR",
])
const WalkthroughAdmissionFailureCode = Schema.Literals([
  "CORE_UNAVAILABLE",
  "CORE_RESTARTED",
  "CORE_DRAINING",
  "CORE_RPC_ERROR",
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "REQUEST_DEADLINE_EXCEEDED",
  "REQUEST_CANCELLED",
])

/** Bounded user action that may resolve a classified walkthrough failure. */
export const WalkthroughRemediation = Schema.Literals([
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
])

/** Bounded user action that may resolve a classified walkthrough failure. */
export type WalkthroughRemediation = typeof WalkthroughRemediation.Type

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
const unsafeDiagnosticPatterns = [
  /(?<![:/])\/(?!\/)(?:[^\s/"')\]}>]+\/)+[^\s/"')\]}>]*/u,
  /(?:[A-Za-z]:\\|\\\\)[^\s"')\]}>]+/u,
  /\b(?:authorization|api[-_ ]?key|token|password)\s*[:=]/iu,
  /\bbearer\s+\S+/iu,
  /\b(?:gh[pousr]_|sk-[A-Za-z0-9]|xox[baprs]-|AKIA[0-9A-Z])/u,
  /(?:^|\n)(?:error code|method|operation id|retry class):/iu,
  /(?:^|\n)at\s+\S+\s*\([^\n]+:\d+:\d+\)/u,
  /file:\/\//iu,
] as const
const isSafeDiagnosticExcerpt = (value: string) => {
  if (utf8ByteLength(value) > 2_048) return false
  const lines = value.split("\n")
  if (lines.length > 16 || lines.some((line) => utf8ByteLength(line) > 240)) return false
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
  return unsafeDiagnosticPatterns.every((pattern) => !pattern.test(value))
}
const SafeDiagnosticExcerpt = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isSafeDiagnosticExcerpt, {
      message: "Unsafe walkthrough diagnostic excerpt",
    }),
  ),
)

/** Already-sanitized diagnostic details safe to include in copied walkthrough reports. */
export class WalkthroughSafeDiagnostic extends Schema.Class<WalkthroughSafeDiagnostic>(
  "WalkthroughSafeDiagnostic",
)({
  causeTags: Schema.Array(DiagnosticSymbol).pipe(Schema.check(Schema.isMaxLength(8))),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(ProcessSignal),
  providerExcerpt: Schema.NullOr(SafeDiagnosticExcerpt),
  internalFrames: Schema.Array(InternalFrame).pipe(Schema.check(Schema.isMaxLength(8))),
  truncated: Schema.Boolean,
}) {}

const WalkthroughFailureDetailFields = {
  code: WalkthroughFailureCode,
  providerId: Schema.NullOr(BoundedAgentProviderId),
  modelId: Schema.NullOr(BoundedAgentModelId),
  retryClass: CoreRpcRetryClass,
  remediation: WalkthroughRemediation,
  safeMessage: CoreRpcSafeMessage,
  diagnostic: Schema.NullOr(WalkthroughSafeDiagnostic),
} as const

const hasRequiredProviderIdentity = (failure: {
  readonly code: string
  readonly modelId: string | null
  readonly providerId: string | null
}) => {
  const providerFailure =
    (failure.code !== "AGENT_PROVIDER_FAILURE" && failure.code.startsWith("AGENT_PROVIDER_")) ||
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
  readonly modelId: string | null
  readonly providerId: string | null
}) =>
  failure.providerId === null ||
  failure.attempts.some(
    (attempt) =>
      attempt.providerId === failure.providerId &&
      attempt.modelId === failure.modelId &&
      attempt.outcome !== "ready" &&
      attempt.outcome !== "succeeded",
  )

/** Classified walkthrough failure detail without duplicated request or operation identity. */
export const WalkthroughFailureDetail = Schema.Struct(WalkthroughFailureDetailFields)
  .pipe(
    Schema.check(
      Schema.makeFilter(hasRequiredProviderIdentity, {
        message: "Agent provider failures require provider identity",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughFailureDetail" })

/** Classified walkthrough failure detail without duplicated request or operation identity. */
export type WalkthroughFailureDetail = typeof WalkthroughFailureDetail.Type

const HostRequestIdentityFields = {
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
} as const
const WalkthroughPublicFailureFields = {
  ...HostRequestIdentityFields,
  ...WalkthroughFailureDetailFields,
  attempts: WalkthroughAttemptSummaries,
} as const
const WalkthroughPreAcceptanceFailureCode = Schema.Literals([
  "WALKTHROUGH_REVIEW_GENERATION_CHANGED",
  "WALKTHROUGH_OPERATION_STORE",
  "WALKTHROUGH_INTERNAL_ERROR",
])
const WalkthroughPreAcceptanceFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughPublicFailureFields,
  code: WalkthroughPreAcceptanceFailureCode,
  method: Schema.Literal("Walkthroughs.start"),
  operationId: Schema.Null,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (failure) =>
        failure.attempts.length === 0 && failure.providerId === null && failure.modelId === null,
      { message: "Pre-acceptance walkthrough failures cannot contain provider attempts" },
    ),
  ),
)

const WalkthroughAcceptedStartFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughPublicFailureFields,
  code: WalkthroughStartFailureCode,
  method: Schema.Literal("Walkthroughs.start"),
  operationId: WalkthroughOperationId,
})

/** Stable plain expected failure from `Walkthroughs.start`. */
export const WalkthroughStartFailure = Schema.Union([
  WalkthroughAcceptedStartFailure,
  WalkthroughPreAcceptanceFailure,
])
  .pipe(
    Schema.check(
      Schema.makeFilter(hasRequiredProviderIdentity, {
        message: "Agent provider failures require provider identity",
      }),
    ),
    Schema.check(
      Schema.makeFilter(hasMatchingFailureAttempt, {
        message: "Walkthrough failure provider identity must occur in its attempt history",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughStartFailure" })

/** Stable plain expected failure from `Walkthroughs.start`. */
export type WalkthroughStartFailure = typeof WalkthroughStartFailure.Type

/** Stable plain expected failure from `Walkthroughs.getOperation`. */
export const WalkthroughGetOperationFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughPublicFailureFields,
  code: WalkthroughGetOperationFailureCode,
  method: Schema.Literal("Walkthroughs.getOperation"),
  operationId: WalkthroughOperationId,
})
  .pipe(
    Schema.check(
      Schema.makeFilter(hasRequiredProviderIdentity, {
        message: "Agent provider failures require provider identity",
      }),
    ),
    Schema.check(
      Schema.makeFilter(hasMatchingFailureAttempt, {
        message: "Walkthrough failure provider identity must occur in its attempt history",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughGetOperationFailure" })

/** Stable plain expected failure from `Walkthroughs.getOperation`. */
export type WalkthroughGetOperationFailure = typeof WalkthroughGetOperationFailure.Type

/** Stable plain expected failure from `Walkthroughs.cancel`. */
export const WalkthroughCancelFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughPublicFailureFields,
  code: WalkthroughCancelFailureCode,
  method: Schema.Literal("Walkthroughs.cancel"),
  operationId: WalkthroughOperationId,
})
  .pipe(
    Schema.check(
      Schema.makeFilter(hasRequiredProviderIdentity, {
        message: "Agent provider failures require provider identity",
      }),
    ),
    Schema.check(
      Schema.makeFilter(hasMatchingFailureAttempt, {
        message: "Walkthrough failure provider identity must occur in its attempt history",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughCancelFailure" })

/** Stable plain expected failure from `Walkthroughs.cancel`. */
export type WalkthroughCancelFailure = typeof WalkthroughCancelFailure.Type

/** Stable plain expected failure from `Walkthroughs.getStored`. */
export const WalkthroughGetStoredFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughPublicFailureFields,
  code: WalkthroughGetStoredFailureCode,
  method: Schema.Literal("Walkthroughs.getStored"),
  operationId: Schema.Null,
})
  .pipe(
    Schema.check(
      Schema.makeFilter(hasRequiredProviderIdentity, {
        message: "Agent provider failures require provider identity",
      }),
    ),
    Schema.check(
      Schema.makeFilter(hasMatchingFailureAttempt, {
        message: "Walkthrough failure provider identity must occur in its attempt history",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughGetStoredFailure" })

/** Stable plain expected failure from `Walkthroughs.getStored`. */
export type WalkthroughGetStoredFailure = typeof WalkthroughGetStoredFailure.Type

const EmptyWalkthroughAttempts = WalkthroughAttemptSummaries.pipe(
  Schema.check(Schema.isMaxLength(0)),
)
const WalkthroughAdmissionFailureFields = {
  ...HostRequestIdentityFields,
  code: WalkthroughAdmissionFailureCode,
  providerId: Schema.Null,
  modelId: Schema.Null,
  retryClass: CoreRpcRetryClass,
  remediation: WalkthroughRemediation,
  safeMessage: CoreRpcSafeMessage,
  attempts: EmptyWalkthroughAttempts,
  diagnostic: Schema.Null,
} as const

/** Pre-dispatch admission failure from `Walkthroughs.start`. */
export const WalkthroughStartAdmissionFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughAdmissionFailureFields,
  method: Schema.Literal("Walkthroughs.start"),
  operationId: Schema.Null,
}).annotate({ identifier: "WalkthroughStartAdmissionFailure" })

/** Pre-dispatch admission failure from `Walkthroughs.start`. */
export type WalkthroughStartAdmissionFailure = typeof WalkthroughStartAdmissionFailure.Type

/** Pre-dispatch admission failure from `Walkthroughs.getOperation`. */
export const WalkthroughGetOperationAdmissionFailure = Schema.TaggedStruct(
  "WalkthroughPublicFailure",
  {
    ...WalkthroughAdmissionFailureFields,
    method: Schema.Literal("Walkthroughs.getOperation"),
    operationId: WalkthroughOperationId,
  },
).annotate({ identifier: "WalkthroughGetOperationAdmissionFailure" })

/** Pre-dispatch admission failure from `Walkthroughs.getOperation`. */
export type WalkthroughGetOperationAdmissionFailure =
  typeof WalkthroughGetOperationAdmissionFailure.Type

/** Pre-dispatch admission failure from `Walkthroughs.cancel`. */
export const WalkthroughCancelAdmissionFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughAdmissionFailureFields,
  method: Schema.Literal("Walkthroughs.cancel"),
  operationId: WalkthroughOperationId,
}).annotate({ identifier: "WalkthroughCancelAdmissionFailure" })

/** Pre-dispatch admission failure from `Walkthroughs.cancel`. */
export type WalkthroughCancelAdmissionFailure = typeof WalkthroughCancelAdmissionFailure.Type

/** Pre-dispatch admission failure from `Walkthroughs.getStored`. */
export const WalkthroughGetStoredAdmissionFailure = Schema.TaggedStruct(
  "WalkthroughPublicFailure",
  {
    ...WalkthroughAdmissionFailureFields,
    method: Schema.Literal("Walkthroughs.getStored"),
    operationId: Schema.Null,
  },
).annotate({ identifier: "WalkthroughGetStoredAdmissionFailure" })

/** Pre-dispatch admission failure from `Walkthroughs.getStored`. */
export type WalkthroughGetStoredAdmissionFailure = typeof WalkthroughGetStoredAdmissionFailure.Type

/** Stable plain walkthrough failure retaining exact method, request, and operation identity. */
export const WalkthroughPublicFailure = Schema.Union([
  WalkthroughStartFailure,
  WalkthroughGetOperationFailure,
  WalkthroughCancelFailure,
  WalkthroughGetStoredFailure,
  WalkthroughStartAdmissionFailure,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughCancelAdmissionFailure,
  WalkthroughGetStoredAdmissionFailure,
]).annotate({ identifier: "WalkthroughPublicFailure" })

/** Stable plain walkthrough failure retaining exact method, request, and operation identity. */
export type WalkthroughPublicFailure = typeof WalkthroughPublicFailure.Type

const WalkthroughOperationCommonFields = {
  acceptedRequest: HostRequestContext,
  operationId: WalkthroughOperationId,
  stateVersion: WalkthroughOperationStateVersion,
  idempotencyKey: WalkthroughIdempotencyKey,
  reviewGeneration: WalkthroughReviewGeneration,
  promptVersion: BoundedPromptVersion,
  configuredRoute: WalkthroughConfiguredRoute,
  candidatePlanFingerprint: WalkthroughCandidatePlanFingerprint,
  attempts: WalkthroughAttemptSummaries,
  acceptedAt: WalkthroughOperationTimestamp,
  updatedAt: WalkthroughOperationTimestamp,
} as const
const hasMatchingStoredGeneration = (operation: {
  readonly reviewGeneration: WalkthroughReviewGeneration
  readonly promptVersion: WalkthroughOperationPromptVersion
  readonly stored: WalkthroughStoredArtifact
}) => {
  const accepted = operation.reviewGeneration
  const stored = operation.stored.reviewGeneration
  return (
    operation.promptVersion === operation.stored.promptVersion &&
    accepted.kind === stored.kind &&
    accepted.projectId === stored.projectId &&
    accepted.snapshotId === stored.snapshotId &&
    accepted.reviewKey === stored.reviewKey &&
    accepted.baseRevision === stored.baseRevision &&
    accepted.headRevision === stored.headRevision
  )
}
const WalkthroughCompletedOperationSnapshot = Schema.Struct({
  ...WalkthroughOperationCommonFields,
  state: Schema.Literal("completed"),
  stored: WalkthroughStoredArtifact,
  terminalAt: WalkthroughOperationTimestamp,
}).pipe(
  Schema.check(
    Schema.makeFilter(hasMatchingStoredGeneration, {
      message: "Completed walkthrough operation must contain its accepted generation",
    }),
  ),
)
const WalkthroughFailedOperationSnapshot = Schema.Struct({
  ...WalkthroughOperationCommonFields,
  state: Schema.Literal("failed"),
  failure: WalkthroughFailureDetail,
  terminalAt: WalkthroughOperationTimestamp,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (operation) =>
        hasMatchingFailureAttempt({ ...operation.failure, attempts: operation.attempts }),
      { message: "Failed walkthrough provider identity must occur in its attempt history" },
    ),
  ),
)

/** Authoritative public walkthrough operation state with state-specific terminal data. */
export const WalkthroughOperationSnapshot = Schema.Union([
  Schema.Struct({
    ...WalkthroughOperationCommonFields,
    state: Schema.Literal("active"),
    phase: Schema.Literals([
      "queued",
      "resolving-provider",
      "running",
      "validating",
      "retrying",
      "falling-back",
      "persisting",
    ]),
  }),
  WalkthroughCompletedOperationSnapshot,
  WalkthroughFailedOperationSnapshot,
  Schema.Struct({
    ...WalkthroughOperationCommonFields,
    state: Schema.Literal("cancelled"),
    terminalAt: WalkthroughOperationTimestamp,
  }),
  Schema.Struct({
    ...WalkthroughOperationCommonFields,
    state: Schema.Literal("superseded"),
    supersededByOperationId: WalkthroughOperationId,
    terminalAt: WalkthroughOperationTimestamp,
  }),
  Schema.Struct({
    ...WalkthroughOperationCommonFields,
    state: Schema.Literal("interrupted"),
    terminalAt: WalkthroughOperationTimestamp,
  }),
]).annotate({ identifier: "WalkthroughOperationSnapshot" })

/** Authoritative public walkthrough operation state with state-specific terminal data. */
export type WalkthroughOperationSnapshot = typeof WalkthroughOperationSnapshot.Type

/** Result of cancellation distinguishing cancelled state from another terminal state. */
export const WalkthroughCancelResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    operation: WalkthroughOperationSnapshot,
  }).pipe(
    Schema.check(
      Schema.makeFilter((result) => result.operation.state === "cancelled", {
        message: "Cancelled walkthrough result requires cancelled operation state",
      }),
    ),
  ),
  Schema.Struct({
    status: Schema.Literal("alreadyCompleted"),
    operation: WalkthroughOperationSnapshot,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (result) => result.operation.state !== "active" && result.operation.state !== "cancelled",
        { message: "Already-completed walkthrough result requires a prior terminal state" },
      ),
    ),
  ),
]).annotate({ identifier: "WalkthroughCancelResult" })

/** Result of cancellation distinguishing cancelled state from another terminal state. */
export type WalkthroughCancelResult = typeof WalkthroughCancelResult.Type

/** Request to durably accept or find one exact walkthrough generation intent. */
export class StartWalkthroughRequest extends Schema.Class<StartWalkthroughRequest>(
  "StartWalkthroughRequest",
)({
  ...HostRequestIdentityFields,
  target: ReviewThreadTarget,
  regenerate: Schema.Boolean,
  idempotencyKey: WalkthroughIdempotencyKey,
}) {}

/** Durable acknowledgement returned after walkthrough operation acceptance. */
export class WalkthroughOperationAccepted extends Schema.Class<WalkthroughOperationAccepted>(
  "WalkthroughOperationAccepted",
)({
  ...HostRequestIdentityFields,
  operationId: WalkthroughOperationId,
  stateVersion: WalkthroughOperationStateVersion,
  created: Schema.Boolean,
}) {}

/** Request for the authoritative state of one durable walkthrough operation. */
export class GetWalkthroughOperationRequest extends Schema.Class<GetWalkthroughOperationRequest>(
  "GetWalkthroughOperationRequest",
)({
  ...HostRequestIdentityFields,
  operationId: WalkthroughOperationId,
}) {}

/** Request to cancel one durable walkthrough operation if no terminal state has won. */
export class CancelWalkthroughRequest extends Schema.Class<CancelWalkthroughRequest>(
  "CancelWalkthroughRequest",
)({
  ...HostRequestIdentityFields,
  operationId: WalkthroughOperationId,
}) {}

/** Exact immutable lookup for a stored walkthrough artifact. */
export class GetStoredWalkthroughRequest extends Schema.Class<GetStoredWalkthroughRequest>(
  "GetStoredWalkthroughRequest",
)({
  ...HostRequestIdentityFields,
  target: ReviewThreadTarget,
  promptVersion: BoundedPromptVersion,
}) {}

/** Tagged stored-walkthrough lookup result that distinguishes absence from malformed data. */
export const GetStoredWalkthroughResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("found"), stored: WalkthroughStoredArtifact }),
  Schema.Struct({
    status: Schema.Literal("notFound"),
    reviewGeneration: WalkthroughReviewGeneration,
    promptVersion: BoundedPromptVersion,
  }),
]).annotate({ identifier: "GetStoredWalkthroughResult" })

/** Tagged stored-walkthrough lookup result that distinguishes absence from malformed data. */
export type GetStoredWalkthroughResult = typeof GetStoredWalkthroughResult.Type
