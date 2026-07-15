import { Schema } from "effect"

import {
  LocalReviewDetail,
  LocalReviewDiff,
  ParsedDiff,
  PullRequestDetail,
  PullRequestDiff,
} from "./domain"
import { ReviewKey, ReviewRevision } from "./review-identity"

/** Coherent metadata and diff content for one GitHub pull request revision. */
export class PullRequestReviewSnapshot extends Schema.TaggedClass<PullRequestReviewSnapshot>()(
  "pullRequest",
  {
    reviewKey: ReviewKey,
    baseRevision: ReviewRevision,
    headRevision: ReviewRevision,
    detail: PullRequestDetail,
    diff: PullRequestDiff,
    parsedDiff: ParsedDiff,
  },
) {}

/** Coherent metadata and diff content for one local working-tree revision. */
export class LocalReviewSnapshot extends Schema.TaggedClass<LocalReviewSnapshot>()("local", {
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  detail: LocalReviewDetail,
  diff: LocalReviewDiff,
  parsedDiff: ParsedDiff,
}) {}

/** A coherent local or provider-backed review revision. */
export const ReviewSnapshot = Schema.Union(PullRequestReviewSnapshot, LocalReviewSnapshot)

/** A coherent local or provider-backed review revision. */
export type ReviewSnapshot = typeof ReviewSnapshot.Type
