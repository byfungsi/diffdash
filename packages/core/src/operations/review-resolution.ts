import { RepositoryCheckoutPath, type Repo } from "@diffdash/domain/repository"
import type {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  RepositoryComparisonSnapshot,
  ReviewSnapshot,
} from "@diffdash/domain/review-context"
import type { HostedReviewNumber } from "@diffdash/domain/git-provider"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Effect, Match } from "effect"

import type { CoreThreadResolutionFailure } from "../core-contract"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import { RepositoryLinker } from "../services/repository-linker"
import { ReviewSnapshotService } from "../services/review-snapshot"

/** Repository and immutable snapshot resolved for one review target. */
export interface ResolvedReview<Snapshot extends ReviewSnapshot = ReviewSnapshot> {
  readonly repo: Repo
  readonly snapshot: Snapshot
  readonly prNumber: HostedReviewNumber | null
}

/** Shared review-target resolution used by thread and walkthrough capabilities. */
export interface ReviewResolution {
  readonly resolveHosted: (
    target: Extract<ReviewThreadTarget, { readonly kind: "hosted" }>,
  ) => Effect.Effect<ResolvedReview<HostedReviewSnapshot>, CoreThreadResolutionFailure>
  readonly resolveRepositoryComparison: (
    target: Extract<ReviewThreadTarget, { readonly kind: "repositoryComparison" }>,
  ) => Effect.Effect<ResolvedReview<RepositoryComparisonSnapshot>, CoreThreadResolutionFailure>
  readonly resolveLocal: (
    target: Extract<ReviewThreadTarget, { readonly kind: "local" }>,
  ) => Effect.Effect<ResolvedReview<LocalReviewSnapshot>, CoreThreadResolutionFailure>
  readonly resolve: (
    target: ReviewThreadTarget,
  ) => Effect.Effect<ResolvedReview, CoreThreadResolutionFailure>
}

/** Acquires the dependencies needed to resolve every supported review target. */
export const makeReviewResolution: Effect.Effect<
  ReviewResolution,
  never,
  RepositoryComparisonSource | RepositoryLinker | ReviewSnapshotService
> = Effect.gen(function* () {
  const comparisons = yield* RepositoryComparisonSource
  const repositories = yield* RepositoryLinker
  const snapshots = yield* ReviewSnapshotService

  const resolveHosted: ReviewResolution["resolveHosted"] = Effect.fn("Core.Reviews.resolveHosted")(
    function* (target) {
      const snapshot = yield* snapshots.acquireHosted(target.review)
      const repo = yield* repositories.ensureHosted(target.review.repository)
      return { repo, snapshot, prNumber: target.review.number }
    },
  )
  const resolveRepositoryComparison: ReviewResolution["resolveRepositoryComparison"] = Effect.fn(
    "Core.Reviews.resolveRepositoryComparison",
  )(function* (target) {
    const snapshot = yield* snapshots.acquireComparison(target)
    const repo = yield* comparisons.repository(target)
    return { repo, snapshot, prNumber: null }
  })
  const resolveLocal: ReviewResolution["resolveLocal"] = Effect.fn("Core.Reviews.resolveLocal")(
    function* (target) {
      const snapshot = yield* snapshots.acquireLocal(target)
      const repo = yield* repositories.ensureLocal(
        RepositoryCheckoutPath.make(snapshot.detail.rootPath),
      )
      return { repo, snapshot, prNumber: null }
    },
  )
  const resolve: ReviewResolution["resolve"] = Effect.fn("Core.Reviews.resolve")((target) =>
    Match.value(target).pipe(
      Match.when({ kind: "hosted" }, resolveHosted),
      Match.when({ kind: "repositoryComparison" }, resolveRepositoryComparison),
      Match.when({ kind: "local" }, resolveLocal),
      Match.exhaustive,
    ),
  )

  return { resolve, resolveHosted, resolveRepositoryComparison, resolveLocal }
})
