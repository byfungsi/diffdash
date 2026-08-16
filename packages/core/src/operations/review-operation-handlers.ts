import {
  REVIEW_SNAPSHOT_PAGE_MAX_BYTES,
  REVIEW_SNAPSHOT_SEARCH_MAX_BYTES,
  ReviewSnapshotExpired,
  ResolvedRepositoryComparison,
} from "@diffdash/protocol/review-snapshot"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { GitProvider } from "../services/git-provider"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import { ReviewSnapshotService } from "../services/review-snapshot"
import {
  paginateReviewSnapshot,
  searchReviewSnapshot,
} from "../services/review-snapshot-pagination"
import type { OperationHandlersFor } from "./operation-handlers"

type ReviewMethod =
  | typeof CoreMethod.getHostedReviewDecision
  | typeof CoreMethod.getReviewSnapshotPage
  | typeof CoreMethod.listAssignedHostedReviews
  | typeof CoreMethod.listHostedReviews
  | typeof CoreMethod.resolveRepositoryComparison
  | typeof CoreMethod.searchReviewSnapshot
  | typeof CoreMethod.submitHostedReviewDecision

/** Acquires review snapshot, comparison, listing, and decision handlers. */
export const makeReviewOperationHandlers: Effect.Effect<
  OperationHandlersFor<ReviewMethod>,
  never,
  GitProvider | RepositoryComparisonSource | ReviewSnapshotService
> = Effect.gen(function* () {
  const comparisons = yield* RepositoryComparisonSource
  const gitProvider = yield* GitProvider
  const snapshots = yield* ReviewSnapshotService

  return {
    [CoreMethod.getHostedReviewDecision]: ({ review }) => gitProvider.getReviewDecision(review),
    [CoreMethod.getReviewSnapshotPage]: (request) =>
      snapshots.get(request.snapshotId).pipe(
        Effect.map((snapshot) =>
          paginateReviewSnapshot(snapshot, request, REVIEW_SNAPSHOT_PAGE_MAX_BYTES),
        ),
        Effect.catchTag("ReviewSnapshotUnavailableError", (error) =>
          Effect.succeed(
            ReviewSnapshotExpired.make({
              snapshotId: request.snapshotId,
              reason: error.reason,
            }),
          ),
        ),
      ),
    [CoreMethod.listAssignedHostedReviews]: ({ providerId }) =>
      gitProvider.listAssignedReviews(providerId),
    [CoreMethod.listHostedReviews]: ({ repository }) => gitProvider.listHostedReviews(repository),
    [CoreMethod.resolveRepositoryComparison]: ({ command }) =>
      Effect.gen(function* () {
        const target = yield* comparisons.resolve(command)
        const repo = yield* comparisons.repository(target)
        return ResolvedRepositoryComparison.make({ repo, target })
      }),
    [CoreMethod.searchReviewSnapshot]: (request) =>
      snapshots.get(request.snapshotId).pipe(
        Effect.flatMap((snapshot) =>
          searchReviewSnapshot(snapshot, request, REVIEW_SNAPSHOT_SEARCH_MAX_BYTES),
        ),
        Effect.catchTag("ReviewSnapshotUnavailableError", (error) =>
          Effect.succeed(
            ReviewSnapshotExpired.make({
              snapshotId: request.snapshotId,
              reason: error.reason,
            }),
          ),
        ),
      ),
    [CoreMethod.submitHostedReviewDecision]: ({ review, decision }) =>
      gitProvider.submitReviewDecision(review, decision),
  } satisfies OperationHandlersFor<ReviewMethod>
})
