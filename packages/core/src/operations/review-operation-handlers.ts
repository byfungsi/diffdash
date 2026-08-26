import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { ProjectOpened } from "@diffdash/domain/project-workspace"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitService } from "@diffdash/local-git/local-git"
import { ResolvedRepositoryComparison } from "@diffdash/protocol/review-snapshot"
import { Effect, Schema } from "effect"

import { CoreMethod } from "../core-contract"
import { GitProvider } from "../services/git-provider"
import { RepositoryComparisonSource } from "../services/repository-comparison-source"
import { RepositoryLinker, RepositorySelectionIntent } from "../services/repository-linker"
import type { OperationHandlersFor } from "./operation-handlers"

type ReviewMethod =
  | typeof CoreMethod.getHostedReviewDecision
  | typeof CoreMethod.getHostedReviewDetail
  | typeof CoreMethod.getHostedReviewChecks
  | typeof CoreMethod.closeHostedReview
  | typeof CoreMethod.mergeHostedReview
  | typeof CoreMethod.updateHostedReviewBranch
  | typeof CoreMethod.listAssignedHostedReviews
  | typeof CoreMethod.listHostedReviews
  | typeof CoreMethod.resolveRepositoryComparison
  | typeof CoreMethod.submitHostedReviewDecision

/** Acquires review snapshot, comparison, listing, and decision handlers. */
export const makeReviewOperationHandlers: Effect.Effect<
  OperationHandlersFor<ReviewMethod>,
  never,
  GitProvider | GitService | RepositoryComparisonSource | RepositoryLinker
> = Effect.gen(function* () {
  const comparisons = yield* RepositoryComparisonSource
  const git = yield* GitService
  const gitProvider = yield* GitProvider
  const repositories = yield* RepositoryLinker

  return {
    [CoreMethod.getHostedReviewDecision]: ({ review }) => gitProvider.getReviewDecision(review),
    [CoreMethod.getHostedReviewDetail]: ({ review }) => gitProvider.getHostedReviewDetail(review),
    [CoreMethod.getHostedReviewChecks]: ({ review }) => gitProvider.listHostedReviewChecks(review),
    [CoreMethod.closeHostedReview]: ({ review }) => gitProvider.closeReview(review),
    [CoreMethod.mergeHostedReview]: ({ review, method, bypassRules, expectedHeadRevision }) =>
      gitProvider.mergeReview(review, method, bypassRules, expectedHeadRevision),
    [CoreMethod.updateHostedReviewBranch]: ({ review }) =>
      gitProvider.updateHostedReviewBranch(review),
    [CoreMethod.listAssignedHostedReviews]: ({ providerId }) =>
      gitProvider.listAssignedReviews(providerId),
    [CoreMethod.listHostedReviews]: ({ repository }) => gitProvider.listHostedReviews(repository),
    [CoreMethod.resolveRepositoryComparison]: ({ command }) =>
      Effect.gen(function* () {
        if (command.repository === null) {
          const opened = yield* repositories.openProject(
            RepositoryCheckoutPath.make(command.localPath),
            RepositorySelectionIntent.Automatic(),
          )
          if (
            Schema.is(ProjectOpened)(opened) &&
            Schema.is(LocalRepositorySource)(opened.repo.source)
          ) {
            const target = yield* git.resolveRevisionRangeComparison(
              RepositoryCheckoutPath.make(command.localPath),
              command.baseRef,
              command.headRef,
            )
            return ResolvedRepositoryComparison.make({ repo: opened.repo, target })
          }
        }
        const target = yield* comparisons.resolve(command)
        const repo = yield* comparisons.repository(target)
        return ResolvedRepositoryComparison.make({ repo, target })
      }),
    [CoreMethod.submitHostedReviewDecision]: ({ review, submission }) =>
      gitProvider.submitReviewDecision(review, submission),
  } satisfies OperationHandlersFor<ReviewMethod>
})
