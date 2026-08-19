/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { GitFileRevision, type ReviewDecision } from "@diffdash/domain/git-provider"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewRevision,
  type ReviewFilePatchHash,
  type ReviewKey,
} from "@diffdash/domain/review-identity"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  HostedReviewRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "@diffdash/protocol/hosted-git"
import { OpenRepositoryComparisonFileRequest } from "@diffdash/protocol/review-snapshot"
import {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  RepositoryComparisonViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  SetRepositoryComparisonViewedFileRequest,
  type ViewedFileRecord,
} from "@diffdash/protocol/viewed-files"
import { Context, Effect, Layer, Match } from "effect"

import type { RendererReview } from "@/review/review-subject"
import { PreloadClient } from "./preload-client"
import { invokePreload } from "./renderer-api-error"
import { runRendererPromise } from "./renderer-effect"

type ReviewSourcePreloadApi = {
  readonly hostedReviews: Pick<DiffDashBridgeApi["hostedReviews"], "getDecision" | "submitDecision">
  readonly openLocalRepositoryFile: DiffDashBridgeApi["openLocalRepositoryFile"]
  readonly openRepositoryFile: DiffDashBridgeApi["openRepositoryFile"]
  readonly repositoryComparisons: Pick<DiffDashBridgeApi["repositoryComparisons"], "openFile">
  readonly viewedFiles: DiffDashBridgeApi["viewedFiles"]
}

type HostedRendererReview = Extract<RendererReview, { readonly _tag: "hosted" }>
type LocalRendererReview = Extract<RendererReview, { readonly _tag: "local" }>
type RepositoryComparisonRendererReview = Extract<
  RendererReview,
  { readonly _tag: "repositoryComparison" }
>

/** One optimistic viewed-file write normalized across review sources. */
export type ReviewViewedFileWrite = {
  readonly reviewKey: ReviewKey
  readonly patchHash: ReviewFilePatchHash
  readonly viewed: boolean
}

/** Hosted review-decision operations, tagged separately from unsupported sources. */
type ReviewDecisionOperations =
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "supported"
      readonly get: () => Promise<ReviewDecision>
      readonly approve: () => Promise<void>
    }

/** Source-owned operations consumed by review UI without protocol or source branching. */
export type ReviewSourceOperationSet = {
  readonly listViewedFiles: () => Promise<readonly ViewedFileRecord[]>
  readonly setViewedFile: (write: ReviewViewedFileWrite) => Promise<void>
  readonly openFile: (path: string) => Promise<void>
  readonly decision: ReviewDecisionOperations
}

/** Platform factory for the source-specific operations of an authoritative ready review. */
export class ReviewSourceOperations extends Context.Service<
  ReviewSourceOperations,
  { readonly make: (review: RendererReview) => ReviewSourceOperationSet }
>()("@diffdash/app/ReviewSourceOperations") {}

/** Builds source operations directly against one typed preload client. */
export const makeReviewSourceOperations = (
  api: ReviewSourcePreloadApi,
  review: RendererReview,
): ReviewSourceOperationSet => {
  return Match.valueTags(review, {
    hosted: (review: HostedRendererReview) => {
      const summary = review.manifest.detail.summary
      return {
        listViewedFiles: () =>
          runRendererPromise(
            invokePreload(InvokeChannel.listViewedFiles, () =>
              api.viewedFiles.list(
                HostedViewedFilesRequest.make({
                  review: summary.locator,
                  baseRefName: summary.base.name,
                }),
              ),
            ),
          ),
        setViewedFile: (write: ReviewViewedFileWrite) =>
          runRendererPromise(
            invokePreload(InvokeChannel.setViewedFile, () =>
              api.viewedFiles.set(
                SetHostedViewedFileRequest.make({
                  review: summary.locator,
                  baseRefName: summary.base.name,
                  ...write,
                }),
              ),
            ),
          ),
        openFile: (path: string) =>
          runRendererPromise(
            invokePreload(InvokeChannel.appOpenRepositoryFile, () =>
              api.openRepositoryFile(
                OpenHostedReviewFileRequest.make({
                  review: summary.locator,
                  filePath: RepositoryRelativePath.make(path),
                  headRefName: GitFileRevision.make(summary.head.name),
                  headRevision:
                    summary.head.revision === null
                      ? null
                      : ReviewRevision.make(summary.head.revision),
                }),
              ),
            ),
          ),
        decision:
          review.provider?.capabilities.reviewDecisions === true
            ? {
                _tag: "supported" as const,
                get: () =>
                  runRendererPromise(
                    invokePreload(InvokeChannel.getHostedReviewDecision, () =>
                      api.hostedReviews.getDecision(
                        HostedReviewRequest.make({ review: summary.locator }),
                      ),
                    ),
                  ),
                approve: () =>
                  runRendererPromise(
                    invokePreload(InvokeChannel.submitHostedReviewDecision, () =>
                      api.hostedReviews.submitDecision(
                        SubmitHostedReviewDecisionRequest.make({
                          review: summary.locator,
                          decision: "approved",
                        }),
                      ),
                    ),
                  ),
              }
            : { _tag: "unsupported" as const },
      }
    },

    repositoryComparison: (review: RepositoryComparisonRendererReview) => {
      const target = review.target
      return {
        listViewedFiles: () =>
          runRendererPromise(
            invokePreload(InvokeChannel.listRepositoryComparisonViewedFiles, () =>
              api.viewedFiles.listRepositoryComparison(
                RepositoryComparisonViewedFilesRequest.make({ target }),
              ),
            ),
          ),
        setViewedFile: (write: ReviewViewedFileWrite) =>
          runRendererPromise(
            invokePreload(InvokeChannel.setRepositoryComparisonViewedFile, () =>
              api.viewedFiles.setRepositoryComparison(
                SetRepositoryComparisonViewedFileRequest.make({ target, ...write }),
              ),
            ),
          ),
        openFile: (filePath: string) =>
          runRendererPromise(
            invokePreload(InvokeChannel.appOpenRepositoryComparisonFile, () =>
              api.repositoryComparisons.openFile(
                OpenRepositoryComparisonFileRequest.make({
                  target,
                  filePath: RepositoryRelativePath.make(filePath),
                }),
              ),
            ),
          ),
        decision: { _tag: "unsupported" as const },
      }
    },

    local: (review: LocalRendererReview) => {
      const detail = review.manifest.detail
      const target = review.target
      return {
        listViewedFiles: () =>
          runRendererPromise(
            invokePreload(InvokeChannel.listLocalViewedFiles, () =>
              api.viewedFiles.listLocal(
                LocalViewedFilesRequest.make({ target, sourceBranch: detail.branchName }),
              ),
            ),
          ),
        setViewedFile: (write: ReviewViewedFileWrite) =>
          runRendererPromise(
            invokePreload(InvokeChannel.setLocalViewedFile, () =>
              api.viewedFiles.setLocal(
                SetLocalViewedFileRequest.make({
                  target,
                  sourceBranch: detail.branchName,
                  ...write,
                }),
              ),
            ),
          ),
        openFile: (path: string) =>
          runRendererPromise(
            invokePreload(InvokeChannel.appOpenLocalRepositoryFile, () =>
              api.openLocalRepositoryFile(
                RepositoryCheckoutPath.make(detail.rootPath),
                RepositoryRelativePath.make(path),
                target,
              ),
            ),
          ),
        decision: { _tag: "unsupported" as const },
      }
    },
  })
}

/** Desktop implementation of authoritative review source operations. */
export const reviewSourceOperationsLayer = Layer.effect(
  ReviewSourceOperations,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return ReviewSourceOperations.of({
      make: (review) => makeReviewSourceOperations(api, review),
    })
  }),
)
