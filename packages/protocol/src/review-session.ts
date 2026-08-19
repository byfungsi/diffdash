import { NonNegativeInteger, PositiveInteger } from "@diffdash/domain/domain-scalar"
import { DiffFileStatus, DiffFileVisibility } from "@diffdash/domain/diff"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { Match, Schema } from "effect"

const BoundedSessionIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)

const BoundedSearchMatchId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(640)),
)

/** Identity of the Core process that owns a progressive review session. */
export const ReviewSessionProcessId = BoundedSessionIdentity.pipe(
  Schema.brand("ReviewSessionProcessId"),
)

/** Identity of the Core process that owns a progressive review session. */
export type ReviewSessionProcessId = typeof ReviewSessionProcessId.Type

/** Identity of one progressive review session within a Core process. */
export const ReviewSessionId = BoundedSessionIdentity.pipe(Schema.brand("ReviewSessionId"))

/** Identity of one progressive review session within a Core process. */
export type ReviewSessionId = typeof ReviewSessionId.Type

/** Monotonic authoritative version within one exact progressive review session. */
export const ReviewSessionStateVersion = PositiveInteger.pipe(
  Schema.brand("ReviewSessionStateVersion"),
)

/** Monotonic authoritative version within one exact progressive review session. */
export type ReviewSessionStateVersion = typeof ReviewSessionStateVersion.Type

/** Full identity carried by every authoritative lifecycle publication. */
export const ReviewSessionIdentity = Schema.Struct({
  projectId: ReviewProjectId,
  reviewKey: ReviewKey,
  snapshotId: ReviewSnapshotId,
  processId: ReviewSessionProcessId,
  sessionId: ReviewSessionId,
  stateVersion: ReviewSessionStateVersion,
}).annotate({ identifier: "ReviewSessionIdentity" })

/** Full identity carried by every authoritative lifecycle publication. */
export type ReviewSessionIdentity = typeof ReviewSessionIdentity.Type

/** Request to negotiate a progressive session for one committed review snapshot. */
export const OpenReviewSessionRequest = Schema.Struct({
  projectId: ReviewProjectId,
  reviewKey: ReviewKey,
  snapshotId: ReviewSnapshotId,
}).annotate({ identifier: "OpenReviewSessionRequest" })

/** Request to negotiate a progressive session for one committed review snapshot. */
export type OpenReviewSessionRequest = typeof OpenReviewSessionRequest.Type

/** Core is negotiating workers and storage for the requested snapshot. */
export const NegotiatingReviewSession = Schema.TaggedStruct("negotiation", {
  identity: ReviewSessionIdentity,
})

/** Core has reserved bounded resources for committed snapshot reads. */
export const ReservedReviewSession = Schema.TaggedStruct("reservation", {
  identity: ReviewSessionIdentity,
})

/** Core is progressively indexing committed content. */
export const IndexingReviewSession = Schema.TaggedStruct("indexing", {
  identity: ReviewSessionIdentity,
  completedUnits: NonNegativeInteger,
  totalUnits: NonNegativeInteger,
})

/** Core is verifying the completed index before enabling mutations. */
export const VerifyingReviewSession = Schema.TaggedStruct("verification", {
  identity: ReviewSessionIdentity,
})

/** Core has verified the session and mutations may be admitted. */
export const ReadyReviewSession = Schema.TaggedStruct("ready", {
  identity: ReviewSessionIdentity,
})

/** The active revision or ownership generation was superseded. */
export const InvalidatedReviewSession = Schema.TaggedStruct("invalidated", {
  identity: ReviewSessionIdentity,
  reason: Schema.Literals([
    "revisionChanged",
    "projectChanged",
    "processChanged",
    "sessionSuperseded",
  ]),
})

/** Progressive session setup or verification failed with a safe renderer-facing message. */
export const FailedReviewSession = Schema.TaggedStruct("failed", {
  identity: ReviewSessionIdentity,
  code: BoundedSessionIdentity,
  safeMessage: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(240)),
  ),
  retryable: Schema.Boolean,
})

/** Core has terminally released the progressive review session. */
export const DisposedReviewSession = Schema.TaggedStruct("disposed", {
  identity: ReviewSessionIdentity,
  reason: Schema.Literals(["closed", "expired", "processShutdown"]),
})

/** Authoritative progressive review lifecycle returned by Core and carried by state hints. */
export const ReviewSessionState = Schema.Union([
  NegotiatingReviewSession,
  ReservedReviewSession,
  IndexingReviewSession,
  VerifyingReviewSession,
  ReadyReviewSession,
  InvalidatedReviewSession,
  FailedReviewSession,
  DisposedReviewSession,
])

/** Authoritative progressive review lifecycle returned by Core and carried by state hints. */
export type ReviewSessionState = typeof ReviewSessionState.Type

/** Exact session identity sent when the renderer releases its Core ownership. */
export const CloseReviewSessionRequest = Schema.Struct({
  identity: ReviewSessionIdentity,
}).annotate({ identifier: "CloseReviewSessionRequest" })

/** Exact session identity sent when the renderer releases its Core ownership. */
export type CloseReviewSessionRequest = typeof CloseReviewSessionRequest.Type

/** Renderer operations available at one progressive lifecycle stage. */
export interface ReviewSessionCapabilities {
  readonly committedContent: "unavailable" | "readable"
  readonly search: "unavailable" | "indexing" | "available"
  readonly filter: "unavailable" | "indexing" | "available"
  readonly navigation: "unavailable" | "indexing" | "available"
  readonly mutations: "disabled" | "enabled"
}

const UNAVAILABLE_CAPABILITIES: ReviewSessionCapabilities = Object.freeze({
  committedContent: "unavailable",
  search: "unavailable",
  filter: "unavailable",
  navigation: "unavailable",
  mutations: "disabled",
})

const COMMITTED_CAPABILITIES: ReviewSessionCapabilities = Object.freeze({
  committedContent: "readable",
  search: "unavailable",
  filter: "unavailable",
  navigation: "unavailable",
  mutations: "disabled",
})

const INDEXING_CAPABILITIES: ReviewSessionCapabilities = Object.freeze({
  committedContent: "readable",
  search: "indexing",
  filter: "indexing",
  navigation: "indexing",
  mutations: "disabled",
})

const VERIFIED_CAPABILITIES: ReviewSessionCapabilities = Object.freeze({
  committedContent: "readable",
  search: "available",
  filter: "available",
  navigation: "available",
  mutations: "disabled",
})

const READY_CAPABILITIES: ReviewSessionCapabilities = Object.freeze({
  ...VERIFIED_CAPABILITIES,
  mutations: "enabled",
})

/** Projects renderer permissions without allowing encoded state/capability contradictions. */
export const reviewSessionCapabilities = (state: ReviewSessionState): ReviewSessionCapabilities =>
  Match.valueTags(state, {
    negotiation: () => UNAVAILABLE_CAPABILITIES,
    reservation: () => COMMITTED_CAPABILITIES,
    indexing: () => INDEXING_CAPABILITIES,
    verification: () => VERIFIED_CAPABILITIES,
    ready: () => READY_CAPABILITIES,
    invalidated: () => UNAVAILABLE_CAPABILITIES,
    failed: () => UNAVAILABLE_CAPABILITIES,
    disposed: () => UNAVAILABLE_CAPABILITIES,
  })

/** Requests authoritative state for one exact progressive session version. */
export const CurrentReviewSessionRequest = Schema.Struct({
  identity: ReviewSessionIdentity,
}).annotate({ identifier: "CurrentReviewSessionRequest" })

/** Requests authoritative state for one exact progressive session version. */
export type CurrentReviewSessionRequest = typeof CurrentReviewSessionRequest.Type

/** Browser-safe changed-file inventory entry. */
export const ReviewSessionFile = Schema.Struct({
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
}).annotate({ identifier: "ReviewSessionFile" })

/** Browser-safe changed-file inventory entry. */
export type ReviewSessionFile = typeof ReviewSessionFile.Type

/** Bounded changed-file inventory request. */
export const ReviewSessionInventoryRequest = Schema.Struct({
  identity: ReviewSessionIdentity,
  offset: NonNegativeInteger,
  limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 256 }))),
}).annotate({ identifier: "ReviewSessionInventoryRequest" })

/** Bounded changed-file inventory request. */
export type ReviewSessionInventoryRequest = typeof ReviewSessionInventoryRequest.Type

/** Bounded changed-file inventory page. */
export const ReviewSessionInventoryPage = Schema.Struct({
  identity: ReviewSessionIdentity,
  files: Schema.Array(ReviewSessionFile).pipe(Schema.check(Schema.isMaxLength(256))),
  nextOffset: Schema.NullOr(NonNegativeInteger),
}).annotate({ identifier: "ReviewSessionInventoryPage" })

/** Bounded changed-file inventory page. */
export type ReviewSessionInventoryPage = typeof ReviewSessionInventoryPage.Type

/** One bounded committed range request. */
export const ReviewSessionRangeRequest = Schema.Struct({
  identity: ReviewSessionIdentity,
  fileId: ReviewFileId,
  startLine: NonNegativeInteger,
}).annotate({ identifier: "ReviewSessionRangeRequest" })

/** One bounded committed range request. */
export type ReviewSessionRangeRequest = typeof ReviewSessionRangeRequest.Type

/** One complete legal block in a bounded committed range. */
export const ReviewSessionRangeBlock = Schema.Struct({
  id: BoundedSessionIdentity,
  hunkId: Schema.NullOr(ReviewHunkId),
  ordinal: NonNegativeInteger,
  firstLine: NonNegativeInteger,
  lineCount: PositiveInteger,
  bytes: Schema.Uint8Array,
}).annotate({ identifier: "ReviewSessionRangeBlock" })

/** One complete legal block in a bounded committed range. */
export type ReviewSessionRangeBlock = typeof ReviewSessionRangeBlock.Type

/** Complete blocks split only at persisted legal boundaries. */
export const ReviewSessionRange = Schema.Struct({
  identity: ReviewSessionIdentity,
  file: ReviewSessionFile,
  blocks: Schema.Array(ReviewSessionRangeBlock).pipe(Schema.check(Schema.isMaxLength(512))),
  byteCount: NonNegativeInteger,
  complete: Schema.Boolean,
}).annotate({ identifier: "ReviewSessionRange" })

/** Complete blocks split only at persisted legal boundaries. */
export type ReviewSessionRange = typeof ReviewSessionRange.Type

/** Coordinate used to resolve one progressive review target. */
export const ReviewSessionTarget = Schema.TaggedUnion({
  HunkLine: {
    hunkId: Schema.NullOr(ReviewHunkId),
    line: NonNegativeInteger,
  },
  SideLine: {
    hunkId: ReviewHunkId,
    side: Schema.Literals(["old", "new"]),
    lineNumber: PositiveInteger,
  },
}).annotate({ identifier: "ReviewSessionTarget" })

/** Coordinate used to resolve one progressive review target. */
export type ReviewSessionTarget = typeof ReviewSessionTarget.Type

/** Semantic target request against one exact progressive session version. */
export const ReviewSessionTargetRequest = Schema.Struct({
  identity: ReviewSessionIdentity,
  fileId: ReviewFileId,
  target: ReviewSessionTarget,
}).annotate({ identifier: "ReviewSessionTargetRequest" })

/** Semantic target request against one exact progressive session version. */
export type ReviewSessionTargetRequest = typeof ReviewSessionTargetRequest.Type

/** Resolved target in one committed file and legal range block. */
export const ResolvedReviewSessionTarget = Schema.Struct({
  identity: ReviewSessionIdentity,
  file: ReviewSessionFile,
  blockOrdinal: NonNegativeInteger,
  firstLine: NonNegativeInteger,
  line: NonNegativeInteger,
}).annotate({ identifier: "ResolvedReviewSessionTarget" })

/** Resolved target in one committed file and legal range block. */
export type ResolvedReviewSessionTarget = typeof ResolvedReviewSessionTarget.Type

/** Stable semantic coordinate used by a query-bound fixed-space search cursor. */
export const ReviewSessionSearchCoordinate = Schema.Struct({
  fileOrdinal: NonNegativeInteger,
  hunkOrdinal: NonNegativeInteger,
  hunkLineIndex: NonNegativeInteger,
  start: NonNegativeInteger,
}).annotate({ identifier: "ReviewSessionSearchCoordinate" })

/** Query-bound fixed-space search cursor. */
export const ReviewSessionSearchCursor = Schema.Struct({
  queryIdentity: BoundedSessionIdentity,
  coordinate: ReviewSessionSearchCoordinate,
}).annotate({ identifier: "ReviewSessionSearchCursor" })

/** Query-bound fixed-space search cursor. */
export type ReviewSessionSearchCursor = typeof ReviewSessionSearchCursor.Type

/** Fixed-space search request against one exact progressive session version. */
export const ReviewSessionSearchRequest = Schema.Struct({
  identity: ReviewSessionIdentity,
  query: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(512)),
  ),
  anchorFileId: Schema.NullOr(ReviewFileId),
  direction: Schema.Literals(["next", "previous"]),
  cursor: Schema.NullOr(ReviewSessionSearchCursor),
  limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
}).annotate({ identifier: "ReviewSessionSearchRequest" })

/** Fixed-space search request against one exact progressive session version. */
export type ReviewSessionSearchRequest = typeof ReviewSessionSearchRequest.Type

/** One independently byte-capped source excerpt around a literal match. */
export const ReviewSessionSearchExcerpt = Schema.Struct({
  text: Schema.String,
  start: NonNegativeInteger,
  end: NonNegativeInteger,
  omittedBefore: Schema.Boolean,
  omittedAfter: Schema.Boolean,
  utf8Bytes: NonNegativeInteger,
}).annotate({ identifier: "ReviewSessionSearchExcerpt" })

/** One non-overlapping literal occurrence in committed diff content. */
export const ReviewSessionSearchMatch = Schema.Struct({
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
  coordinate: ReviewSessionSearchCoordinate,
  excerpt: ReviewSessionSearchExcerpt,
}).annotate({ identifier: "ReviewSessionSearchMatch" })

/** Progressive or final fixed-space search publication. */
export const ReviewSessionSearchPublication = Schema.TaggedUnion({
  Provisional: {
    identity: ReviewSessionIdentity,
    lowerBoundMatches: NonNegativeInteger,
    matches: Schema.Array(ReviewSessionSearchMatch).pipe(Schema.check(Schema.isMaxLength(200))),
    previousCursor: Schema.Null,
    nextCursor: Schema.Null,
    wrapped: Schema.Literal(false),
  },
  Final: {
    identity: ReviewSessionIdentity,
    totalMatches: NonNegativeInteger,
    matches: Schema.Array(ReviewSessionSearchMatch).pipe(Schema.check(Schema.isMaxLength(200))),
    previousCursor: Schema.NullOr(ReviewSessionSearchCursor),
    nextCursor: Schema.NullOr(ReviewSessionSearchCursor),
    wrapped: Schema.Boolean,
  },
}).annotate({ identifier: "ReviewSessionSearchPublication" })

/** Progressive or final fixed-space search publication. */
export type ReviewSessionSearchPublication = typeof ReviewSessionSearchPublication.Type

/** Browser-safe preload surface for progressive committed review content. */
export interface ProgressiveReviewApi {
  readonly openSession: (request: OpenReviewSessionRequest) => Promise<ReviewSessionState>
  readonly currentSession: (request: CurrentReviewSessionRequest) => Promise<ReviewSessionState>
  readonly closeSession: (request: CloseReviewSessionRequest) => Promise<ReviewSessionState>
  readonly inventory: (
    request: ReviewSessionInventoryRequest,
  ) => Promise<ReviewSessionInventoryPage>
  readonly readRange: (request: ReviewSessionRangeRequest) => Promise<ReviewSessionRange>
  readonly waitForRange: (request: ReviewSessionRangeRequest) => Promise<ReviewSessionRange>
  readonly resolveTarget: (
    request: ReviewSessionTargetRequest,
  ) => Promise<ResolvedReviewSessionTarget>
  readonly search: (
    request: ReviewSessionSearchRequest,
    onPublication: (publication: ReviewSessionSearchPublication) => void,
  ) => Promise<void>
}
