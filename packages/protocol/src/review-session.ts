import { NonNegativeInteger, PositiveInteger } from "@diffdash/domain/domain-scalar"
import { ReviewKey, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { Match, Schema } from "effect"

const BoundedSessionIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
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
