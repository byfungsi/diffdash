import type { LocalReviewDetail } from "@diffdash/domain/local-review"
import { LocalReviewTarget, localReviewTargetKey } from "@diffdash/domain/local-review"
import type { HostedReviewDetail, HostedReviewLocator } from "@diffdash/domain/git-provider"
import { makeHostedReviewKey } from "@diffdash/domain/git-provider"
import {
  type StoredWalkthrough,
  walkthroughLocalDiffScope,
  walkthroughHostedReviewScope,
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

/** Loaded review detail normalized across hosted and local review sources. */
export type ReviewSubject =
  | { readonly kind: "hosted"; readonly hostedReview: HostedReviewDetail }
  | { readonly kind: "localDiff"; readonly localReview: LocalReviewDetail }

/** Hosted review navigation target. */
export type HostedReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "hosted" }>

/** Local review navigation target. */
export type LocalDiffReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "localDiff" }>

/** Adapts a loaded review into the renderer thread API scope. */
export const reviewThreadScope = (reviewSubject: ReviewSubject): ReviewThreadScope =>
  reviewSubject.kind === "hosted"
    ? {
        kind: "hosted",
        review: reviewSubject.hostedReview.summary.locator,
        baseRevision: reviewSubject.hostedReview.summary.base.revision,
        headRevision: reviewSubject.hostedReview.summary.head.revision,
      }
    : {
        kind: "local",
        target: localReviewTargetFromDetail(reviewSubject.localReview),
        baseRevision: reviewSubject.localReview.baseSha,
        headRevision: reviewSubject.localReview.headSha,
      }

/** Adapts a loaded review into its persisted walkthrough scope. */
export const reviewSubjectWalkthroughScope = (
  reviewSubject: ReviewSubject,
  storedWalkthrough: StoredWalkthrough | null = null,
) =>
  reviewSubject.kind === "hosted"
    ? walkthroughHostedReviewScope(reviewSubject.hostedReview.summary.locator)
    : walkthroughLocalDiffScope(storedWalkthrough?.headSha ?? reviewSubject.localReview.headSha)

/** Returns the review base revision. */
export const reviewSubjectBaseSha = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "hosted"
    ? reviewSubject.hostedReview.summary.base.revision
    : reviewSubject.localReview.baseSha

/** Returns the review head revision. */
export const reviewSubjectHeadSha = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "hosted"
    ? reviewSubject.hostedReview.summary.head.revision
    : reviewSubject.localReview.headSha

/** Returns the renderer identity used to reset review-local state. */
export const reviewSubjectIdentity = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "hosted"
    ? `hosted:${makeHostedReviewKey(reviewSubject.hostedReview.summary.locator)}`
    : `local:${localReviewTargetKey(localReviewTargetFromDetail(reviewSubject.localReview))}`

/** Reconstructs a typed local target from loaded review detail. */
export const localReviewTargetFromDetail = (detail: LocalReviewDetail) =>
  LocalReviewTarget.make({
    kind: "local",
    rootPath: detail.rootPath,
    comparison: detail.comparison,
  })

/** Returns the source repository label shown in review chrome. */
export const reviewSubjectRepositoryLabel = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "hosted"
    ? `${reviewSubject.hostedReview.summary.locator.repository.namespace}/${reviewSubject.hostedReview.summary.locator.repository.name}`
    : reviewSubject.localReview.rootPath

/** Returns the review title shown in review chrome. */
export const reviewSubjectTitle = (reviewSubject: ReviewSubject) =>
  reviewSubject.kind === "hosted"
    ? reviewSubject.hostedReview.summary.title
    : reviewSubject.localReview.title
