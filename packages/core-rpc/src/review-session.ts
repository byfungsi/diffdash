import { NonNegativeInteger, PositiveInteger } from "@diffdash/domain/domain-scalar"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { DiffFileStatus, DiffFileVisibility } from "@diffdash/domain/diff"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { Schema } from "effect"

import { HostRequestContext } from "./identity"

const RequestIdentity = HostRequestContext.fields
const BoundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)
const BoundedSafeMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(240)),
)
const BoundedQuery = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(512)),
)
const BoundedSearchMatchId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(640)),
)
const BoundedPageSize = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
)

/** Core-owned identity of one foreground progressive review session. */
export const CoreReviewSessionId = BoundedIdentity.pipe(Schema.brand("CoreReviewSessionId"))

/** Core-owned identity of one foreground progressive review session. */
export type CoreReviewSessionId = typeof CoreReviewSessionId.Type

/** Monotonic authoritative version within one exact Core review session. */
export const CoreReviewSessionStateVersion = PositiveInteger.pipe(
  Schema.brand("CoreReviewSessionStateVersion"),
)

/** Monotonic authoritative version within one exact Core review session. */
export type CoreReviewSessionStateVersion = typeof CoreReviewSessionStateVersion.Type

/** Exact authority carried by every progressive review operation. */
export const CoreReviewSessionIdentity = Schema.Struct({
  applicationInstanceId: HostRequestContext.fields.applicationInstanceId,
  processEpoch: HostRequestContext.fields.processEpoch,
  projectId: ReviewProjectId,
  reviewKey: ReviewKey,
  snapshotId: ReviewSnapshotId,
  sessionId: CoreReviewSessionId,
  stateVersion: CoreReviewSessionStateVersion,
}).annotate({ identifier: "CoreReviewSessionIdentity" })

/** Exact authority carried by every progressive review operation. */
export type CoreReviewSessionIdentity = typeof CoreReviewSessionIdentity.Type

/** Authoritative progressive review lifecycle returned by Core. */
export const CoreReviewSessionState = Schema.TaggedUnion({
  Negotiating: { identity: CoreReviewSessionIdentity },
  Reserved: { identity: CoreReviewSessionIdentity },
  Indexing: {
    identity: CoreReviewSessionIdentity,
    completedUnits: NonNegativeInteger,
    totalUnits: NonNegativeInteger,
  },
  Verifying: { identity: CoreReviewSessionIdentity },
  Ready: { identity: CoreReviewSessionIdentity },
  Invalidated: {
    identity: CoreReviewSessionIdentity,
    reason: Schema.Literals([
      "revisionChanged",
      "projectChanged",
      "processChanged",
      "sessionSuperseded",
    ]),
  },
  Failed: {
    identity: CoreReviewSessionIdentity,
    code: BoundedIdentity,
    safeMessage: BoundedSafeMessage,
    retryable: Schema.Boolean,
  },
  Disposed: {
    identity: CoreReviewSessionIdentity,
    reason: Schema.Literals(["closed", "expired", "processShutdown"]),
  },
}).annotate({ identifier: "CoreReviewSessionState" })

/** Authoritative progressive review lifecycle returned by Core. */
export type CoreReviewSessionState = typeof CoreReviewSessionState.Type

/** Opens one application-wide foreground session for an immutable snapshot. */
export const OpenCoreReviewSessionRequest = Schema.Struct({
  ...RequestIdentity,
  projectId: ReviewProjectId,
  reviewKey: ReviewKey,
  snapshotId: ReviewSnapshotId,
}).annotate({ identifier: "OpenCoreReviewSessionRequest" })

/** Opens one application-wide foreground session for an immutable snapshot. */
export type OpenCoreReviewSessionRequest = typeof OpenCoreReviewSessionRequest.Type

/** Reads or closes one exact authoritative session version. */
export const CoreReviewSessionRequest = Schema.Struct({
  ...RequestIdentity,
  identity: CoreReviewSessionIdentity,
}).annotate({ identifier: "CoreReviewSessionRequest" })

/** Reads or closes one exact authoritative session version. */
export type CoreReviewSessionRequest = typeof CoreReviewSessionRequest.Type

/** Stable safe failure from a progressive review RPC. */
export const CoreReviewSessionFailure = Schema.TaggedStruct("CoreReviewSessionFailure", {
  ...RequestIdentity,
  method: Schema.Literals([
    "Reviews.openSession",
    "Reviews.currentSession",
    "Reviews.closeSession",
    "Reviews.inventory",
    "Ranges.read",
    "Ranges.wait",
    "Navigation.resolveTarget",
    "Search.scan",
  ]),
  code: Schema.Literals([
    "CORE_RESTARTED",
    "CORE_DRAINING",
    "REVIEW_SESSION_INVALID",
    "REVIEW_SESSION_SUPERSEDED",
    "REVIEW_SNAPSHOT_NOT_FOUND",
    "REVIEW_RANGE_LIMIT",
    "REVIEW_RESOURCE_QUOTA",
    "REVIEW_SOURCE_UNAVAILABLE",
    "REVIEW_SEARCH_INVALID",
    "REVIEW_SEARCH_CURSOR_INVALID",
    "REVIEW_SEARCH_SUPERSEDED",
    "REQUEST_TOO_LARGE",
    "RESPONSE_TOO_LARGE",
    "REQUEST_DEADLINE_EXCEEDED",
    "REVIEW_SESSION_INTERNAL_ERROR",
  ]),
  retryClass: Schema.Literals(["automatic", "userAction", "notRetryable"]),
  safeMessage: BoundedSafeMessage,
}).annotate({ identifier: "CoreReviewSessionFailure" })

/** Stable safe failure from a progressive review RPC. */
export type CoreReviewSessionFailure = typeof CoreReviewSessionFailure.Type

/** Browser-neutral changed-file inventory entry. */
export const CoreReviewFile = Schema.Struct({
  ordinal: NonNegativeInteger,
  fileId: ReviewFileId,
  path: RepositoryRelativePath,
  oldPath: Schema.NullOr(RepositoryRelativePath),
  additions: NonNegativeInteger,
  deletions: NonNegativeInteger,
  status: DiffFileStatus,
  visibility: DiffFileVisibility,
  patchHash: ReviewFilePatchHash,
  hunkCount: NonNegativeInteger,
}).annotate({ identifier: "CoreReviewFile" })

/** Browser-neutral changed-file inventory entry. */
export type CoreReviewFile = typeof CoreReviewFile.Type

/** Bounded progressive inventory request. */
export const CoreReviewInventoryRequest = Schema.Struct({
  ...RequestIdentity,
  identity: CoreReviewSessionIdentity,
  offset: NonNegativeInteger,
  limit: BoundedPageSize,
}).annotate({ identifier: "CoreReviewInventoryRequest" })

/** Bounded progressive inventory request. */
export type CoreReviewInventoryRequest = typeof CoreReviewInventoryRequest.Type

/** Bounded progressive inventory page. */
export const CoreReviewInventoryPage = Schema.Struct({
  identity: CoreReviewSessionIdentity,
  files: Schema.Array(CoreReviewFile).pipe(Schema.check(Schema.isMaxLength(256))),
  nextOffset: Schema.NullOr(NonNegativeInteger),
}).annotate({ identifier: "CoreReviewInventoryPage" })

/** Bounded progressive inventory page. */
export type CoreReviewInventoryPage = typeof CoreReviewInventoryPage.Type

/** One bounded committed range request. */
export const CoreReviewRangeRequest = Schema.Struct({
  ...RequestIdentity,
  identity: CoreReviewSessionIdentity,
  fileId: ReviewFileId,
  startLine: NonNegativeInteger,
}).annotate({ identifier: "CoreReviewRangeRequest" })

/** One bounded committed range request. */
export type CoreReviewRangeRequest = typeof CoreReviewRangeRequest.Type

/** One complete legal block in a bounded committed range. */
export const CoreReviewRangeBlock = Schema.Struct({
  id: BoundedIdentity,
  hunkId: Schema.NullOr(ReviewHunkId),
  ordinal: NonNegativeInteger,
  firstLine: NonNegativeInteger,
  lineCount: PositiveInteger,
  bytes: Schema.Uint8Array,
}).annotate({ identifier: "CoreReviewRangeBlock" })

/** One complete legal block in a bounded committed range. */
export type CoreReviewRangeBlock = typeof CoreReviewRangeBlock.Type

/** Complete blocks split only at persisted legal boundaries. */
export const CoreReviewRange = Schema.Struct({
  identity: CoreReviewSessionIdentity,
  file: CoreReviewFile,
  blocks: Schema.Array(CoreReviewRangeBlock).pipe(Schema.check(Schema.isMaxLength(512))),
  byteCount: NonNegativeInteger,
  complete: Schema.Boolean,
}).annotate({ identifier: "CoreReviewRange" })

/** Complete blocks split only at persisted legal boundaries. */
export type CoreReviewRange = typeof CoreReviewRange.Type

/** Semantic target request against one exact session version. */
export const CoreReviewTargetRequest = Schema.Struct({
  ...RequestIdentity,
  identity: CoreReviewSessionIdentity,
  fileId: ReviewFileId,
  hunkId: Schema.NullOr(ReviewHunkId),
  line: NonNegativeInteger,
}).annotate({ identifier: "CoreReviewTargetRequest" })

/** Semantic target request against one exact session version. */
export type CoreReviewTargetRequest = typeof CoreReviewTargetRequest.Type

/** Resolved target in one committed file and legal range block. */
export const CoreResolvedReviewTarget = Schema.Struct({
  identity: CoreReviewSessionIdentity,
  file: CoreReviewFile,
  blockOrdinal: NonNegativeInteger,
  line: NonNegativeInteger,
}).annotate({ identifier: "CoreResolvedReviewTarget" })

/** Resolved target in one committed file and legal range block. */
export type CoreResolvedReviewTarget = typeof CoreResolvedReviewTarget.Type

/** Stable semantic coordinate used by a query-bound search cursor. */
export const CoreReviewSearchCoordinate = Schema.Struct({
  fileOrdinal: NonNegativeInteger,
  hunkOrdinal: NonNegativeInteger,
  hunkLineIndex: NonNegativeInteger,
  start: NonNegativeInteger,
}).annotate({ identifier: "CoreReviewSearchCoordinate" })

/** Stable semantic coordinate used by a query-bound search cursor. */
export type CoreReviewSearchCoordinate = typeof CoreReviewSearchCoordinate.Type

/** Query-bound fixed-space search cursor. */
export const CoreReviewSearchCursor = Schema.Struct({
  queryIdentity: BoundedIdentity,
  coordinate: CoreReviewSearchCoordinate,
}).annotate({ identifier: "CoreReviewSearchCursor" })

/** Query-bound fixed-space search cursor. */
export type CoreReviewSearchCursor = typeof CoreReviewSearchCursor.Type

/** Fixed-space search request against one exact session version. */
export const CoreReviewSearchRequest = Schema.Struct({
  ...RequestIdentity,
  identity: CoreReviewSessionIdentity,
  query: BoundedQuery,
  anchorFileId: Schema.NullOr(ReviewFileId),
  direction: Schema.Literals(["next", "previous"]),
  cursor: Schema.NullOr(CoreReviewSearchCursor),
  limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
}).annotate({ identifier: "CoreReviewSearchRequest" })

/** Fixed-space search request against one exact session version. */
export type CoreReviewSearchRequest = typeof CoreReviewSearchRequest.Type

/** Independently byte-capped source context around one literal match. */
export const CoreReviewSearchExcerpt = Schema.Struct({
  text: Schema.String,
  start: NonNegativeInteger,
  end: NonNegativeInteger,
  omittedBefore: Schema.Boolean,
  omittedAfter: Schema.Boolean,
  utf8Bytes: NonNegativeInteger,
}).annotate({ identifier: "CoreReviewSearchExcerpt" })

/** One non-overlapping literal occurrence in committed diff content. */
export const CoreReviewSearchMatch = Schema.Struct({
  id: BoundedSearchMatchId,
  fileId: ReviewFileId,
  filePath: RepositoryRelativePath,
  hunkId: ReviewHunkId,
  hunkFingerprint: ReviewHunkFingerprint,
  hunkLineIndex: NonNegativeInteger,
  newLineNumber: Schema.NullOr(PositiveInteger),
  oldLineNumber: Schema.NullOr(PositiveInteger),
  side: Schema.Literals(["additions", "context", "deletions"]),
  start: NonNegativeInteger,
  end: NonNegativeInteger,
  coordinate: CoreReviewSearchCoordinate,
  excerpt: CoreReviewSearchExcerpt,
}).annotate({ identifier: "CoreReviewSearchMatch" })

/** Progressive or final fixed-space search publication. */
export const CoreReviewSearchPublication = Schema.TaggedUnion({
  Provisional: {
    identity: CoreReviewSessionIdentity,
    lowerBoundMatches: NonNegativeInteger,
    matches: Schema.Array(CoreReviewSearchMatch).pipe(Schema.check(Schema.isMaxLength(200))),
    previousCursor: Schema.Null,
    nextCursor: Schema.Null,
    wrapped: Schema.Literal(false),
  },
  Final: {
    identity: CoreReviewSessionIdentity,
    totalMatches: NonNegativeInteger,
    matches: Schema.Array(CoreReviewSearchMatch).pipe(Schema.check(Schema.isMaxLength(200))),
    previousCursor: Schema.NullOr(CoreReviewSearchCursor),
    nextCursor: Schema.NullOr(CoreReviewSearchCursor),
    wrapped: Schema.Boolean,
  },
}).annotate({ identifier: "CoreReviewSearchPublication" })

/** Progressive or final fixed-space search publication. */
export type CoreReviewSearchPublication = typeof CoreReviewSearchPublication.Type
