import { RepositoryCheckoutPath, type Repo } from "@diffdash/domain/repository"
import {
  HostedReviewDescriptor,
  type HostedReviewSnapshotManifest,
  LocalReviewDescriptor,
  type LocalReviewSnapshotManifest,
  RepositoryComparisonReviewDescriptor,
  type RepositoryComparisonSnapshotManifest,
  type ReviewDescriptor,
  type ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import type { HostedReviewNumber } from "@diffdash/domain/git-provider"
import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Effect } from "effect"

import type { CoreThreadResolutionFailure } from "../core-contract"
import { CoreSnapshotAcquisition } from "../core-snapshot-acquisition"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import { RepositoryLinker } from "../services/repository-linker"

/** Repository and durable immutable snapshot metadata resolved for one review target. */
export interface ResolvedReview<Snapshot extends ReviewSnapshotManifest = ReviewSnapshotManifest> {
  readonly repo: Repo
  readonly snapshot: Snapshot
  readonly descriptor: ReviewDescriptor
  readonly prNumber: HostedReviewNumber | null
}

/** Shared review-target resolution used by thread and walkthrough capabilities. */
export interface ReviewResolution {
  readonly resolveHosted: (
    target: Extract<ReviewThreadTarget, { readonly kind: "hosted" }>,
  ) => Effect.Effect<ResolvedReview<HostedReviewSnapshotManifest>, CoreThreadResolutionFailure>
  readonly resolveRepositoryComparison: (
    target: Extract<ReviewThreadTarget, { readonly kind: "repositoryComparison" }>,
  ) => Effect.Effect<
    ResolvedReview<RepositoryComparisonSnapshotManifest>,
    CoreThreadResolutionFailure
  >
  readonly resolveLocal: (
    target: Extract<ReviewThreadTarget, { readonly kind: "local" }>,
  ) => Effect.Effect<ResolvedReview<LocalReviewSnapshotManifest>, CoreThreadResolutionFailure>
  readonly resolve: (
    target: ReviewThreadTarget,
  ) => Effect.Effect<ResolvedReview, CoreThreadResolutionFailure>
}

/** Acquires the dependencies needed to resolve every supported review target. */
export const makeReviewResolution: Effect.Effect<
  ReviewResolution,
  never,
  CoreSnapshotAcquisition | RepositoryComparisonSource | RepositoryLinker
> = Effect.gen(function* () {
  const acquisition = yield* CoreSnapshotAcquisition
  const comparisons = yield* RepositoryComparisonSource
  const repositories = yield* RepositoryLinker

  const resolveHosted: ReviewResolution["resolveHosted"] = Effect.fn("Core.Reviews.resolveHosted")(
    function* (target) {
      const snapshot = yield* acquisition.acquireHosted(target.review)
      const repo = yield* repositories.ensureHosted(target.review.repository, "preserve")
      const summary = snapshot.detail.summary
      return {
        repo,
        snapshot,
        descriptor: HostedReviewDescriptor.make({
          review: summary.locator,
          title: summary.title,
          authorUsername: summary.author.username,
          state: summary.state,
          draft: summary.draft,
          baseRef: summary.base.name,
          headRef: summary.head.name,
          url: summary.url,
        }),
        prNumber: target.review.number,
      }
    },
  )
  const resolveRepositoryComparison: ReviewResolution["resolveRepositoryComparison"] = Effect.fn(
    "Core.Reviews.resolveRepositoryComparison",
  )(function* (target) {
    const snapshot = yield* acquisition.acquireComparison(target)
    const repo = yield* comparisons.repository(target)
    return {
      repo,
      snapshot,
      descriptor: RepositoryComparisonReviewDescriptor.make({
        target: snapshot.detail.target,
        title: snapshot.detail.title,
        fetchedAt: snapshot.detail.fetchedAt,
      }),
      prNumber: null,
    }
  })
  const resolveLocal: ReviewResolution["resolveLocal"] = Effect.fn("Core.Reviews.resolveLocal")(
    function* (target) {
      const snapshot = yield* acquisition.acquireLocal(target)
      const repo = yield* repositories.ensureLocal(
        RepositoryCheckoutPath.make(snapshot.detail.rootPath),
      )
      return {
        repo,
        snapshot,
        descriptor: LocalReviewDescriptor.make({
          target,
          repoName: snapshot.detail.repoName,
          branchName: snapshot.detail.branchName,
          title: snapshot.detail.title,
          fetchedAt: snapshot.detail.fetchedAt,
        }),
        prNumber: null,
      }
    },
  )
  const resolve: ReviewResolution["resolve"] = Effect.fn("Core.Reviews.resolve")(
    function* (target) {
      switch (target.kind) {
        case "hosted":
          return yield* resolveHosted(target)
        case "repositoryComparison":
          return yield* resolveRepositoryComparison(target)
        case "local":
          return yield* resolveLocal(target)
      }
    },
  )

  return { resolve, resolveHosted, resolveRepositoryComparison, resolveLocal }
})
