import { Effect, Match, Schema } from "effect"

import { ReviewProjectId, ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  ReviewThread,
  ReviewThreadAnchor,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import type { DatabaseRow } from "./database"

const ReviewThreadAnchorJson = Schema.fromJsonString(ReviewThreadAnchor)

/** Flat status vocabulary accepted from existing review_threads rows. */
export const StoredReviewAnchorStatus = Schema.Literals([
  "active",
  "carried_forward",
  "outdated",
  "unresolved_anchor",
])

/** Existing SQLite representation retained while the domain uses CurrentReviewAnchor. */
export const ReviewThreadRow = Schema.Struct({
  id: ReviewThreadId,
  repo_id: ReviewProjectId,
  review_key: ReviewKey,
  pr_number: Schema.NullOr(Schema.Int),
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  current_base_sha: ReviewRevision,
  current_head_sha: ReviewRevision,
  original_anchor_json: ReviewThreadAnchorJson,
  current_anchor_json: Schema.NullOr(ReviewThreadAnchorJson),
  anchor_status: StoredReviewAnchorStatus,
  status: Schema.Literals(["open", "closed"]),
  closed_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

/** Flat anchor columns contradict the canonical current-anchor lifecycle. */
export class ReviewAnchorRowDecodeError extends Schema.TaggedError<ReviewAnchorRowDecodeError>()(
  "ReviewAnchorRowDecodeError",
  {
    threadId: ReviewThreadId,
    anchorStatus: StoredReviewAnchorStatus,
    hasCurrentAnchor: Schema.Boolean,
    reason: Schema.NonEmptyString,
  },
) {}

/** Canonical flat columns written for one CurrentReviewAnchor state. */
export const encodeCurrentReviewAnchorRow = (currentAnchor: CurrentReviewAnchor) => {
  return Match.value(currentAnchor).pipe(
    Match.tag("Active", (active) => ({
      currentAnchor: active.anchor,
      anchorStatus: "active" as const,
    })),
    Match.tag("Outdated", () => ({ currentAnchor: null, anchorStatus: "outdated" as const })),
    Match.tag("Unresolved", () => ({
      currentAnchor: null,
      anchorStatus: "unresolved_anchor" as const,
    })),
    Match.exhaustive,
  )
}

/** Maps legacy flat columns into a valid CurrentReviewAnchor state. */
export const decodeCurrentReviewAnchorRow = (
  row: typeof ReviewThreadRow.Type,
): Effect.Effect<CurrentReviewAnchor, ReviewAnchorRowDecodeError> => {
  if (row.anchor_status === "active" || row.anchor_status === "carried_forward") {
    return row.current_anchor_json === null
      ? invalidAnchorRow(row, "Active anchor statuses require a current anchor.")
      : Effect.succeed(CurrentReviewAnchor.cases.Active.make({ anchor: row.current_anchor_json }))
  }
  if (row.current_anchor_json !== null) {
    return invalidAnchorRow(row, "Inactive anchor statuses cannot retain a current anchor.")
  }
  return Effect.succeed(
    row.anchor_status === "outdated"
      ? CurrentReviewAnchor.cases.Outdated.make({})
      : CurrentReviewAnchor.cases.Unresolved.make({}),
  )
}

/** Converts a decoded SQLite row into the invariant-preserving domain model. */
export const makeReviewThreadFromRow = (row: typeof ReviewThreadRow.Type) =>
  decodeCurrentReviewAnchorRow(row).pipe(
    Effect.flatMap((currentAnchor) =>
      ReviewThread.makeEffect({
        id: row.id,
        repoId: row.repo_id,
        reviewKey: row.review_key,
        prNumber: row.pr_number,
        baseRevision: row.base_sha,
        headRevision: row.head_sha,
        currentBaseRevision: row.current_base_sha,
        currentHeadRevision: row.current_head_sha,
        originalAnchor: row.original_anchor_json,
        currentAnchor,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    ),
  )

/** Decodes an unknown SQLite row and maps it to the review-thread domain model. */
export const decodeReviewThreadRow = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(ReviewThreadRow)(input).pipe(Effect.flatMap(makeReviewThreadFromRow))

const invalidAnchorRow = (row: typeof ReviewThreadRow.Type, reason: string) =>
  Effect.fail(
    ReviewAnchorRowDecodeError.make({
      threadId: row.id,
      anchorStatus: row.anchor_status,
      hasCurrentAnchor: row.current_anchor_json !== null,
      reason,
    }),
  )
