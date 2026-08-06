import type { LocalReviewDetail } from "@diffdash/domain/local-review"
import { LocalReviewTarget, localReviewTargetKey } from "@diffdash/domain/local-review"
import type { HostedReviewDetail, HostedReviewLocator } from "@diffdash/domain/git-provider"
import { makeHostedReviewKey } from "@diffdash/domain/git-provider"
import type {
  RepositoryComparisonDetail,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import { makeRepositoryComparisonReviewKey } from "@diffdash/domain/repository-comparison"
import {
  type StoredWalkthrough,
  walkthroughLocalDiffScope,
  walkthroughHostedReviewScope,
  walkthroughRepositoryComparisonScope,
} from "@diffdash/domain/walkthrough"
import type { ReviewThreadScope } from "@/threads/review-threads"

/** Renderer navigation target for a hosted or local review. */
export type SelectedReviewTarget =
  | {
      readonly kind: "hosted"
      readonly review: HostedReviewLocator
    }
  | {
      readonly kind: "localDiff"
      readonly target: LocalReviewTarget
    }
  | {
      readonly kind: "repositoryComparison"
      readonly target: RepositoryComparisonTarget
    }

/** Loaded review detail normalized across hosted and local review sources. */
export type ReviewSubject =
  | { readonly kind: "hosted"; readonly hostedReview: HostedReviewDetail }
  | { readonly kind: "localDiff"; readonly localReview: LocalReviewDetail }
  | {
      readonly kind: "repositoryComparison"
      readonly comparison: RepositoryComparisonDetail
    }

/** Hosted review navigation target. */
export type HostedReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "hosted" }>

/** Local review navigation target. */
export type LocalDiffReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "localDiff" }>

/** Immutable repository comparison navigation target. */
export type RepositoryComparisonReviewTarget = Extract<
  SelectedReviewTarget,
  { readonly kind: "repositoryComparison" }
>

/** Adapts a loaded review into the renderer thread API scope. */
export const reviewThreadScope = (reviewSubject: ReviewSubject): ReviewThreadScope => {
  if (reviewSubject.kind === "hosted") {
    return {
      kind: "hosted",
      review: reviewSubject.hostedReview.summary.locator,
      baseRevision: reviewSubject.hostedReview.summary.base.revision,
      headRevision: reviewSubject.hostedReview.summary.head.revision,
    }
  }
  if (reviewSubject.kind === "localDiff") {
    return {
      kind: "local",
      target: localReviewTargetFromDetail(reviewSubject.localReview),
      baseRevision: reviewSubject.localReview.baseSha,
      headRevision: reviewSubject.localReview.headSha,
    }
  }
  return {
    kind: "repositoryComparison",
    target: reviewSubject.comparison.target,
    baseRevision: reviewSubject.comparison.target.mergeBaseSha,
    headRevision: reviewSubject.comparison.target.headSha,
  }
}

/** Adapts a loaded review into its persisted walkthrough scope. */
export const reviewSubjectWalkthroughScope = (
  reviewSubject: ReviewSubject,
  storedWalkthrough: StoredWalkthrough | null = null,
) => {
  if (reviewSubject.kind === "hosted") {
    return walkthroughHostedReviewScope(reviewSubject.hostedReview.summary.locator)
  }
  if (reviewSubject.kind === "localDiff") {
    return walkthroughLocalDiffScope(
      storedWalkthrough?.headSha ?? reviewSubject.localReview.headSha,
    )
  }
  return walkthroughRepositoryComparisonScope(
    makeRepositoryComparisonReviewKey(reviewSubject.comparison.target),
  )
}

/** Returns the review base revision. */
export const reviewSubjectBaseSha = (reviewSubject: ReviewSubject) => {
  if (reviewSubject.kind === "hosted") return reviewSubject.hostedReview.summary.base.revision
  if (reviewSubject.kind === "localDiff") return reviewSubject.localReview.baseSha
  return reviewSubject.comparison.target.mergeBaseSha
}

/** Returns the review head revision. */
export const reviewSubjectHeadSha = (reviewSubject: ReviewSubject) => {
  if (reviewSubject.kind === "hosted") return reviewSubject.hostedReview.summary.head.revision
  if (reviewSubject.kind === "localDiff") return reviewSubject.localReview.headSha
  return reviewSubject.comparison.target.headSha
}

/** Returns the renderer identity used to reset review-local state. */
export const reviewSubjectIdentity = (reviewSubject: ReviewSubject) => {
  if (reviewSubject.kind === "hosted") {
    return `hosted:${makeHostedReviewKey(reviewSubject.hostedReview.summary.locator)}`
  }
  if (reviewSubject.kind === "localDiff") {
    return `local:${localReviewTargetKey(localReviewTargetFromDetail(reviewSubject.localReview))}`
  }
  return `repository-comparison:${makeRepositoryComparisonReviewKey(reviewSubject.comparison.target)}`
}

/** Reconstructs a typed local target from loaded review detail. */
export const localReviewTargetFromDetail = (detail: LocalReviewDetail) =>
  LocalReviewTarget.make({
    kind: "local",
    rootPath: detail.rootPath,
    comparison: detail.comparison,
  })

/** Returns the source repository label shown in review chrome. */
export const reviewSubjectRepositoryLabel = (reviewSubject: ReviewSubject) => {
  if (reviewSubject.kind === "hosted") {
    return `${reviewSubject.hostedReview.summary.locator.repository.namespace}/${reviewSubject.hostedReview.summary.locator.repository.name}`
  }
  if (reviewSubject.kind === "localDiff") return reviewSubject.localReview.rootPath
  return `${reviewSubject.comparison.target.repository.namespace}/${reviewSubject.comparison.target.repository.name}`
}

/** Returns the review title shown in review chrome. */
export const reviewSubjectTitle = (reviewSubject: ReviewSubject) => {
  if (reviewSubject.kind === "hosted") return reviewSubject.hostedReview.summary.title
  if (reviewSubject.kind === "localDiff") return reviewSubject.localReview.title
  return reviewSubject.comparison.title
}
