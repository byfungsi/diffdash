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
import { Schema } from "effect"

import {
  WalkthroughApplicationInstanceId,
  WalkthroughBridgeIdempotencyKey,
  WalkthroughBridgeAttemptSummary,
  WalkthroughBridgeSafeDiagnostic,
  WalkthroughProcessEpoch,
  WalkthroughRequestId,
} from "./walkthrough-operation"
import { ReviewThreadTarget } from "@diffdash/domain/review-thread"

const BoundedReviewProjectId = ReviewProjectId.pipe(Schema.check(Schema.isMaxLength(100)))
const BoundedReviewKey = ReviewKey.pipe(Schema.check(Schema.isMaxLength(512)))
const BoundedReviewRevision = ReviewRevision.pipe(Schema.check(Schema.isMaxLength(200)))
const BoundedProviderId = AgentProviderId.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
)
const BoundedModelId = AgentModelId.pipe(
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)),
)
const BoundedPromptVersion = WalkthroughOperationPromptVersion.pipe(
  Schema.check(Schema.isMaxLength(100)),
)
const WalkthroughBridgeCandidatePlanFingerprint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^walkthrough-plan:v1:[0-9a-f]{64}$/u)),
)
const WalkthroughBridgeReviewGeneration = Schema.Struct({
  kind: Schema.Literals(["hosted", "local", "repositoryComparison"]),
  projectId: BoundedReviewProjectId,
  snapshotId: ReviewSnapshotId,
  reviewKey: BoundedReviewKey,
  baseRevision: BoundedReviewRevision,
  headRevision: BoundedReviewRevision,
})
const WalkthroughBridgeConfiguredRoute = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("auto"), quality: AgentModelQuality }),
  Schema.Struct({
    mode: Schema.Literal("provider"),
    providerId: BoundedProviderId,
    modelId: Schema.NullOr(BoundedModelId),
  }),
])
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
const BoundedChapterId = WalkthroughChapterId.pipe(Schema.check(Schema.isMaxLength(128)))
const BoundedStopId = WalkthroughStopId.pipe(Schema.check(Schema.isMaxLength(128)))
const BoundedSupportItemId = WalkthroughSupportItemId.pipe(Schema.check(Schema.isMaxLength(128)))
const BoundedHunkId = WalkthroughHunkId.pipe(Schema.check(Schema.isMaxLength(1_024)))
const HunkReferences = Schema.Array(BoundedHunkId).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(160)),
)
const PublicStop = Schema.Struct({
  id: BoundedStopId,
  title: boundedNonEmptyText(256),
  summary: boundedNonEmptyText(4_096),
  risk: WalkthroughRisk,
  hunkIds: HunkReferences,
})
const PublicChapter = Schema.Struct({
  id: BoundedChapterId,
  title: boundedNonEmptyText(256),
  summary: boundedNonEmptyText(4_096),
  stops: Schema.Array(PublicStop).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(64)),
  ),
})
const PublicSupportItem = Schema.Struct({
  id: BoundedSupportItemId,
  title: boundedNonEmptyText(256),
  reason: boundedNonEmptyText(4_096),
  hunkIds: HunkReferences,
})
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PublicGenerationDetails = Schema.Struct({
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
const PublicArtifactValue = Schema.Struct({
  title: boundedNonEmptyText(256),
  summary: boundedNonEmptyText(4_096),
  chapters: Schema.Array(PublicChapter).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(32)),
  ),
  support: Schema.Array(PublicSupportItem).pipe(Schema.check(Schema.isMaxLength(160))),
  generation: Schema.optional(PublicGenerationDetails),
})
const publicArtifactTextBytes = (walkthrough: typeof PublicArtifactValue.Type) => {
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
const PublicArtifact = PublicArtifactValue.pipe(
  Schema.check(
    Schema.makeFilter(
      (walkthrough) => {
        const stops = walkthrough.chapters.flatMap((chapter) => chapter.stops)
        const hunkReferences = [...stops, ...walkthrough.support].flatMap((item) => item.hunkIds)
        return (
          stops.length <= 160 &&
          hunkReferences.length <= 160 &&
          new Set(walkthrough.chapters.map((chapter) => chapter.id)).size ===
            walkthrough.chapters.length &&
          new Set(stops.map((stop) => stop.id)).size === stops.length &&
          new Set(walkthrough.support.map((support) => support.id)).size ===
            walkthrough.support.length &&
          new Set(hunkReferences).size === hunkReferences.length &&
          publicArtifactTextBytes(walkthrough) <= 256 * 1_024
        )
      },
      { message: "Invalid bounded walkthrough bridge artifact" },
    ),
  ),
)
/** Exact persisted walkthrough artifact returned by operation and stored-artifact queries. */
export const WalkthroughBridgeStoredArtifact = Schema.Struct({
  reviewGeneration: WalkthroughBridgeReviewGeneration,
  promptVersion: BoundedPromptVersion,
  walkthrough: PublicArtifact,
  createdAt: WalkthroughOperationTimestamp,
})
const providerFailureCodes = [
  "AGENT_PROVIDER_",
  "WALKTHROUGH_MODEL_UNAVAILABLE",
  "WALKTHROUGH_INVALID_JSON",
  "WALKTHROUGH_VALIDATION",
] as const
const hasRequiredProviderIdentity = (failure: {
  readonly code: string
  readonly modelId: string | null
  readonly providerId: string | null
}) => {
  const providerFailure =
    failure.code !== "AGENT_PROVIDER_FAILURE" &&
    providerFailureCodes.some((code) =>
      code.endsWith("_") ? failure.code.startsWith(code) : failure.code === code,
    )
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

/** Stable operation-state failure classifications exposed to the renderer. */
export const WalkthroughOperationBridgeFailureCode = Schema.Literals([
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

/** Stable operation-state failure classifications exposed to the renderer. */
export type WalkthroughOperationBridgeFailureCode =
  typeof WalkthroughOperationBridgeFailureCode.Type

const SafeMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(
    Schema.makeFilter(
      (value) =>
        [...value].every((character) => {
          const codePoint = character.codePointAt(0)
          return (
            codePoint !== undefined &&
            codePoint >= 0x20 &&
            codePoint !== 0x7f &&
            codePoint !== 0x85 &&
            codePoint !== 0x2028 &&
            codePoint !== 0x2029
          )
        }),
      { message: "Invalid walkthrough bridge safe message" },
    ),
  ),
)
const FailureDetail = Schema.Struct({
  code: WalkthroughOperationBridgeFailureCode,
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
  safeMessage: SafeMessage,
  diagnostic: Schema.NullOr(WalkthroughBridgeSafeDiagnostic),
}).pipe(
  Schema.check(
    Schema.makeFilter(hasRequiredProviderIdentity, {
      message: "Agent provider failures require provider identity",
    }),
  ),
)
const OperationCommonFields = {
  acceptedRequest: Schema.Struct({
    applicationInstanceId: WalkthroughApplicationInstanceId,
    processEpoch: WalkthroughProcessEpoch,
    requestId: WalkthroughRequestId,
  }),
  operationId: WalkthroughOperationId,
  stateVersion: WalkthroughOperationStateVersion,
  idempotencyKey: WalkthroughBridgeIdempotencyKey,
  reviewGeneration: WalkthroughBridgeReviewGeneration,
  promptVersion: BoundedPromptVersion,
  configuredRoute: WalkthroughBridgeConfiguredRoute,
  candidatePlanFingerprint: WalkthroughBridgeCandidatePlanFingerprint,
  attempts: Schema.Array(WalkthroughBridgeAttemptSummary).pipe(
    Schema.check(Schema.isMaxLength(32)),
  ),
  acceptedAt: WalkthroughOperationTimestamp,
  updatedAt: WalkthroughOperationTimestamp,
} as const
const hasMatchingStoredGeneration = (operation: {
  readonly reviewGeneration: typeof WalkthroughBridgeReviewGeneration.Type
  readonly promptVersion: WalkthroughOperationPromptVersion
  readonly stored: typeof WalkthroughBridgeStoredArtifact.Type
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

/** Authoritative public walkthrough operation state exposed to the renderer. */
export const WalkthroughBridgeOperationSnapshot = Schema.Union([
  Schema.Struct({
    ...OperationCommonFields,
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
  Schema.Struct({
    ...OperationCommonFields,
    state: Schema.Literal("completed"),
    stored: WalkthroughBridgeStoredArtifact,
    terminalAt: WalkthroughOperationTimestamp,
  }).pipe(
    Schema.check(
      Schema.makeFilter(hasMatchingStoredGeneration, {
        message: "Completed walkthrough bridge operation must contain its accepted generation",
      }),
    ),
  ),
  Schema.Struct({
    ...OperationCommonFields,
    state: Schema.Literal("failed"),
    failure: FailureDetail,
    terminalAt: WalkthroughOperationTimestamp,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (operation) =>
          hasMatchingFailureAttempt({ ...operation.failure, attempts: operation.attempts }),
        { message: "Failed walkthrough provider identity must occur in its attempt history" },
      ),
    ),
  ),
  Schema.Struct({
    ...OperationCommonFields,
    state: Schema.Literal("cancelled"),
    terminalAt: WalkthroughOperationTimestamp,
  }),
  Schema.Struct({
    ...OperationCommonFields,
    state: Schema.Literal("superseded"),
    supersededByOperationId: WalkthroughOperationId,
    terminalAt: WalkthroughOperationTimestamp,
  }),
  Schema.Struct({
    ...OperationCommonFields,
    state: Schema.Literal("interrupted"),
    terminalAt: WalkthroughOperationTimestamp,
  }),
]).annotate({ identifier: "WalkthroughBridgeOperationSnapshot" })

/** Authoritative public walkthrough operation state exposed to the renderer. */
export type WalkthroughBridgeOperationSnapshot = typeof WalkthroughBridgeOperationSnapshot.Type

const GetOperationFailureCode = Schema.Literals([
  "WALKTHROUGH_OPERATION_NOT_FOUND",
  "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE",
  "WALKTHROUGH_OPERATION_STORE",
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
const admissionCodes = new Set<typeof GetOperationFailureCode.Type>([
  "CORE_UNAVAILABLE",
  "CORE_RESTARTED",
  "CORE_DRAINING",
  "CORE_RPC_ERROR",
  "REQUEST_TOO_LARGE",
  "REQUEST_DEADLINE_EXCEEDED",
  "REQUEST_CANCELLED",
])

/** Classified plain `Walkthroughs.getOperation` failure returned through contextBridge. */
export const WalkthroughGetOperationBridgeFailure = Schema.TaggedStruct(
  "WalkthroughPublicFailure",
  {
    applicationInstanceId: WalkthroughApplicationInstanceId,
    processEpoch: WalkthroughProcessEpoch,
    requestId: WalkthroughRequestId,
    method: Schema.Literal("Walkthroughs.getOperation"),
    operationId: WalkthroughOperationId,
    code: GetOperationFailureCode,
    providerId: Schema.NullOr(BoundedProviderId),
    modelId: Schema.NullOr(BoundedModelId),
    retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
    remediation: FailureDetail.fields.remediation,
    safeMessage: SafeMessage,
    attempts: Schema.Array(WalkthroughBridgeAttemptSummary).pipe(
      Schema.check(Schema.isMaxLength(32)),
    ),
    diagnostic: Schema.NullOr(WalkthroughBridgeSafeDiagnostic),
  },
)
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
    Schema.check(
      Schema.makeFilter(
        (failure) =>
          !admissionCodes.has(failure.code) ||
          (failure.providerId === null &&
            failure.modelId === null &&
            failure.attempts.length === 0 &&
            failure.diagnostic === null),
        { message: "Walkthrough get-operation admission failures cannot contain private detail" },
      ),
    ),
  )
  .annotate({ identifier: "WalkthroughGetOperationBridgeFailure" })

/** Classified plain `Walkthroughs.getOperation` failure returned through contextBridge. */
export type WalkthroughGetOperationBridgeFailure = typeof WalkthroughGetOperationBridgeFailure.Type

/** Current query identity paired with the authoritative operation snapshot. */
export const WalkthroughGetOperationBridgeSuccess = Schema.Struct({
  applicationInstanceId: WalkthroughApplicationInstanceId,
  processEpoch: WalkthroughProcessEpoch,
  requestId: WalkthroughRequestId,
  operationId: WalkthroughOperationId,
  operation: WalkthroughBridgeOperationSnapshot,
})
  .pipe(
    Schema.check(
      Schema.makeFilter((success) => success.operationId === success.operation.operationId, {
        message: "Walkthrough operation response must retain the requested operation identity",
      }),
    ),
  )
  .annotate({ identifier: "WalkthroughGetOperationBridgeSuccess" })

/** Current query identity paired with the authoritative operation snapshot. */
export type WalkthroughGetOperationBridgeSuccess = typeof WalkthroughGetOperationBridgeSuccess.Type

/** Final plain success or classified failure value for an operation-state query. */
export const WalkthroughGetOperationBridgeResult = Schema.Union([
  Schema.TaggedStruct("Success", { value: WalkthroughGetOperationBridgeSuccess }),
  Schema.TaggedStruct("Failure", { error: WalkthroughGetOperationBridgeFailure }),
]).annotate({ identifier: "WalkthroughGetOperationBridgeResult" })

/** Final plain success or classified failure value for an operation-state query. */
export type WalkthroughGetOperationBridgeResult = typeof WalkthroughGetOperationBridgeResult.Type

/** Request for one authoritative walkthrough operation snapshot. */
export const WalkthroughBridgeOperationRequest = Schema.Struct({
  operationId: WalkthroughOperationId,
}).annotate({ identifier: "WalkthroughBridgeOperationRequest" })

/** Request for one authoritative walkthrough operation snapshot. */
export type WalkthroughBridgeOperationRequest = typeof WalkthroughBridgeOperationRequest.Type

/** Request for the exact stored artifact associated with the target's current generation. */
export const WalkthroughBridgeGetStoredRequest = Schema.Struct({
  target: ReviewThreadTarget,
}).annotate({ identifier: "WalkthroughBridgeGetStoredRequest" })

/** Request for the exact stored artifact associated with the target's current generation. */
export type WalkthroughBridgeGetStoredRequest = typeof WalkthroughBridgeGetStoredRequest.Type

const operationMutationFailure = (method: "Walkthroughs.cancel") =>
  Schema.TaggedStruct("WalkthroughPublicFailure", {
    applicationInstanceId: WalkthroughApplicationInstanceId,
    processEpoch: WalkthroughProcessEpoch,
    requestId: WalkthroughRequestId,
    method: Schema.Literal(method),
    operationId: WalkthroughOperationId,
    code: GetOperationFailureCode,
    providerId: Schema.NullOr(BoundedProviderId),
    modelId: Schema.NullOr(BoundedModelId),
    retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
    remediation: FailureDetail.fields.remediation,
    safeMessage: SafeMessage,
    attempts: Schema.Array(WalkthroughBridgeAttemptSummary).pipe(
      Schema.check(Schema.isMaxLength(32)),
    ),
    diagnostic: Schema.NullOr(WalkthroughBridgeSafeDiagnostic),
  })

/** Classified plain cancellation failure returned through contextBridge. */
export const WalkthroughCancelBridgeFailure = operationMutationFailure("Walkthroughs.cancel")

/** Plain cancellation result; the embedded snapshot remains authoritative. */
export const WalkthroughCancelBridgeResult = Schema.Union([
  Schema.TaggedStruct("Success", {
    value: Schema.Struct({
      applicationInstanceId: WalkthroughApplicationInstanceId,
      processEpoch: WalkthroughProcessEpoch,
      requestId: WalkthroughRequestId,
      operationId: WalkthroughOperationId,
      status: Schema.Literals(["cancelled", "alreadyCompleted"]),
      operation: WalkthroughBridgeOperationSnapshot,
    }),
  }),
  Schema.TaggedStruct("Failure", { error: WalkthroughCancelBridgeFailure }),
]).annotate({ identifier: "WalkthroughCancelBridgeResult" })

/** Plain cancellation result; the embedded snapshot remains authoritative. */
export type WalkthroughCancelBridgeResult = typeof WalkthroughCancelBridgeResult.Type

/** Classified plain stored-artifact lookup failure returned through contextBridge. */
export const WalkthroughGetStoredBridgeFailure = Schema.TaggedStruct("WalkthroughPublicFailure", {
  applicationInstanceId: WalkthroughApplicationInstanceId,
  processEpoch: WalkthroughProcessEpoch,
  requestId: WalkthroughRequestId,
  method: Schema.Literal("Walkthroughs.getStored"),
  operationId: Schema.Null,
  code: WalkthroughOperationBridgeFailureCode,
  providerId: Schema.NullOr(BoundedProviderId),
  modelId: Schema.NullOr(BoundedModelId),
  retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
  remediation: FailureDetail.fields.remediation,
  safeMessage: SafeMessage,
  attempts: Schema.Array(WalkthroughBridgeAttemptSummary).pipe(
    Schema.check(Schema.isMaxLength(32)),
  ),
  diagnostic: Schema.NullOr(WalkthroughBridgeSafeDiagnostic),
})

/** Plain exact-generation stored-artifact lookup result. */
export const WalkthroughGetStoredBridgeResult = Schema.Union([
  Schema.TaggedStruct("Success", {
    value: Schema.Union([
      Schema.Struct({ status: Schema.Literal("found"), stored: WalkthroughBridgeStoredArtifact }),
      Schema.Struct({ status: Schema.Literal("notFound") }),
    ]),
  }),
  Schema.TaggedStruct("Failure", { error: WalkthroughGetStoredBridgeFailure }),
]).annotate({ identifier: "WalkthroughGetStoredBridgeResult" })

/** Plain exact-generation stored-artifact lookup result. */
export type WalkthroughGetStoredBridgeResult = typeof WalkthroughGetStoredBridgeResult.Type

/** Bounded, non-authoritative Core hint correlated to one walkthrough operation. */
export const WalkthroughOperationBridgeHint = Schema.Struct({
  applicationInstanceId: WalkthroughApplicationInstanceId,
  processEpoch: WalkthroughProcessEpoch,
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  operationId: WalkthroughOperationId,
  stateVersion: WalkthroughOperationStateVersion,
  kind: Schema.Literals(["stateChanged", "operationProgress", "operationTerminal"]),
}).annotate({ identifier: "WalkthroughOperationBridgeHint" })

/** Bounded, non-authoritative Core hint correlated to one walkthrough operation. */
export type WalkthroughOperationBridgeHint = typeof WalkthroughOperationBridgeHint.Type
