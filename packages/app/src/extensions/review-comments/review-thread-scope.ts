import { makeReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { localReviewTargetKey } from "@diffdash/domain/local-review"
import { makeRepositoryComparisonReviewKey } from "@diffdash/domain/repository-comparison"
import { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Match, Option, Schema } from "effect"

/** Renderer-owned review scope used to derive typed preload requests. */
export class ReviewThreadScope extends Schema.Class<ReviewThreadScope>("ReviewThreadScope")({
  target: ReviewThreadTarget,
  baseRevision: Schema.OptionFromNullOr(ReviewRevision),
  headRevision: Schema.OptionFromNullOr(ReviewRevision),
}) {}

/** Canonical identity for one review-thread target and revision scope. */
export const ReviewThreadScopeIdentity = Schema.String.pipe(
  Schema.brand("ReviewThreadScopeIdentity"),
)

/** Canonical identity for one review-thread target and revision scope. */
export type ReviewThreadScopeIdentity = typeof ReviewThreadScopeIdentity.Type

const identityPart = (value: Option.Option<string>): string =>
  Option.match(value, {
    onNone: () => "-1:",
    onSome: (part) => `${part.length}:${part}`,
  })

/** Returns the canonical identity shared by review-thread controllers and surfaces. */
export const reviewThreadScopeIdentity = (scope: ReviewThreadScope): ReviewThreadScopeIdentity => {
  const targetIdentity = Match.value(scope.target).pipe(
    Match.when({ kind: "hosted" }, ({ review }) => `hosted:${makeReviewKey(review)}`),
    Match.when({ kind: "local" }, (target) => `local:${localReviewTargetKey(target)}`),
    Match.when(
      { kind: "repositoryComparison" },
      (target) => `repositoryComparison:${makeRepositoryComparisonReviewKey(target)}`,
    ),
    Match.exhaustive,
  )
  return ReviewThreadScopeIdentity.make(
    `${targetIdentity}${identityPart(scope.baseRevision)}${identityPart(scope.headRevision)}`,
  )
}

/** Returns the analytics category for a review-thread target. */
export const reviewThreadTargetType = (
  target: ReviewThreadTarget,
): "pull_request" | "local_diff" | "repository_comparison" =>
  Match.value(target).pipe(
    Match.when({ kind: "hosted" }, () => "pull_request" as const),
    Match.when({ kind: "local" }, () => "local_diff" as const),
    Match.when({ kind: "repositoryComparison" }, () => "repository_comparison" as const),
    Match.exhaustive,
  )
