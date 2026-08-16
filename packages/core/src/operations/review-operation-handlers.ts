import { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { GitProvider } from "../services/git-provider"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import type { OperationHandlersFor } from "./operation-handlers"

type ReviewMethod =
  | typeof CoreMethod.getHostedReviewDecision
  | typeof CoreMethod.listAssignedHostedReviews
  | typeof CoreMethod.listHostedReviews
  | typeof CoreMethod.resolveRepositoryComparison
  | typeof CoreMethod.submitHostedReviewDecision

/** Acquires review snapshot, comparison, listing, and decision handlers. */
export const makeReviewOperationHandlers: Effect.Effect<
  OperationHandlersFor<ReviewMethod>,
  never,
  GitProvider | RepositoryComparisonSource
> = Effect.gen(function* () {
  const comparisons = yield* RepositoryComparisonSource
  const gitProvider = yield* GitProvider

  return {
    [CoreMethod.getHostedReviewDecision]: ({ review }) => gitProvider.getReviewDecision(review),
    [CoreMethod.listAssignedHostedReviews]: ({ providerId }) =>
      gitProvider.listAssignedReviews(providerId),
    [CoreMethod.listHostedReviews]: ({ repository }) => gitProvider.listHostedReviews(repository),
    [CoreMethod.resolveRepositoryComparison]: ({ command }) =>
      Effect.gen(function* () {
        const target = yield* comparisons.resolve(command)
        const repo = yield* comparisons.repository(target)
        return ResolvedRepositoryComparison.make({ repo, target })
      }),
    [CoreMethod.submitHostedReviewDecision]: ({ review, decision }) =>
      gitProvider.submitReviewDecision(review, decision),
  } satisfies OperationHandlersFor<ReviewMethod>
})
