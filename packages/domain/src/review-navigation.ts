import { Schema } from "effect"

import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewProjectId,
  ReviewSnapshotId,
} from "./review-identity"
import { ReviewThreadId } from "./review-thread"

/** Maximum encoded extension payload accepted by a review location. */
export const REVIEW_EXTENSION_TARGET_MAX_BYTES = 16 * 1_024

/** A registered extension's stable namespace. */
export const ReviewNavigationExtensionId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ReviewNavigationExtensionId"),
)

/** A registered extension's stable namespace. */
export type ReviewNavigationExtensionId = typeof ReviewNavigationExtensionId.Type

/** Monotonic identifier allocated by one review navigator. */
export const ReviewNavigationRequestId = Schema.Int.pipe(
  Schema.positive(),
  Schema.brand("ReviewNavigationRequestId"),
)

/** Monotonic identifier allocated by one review navigator. */
export type ReviewNavigationRequestId = typeof ReviewNavigationRequestId.Type

/** Durable address for one immutable snapshot inside one workspace project. */
export class ReviewSnapshotAddress extends Schema.Class<ReviewSnapshotAddress>(
  "ReviewSnapshotAddress",
)({
  projectId: ReviewProjectId,
  snapshotId: ReviewSnapshotId,
}) {}

/** One old-side or new-side coordinate in a parsed hunk. */
export class ReviewLinePoint extends Schema.Class<ReviewLinePoint>("ReviewLinePoint")({
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  side: Schema.Literal("old", "new"),
  lineNumber: Schema.Int.pipe(Schema.nonNegative()),
  column: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
}) {}

/** Navigates to one file card. */
export class FileReviewNavigationTarget extends Schema.TaggedClass<FileReviewNavigationTarget>()(
  "file",
  { fileId: ReviewFileId },
) {}

/** Navigates to one exact parsed hunk. */
export class HunkReviewNavigationTarget extends Schema.TaggedClass<HunkReviewNavigationTarget>()(
  "hunk",
  {
    fileId: ReviewFileId,
    hunkId: ReviewHunkId,
    hunkFingerprint: ReviewHunkFingerprint,
  },
) {}

/** Navigates to one exact parsed line. */
export class LineReviewNavigationTarget extends Schema.TaggedClass<LineReviewNavigationTarget>()(
  "line",
  {
    fileId: ReviewFileId,
    point: ReviewLinePoint,
  },
) {}

const RangeReviewNavigationTargetFields = {
  fileId: ReviewFileId,
  start: ReviewLinePoint,
  end: ReviewLinePoint,
} as const

class UncheckedRangeReviewNavigationTarget extends Schema.TaggedClass<UncheckedRangeReviewNavigationTarget>()(
  "range",
  RangeReviewNavigationTargetFields,
) {}

/** Navigates to one ordered, single-file parsed range. */
export const RangeReviewNavigationTarget = UncheckedRangeReviewNavigationTarget.pipe(
  Schema.filter(
    ({ start, end }) =>
      start.hunkId !== end.hunkId ||
      start.lineNumber < end.lineNumber ||
      (start.lineNumber === end.lineNumber && (start.column ?? 0) <= (end.column ?? 0)),
    { message: () => "Range endpoints must be ordered" },
  ),
)

/** Navigates to one ordered, single-file parsed range. */
export type RangeReviewNavigationTarget = typeof RangeReviewNavigationTarget.Type

/** Navigates to one exact current review thread. */
export class ThreadReviewNavigationTarget extends Schema.TaggedClass<ThreadReviewNavigationTarget>()(
  "thread",
  { threadId: ReviewThreadId },
) {}

/** JSON data permitted in an extension navigation envelope. */
export type ReviewNavigationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReviewNavigationJsonValue[]
  | { readonly [key: string]: ReviewNavigationJsonValue }

/** Runtime schema for JSON-only extension payloads. */
export const ReviewNavigationJsonValue: Schema.Schema<ReviewNavigationJsonValue> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Null,
      Schema.Boolean,
      Schema.String,
      Schema.JsonNumber,
      Schema.Array(ReviewNavigationJsonValue),
      Schema.Record({ key: Schema.String, value: ReviewNavigationJsonValue }),
    ),
)

class UncheckedExtensionReviewNavigationTarget extends Schema.TaggedClass<UncheckedExtensionReviewNavigationTarget>()(
  "extension",
  {
    extensionId: ReviewNavigationExtensionId,
    targetType: Schema.NonEmptyString,
    targetId: Schema.NonEmptyString,
    payloadVersion: Schema.Int.pipe(Schema.nonNegative()),
    payload: ReviewNavigationJsonValue,
  },
) {}

/** Bounded, namespaced extension-owned semantic target. */
export const ExtensionReviewNavigationTarget = UncheckedExtensionReviewNavigationTarget.pipe(
  Schema.filter(
    ({ payload }) =>
      new TextEncoder().encode(JSON.stringify(payload)).byteLength <=
      REVIEW_EXTENSION_TARGET_MAX_BYTES,
    {
      message: () => `Extension target payload exceeds ${REVIEW_EXTENSION_TARGET_MAX_BYTES} bytes`,
    },
  ),
)

/** Bounded, namespaced extension-owned semantic target. */
export type ExtensionReviewNavigationTarget = typeof ExtensionReviewNavigationTarget.Type

/** Every selector-free target supported by a version 1 review location. */
export const ReviewNavigationTarget = Schema.Union(
  FileReviewNavigationTarget,
  HunkReviewNavigationTarget,
  LineReviewNavigationTarget,
  RangeReviewNavigationTarget,
  ThreadReviewNavigationTarget,
  ExtensionReviewNavigationTarget,
)

/** Every selector-free target supported by a version 1 review location. */
export type ReviewNavigationTarget = typeof ReviewNavigationTarget.Type

/** Durable, versioned semantic location inside one exact review snapshot. */
export class ReviewLocationV1 extends Schema.Class<ReviewLocationV1>("ReviewLocationV1")({
  version: Schema.Literal(1),
  snapshot: ReviewSnapshotAddress,
  target: ReviewNavigationTarget,
}) {}

/** Caller-controlled presentation behavior for one transient request. */
export class ReviewNavigationBehavior extends Schema.Class<ReviewNavigationBehavior>(
  "ReviewNavigationBehavior",
)({
  alignment: Schema.Literal("start", "center", "nearest"),
  focus: Schema.Literal("preserve", "target"),
  selection: Schema.Literal("preserve", "update"),
  visibility: Schema.Literal("respect-current", "temporarily-reveal"),
}) {}

/** User surface that originated a review navigation request. */
export const ReviewNavigationOrigin = Schema.Literal(
  "file-tree",
  "walkthrough",
  "search-preview",
  "search-activation",
  "thread-detail",
  "command",
  "extension",
)

/** User surface that originated a review navigation request. */
export type ReviewNavigationOrigin = typeof ReviewNavigationOrigin.Type

/** Serializable input accepted by the review navigator capability. */
export class ReviewNavigationInput extends Schema.Class<ReviewNavigationInput>(
  "ReviewNavigationInput",
)({
  location: ReviewLocationV1,
  behavior: ReviewNavigationBehavior,
  origin: ReviewNavigationOrigin,
}) {}

/** Internal execution phase exposed through its privacy-safe public projection. */
export const ReviewNavigationPhase = Schema.Literal(
  "validating",
  "resolving",
  "loading-resource",
  "preparing-surface",
  "awaiting-mount",
  "positioning",
  "activating-window",
  "focusing",
  "verifying",
)

/** Internal execution phase exposed through its privacy-safe public projection. */
export type ReviewNavigationPhase = typeof ReviewNavigationPhase.Type

/** Privacy-safe target category exposed in public status. */
export const ReviewNavigationTargetKind = Schema.Literal(
  "file",
  "hunk",
  "line",
  "range",
  "thread",
  "extension",
)

/** Privacy-safe target category exposed in public status. */
export type ReviewNavigationTargetKind = typeof ReviewNavigationTargetKind.Type

/** Deterministic reason a semantic location cannot execute locally. */
export const ReviewNavigationUnavailableReason = Schema.Literal(
  "invalidLocation",
  "unsupportedVersion",
  "noActiveReview",
  "projectNotActive",
  "snapshotNotActive",
  "snapshotChanged",
  "targetNotFound",
  "targetOutdated",
  "extensionUnavailable",
  "extensionTargetInvalid",
  "notFocusable",
  "fileContentUnavailable",
)

/** Deterministic reason a semantic location cannot execute locally. */
export type ReviewNavigationUnavailableReason = typeof ReviewNavigationUnavailableReason.Type

/** Operational reason an otherwise compatible request could not complete. */
export const ReviewNavigationFailureReason = Schema.Literal(
  "snapshotLoadFailed",
  "fileLoadFailed",
  "extensionResolveFailed",
  "extensionMountFailed",
  "positioningFailed",
  "windowActivationFailed",
  "focusFailed",
  "deadlineExceeded",
)

/** Operational reason an otherwise compatible request could not complete. */
export type ReviewNavigationFailureReason = typeof ReviewNavigationFailureReason.Type

/** Successful terminal navigation outcome. */
export class CompletedReviewNavigationOutcome extends Schema.TaggedClass<CompletedReviewNavigationOutcome>()(
  "completed",
  {
    requestId: ReviewNavigationRequestId,
    achieved: Schema.Literal("revealed", "focused"),
  },
) {}

/** Terminal outcome for work replaced by a newer request. */
export class SupersededReviewNavigationOutcome extends Schema.TaggedClass<SupersededReviewNavigationOutcome>()(
  "superseded",
  {
    requestId: ReviewNavigationRequestId,
    by: ReviewNavigationRequestId,
  },
) {}

/** Terminal outcome for explicitly cancelled navigation. */
export class CancelledReviewNavigationOutcome extends Schema.TaggedClass<CancelledReviewNavigationOutcome>()(
  "cancelled",
  {
    requestId: ReviewNavigationRequestId,
    reason: Schema.Literal("caller", "user", "review-changed", "bridge-lost"),
  },
) {}

/** Terminal outcome for a location that cannot execute in the active review. */
export class UnavailableReviewNavigationOutcome extends Schema.TaggedClass<UnavailableReviewNavigationOutcome>()(
  "unavailable",
  {
    requestId: ReviewNavigationRequestId,
    reason: ReviewNavigationUnavailableReason,
  },
) {}

/** Terminal outcome for an operational navigation failure. */
export class FailedReviewNavigationOutcome extends Schema.TaggedClass<FailedReviewNavigationOutcome>()(
  "failed",
  {
    requestId: ReviewNavigationRequestId,
    phase: ReviewNavigationPhase,
    reason: ReviewNavigationFailureReason,
    retryable: Schema.Boolean,
  },
) {}

/** Exactly one terminal result returned for every accepted request. */
export const ReviewNavigationOutcome = Schema.Union(
  CompletedReviewNavigationOutcome,
  SupersededReviewNavigationOutcome,
  CancelledReviewNavigationOutcome,
  UnavailableReviewNavigationOutcome,
  FailedReviewNavigationOutcome,
)

/** Exactly one terminal result returned for every accepted request. */
export type ReviewNavigationOutcome = typeof ReviewNavigationOutcome.Type

/** Public status when no request owns the review viewport. */
export class IdleReviewNavigationStatus extends Schema.TaggedClass<IdleReviewNavigationStatus>()(
  "idle",
  {},
) {}

/** Privacy-safe public status while one request owns the review viewport. */
export class ActiveReviewNavigationStatus extends Schema.TaggedClass<ActiveReviewNavigationStatus>()(
  "active",
  {
    requestId: ReviewNavigationRequestId,
    phase: ReviewNavigationPhase,
    targetKind: ReviewNavigationTargetKind,
    origin: ReviewNavigationOrigin,
    startedAt: Schema.Number,
    phaseStartedAt: Schema.Number,
    viewportInput: Schema.Literal("locked"),
    canCancel: Schema.Literal(true),
  },
) {}

/** Read-only public projection of the local review navigation machine. */
export const ReviewNavigationStatus = Schema.Union(
  IdleReviewNavigationStatus,
  ActiveReviewNavigationStatus,
)

/** Read-only public projection of the local review navigation machine. */
export type ReviewNavigationStatus = typeof ReviewNavigationStatus.Type
