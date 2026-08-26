/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import {
  GitFileRevision,
  HostedReviewSubmission,
  type GitProviderDescriptor,
  type HostedReviewMergeMethod,
  type HostedReviewSubmissionDecision,
  type HostedReviewSummary,
  type ReviewDecision,
} from "@diffdash/domain/git-provider"
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
  CloseHostedReviewRequest,
  HostedReviewRequest,
  MergeHostedReviewRequest,
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
  readonly hostedReviews: Pick<
    DiffDashBridgeApi["hostedReviews"],
    "close" | "getDecision" | "merge" | "submitDecision" | "updateBranch"
  >
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

/** Hosted review mutations available before a diff snapshot has been acquired. */
export type HostedReviewMutationOperations = {
  readonly close: (() => Promise<void>) | null
  readonly merge: ((method: HostedReviewMergeMethod, bypassRules: boolean) => Promise<void>) | null
  readonly mergeBypassSupported: boolean
  readonly updateBranch: (() => Promise<void>) | null
  readonly submit:
    | ((decision: HostedReviewSubmissionDecision, body: string) => Promise<void>)
    | null
}

/** Platform factory for the source-specific operations of an authoritative ready review. */
export class ReviewSourceOperations extends Context.Service<
  ReviewSourceOperations,
  {
    readonly make: (review: RendererReview) => ReviewSourceOperationSet
    readonly makeHostedMutations: (
      summary: HostedReviewSummary,
      provider: GitProviderDescriptor | null,
    ) => HostedReviewMutationOperations
  }
>()("@diffdash/app/ReviewSourceOperations") {}

/** Builds capability-gated hosted review mutations directly against one typed preload client. */
export const makeHostedReviewMutationOperations = (
  api: ReviewSourcePreloadApi,
  summary: HostedReviewSummary,
  provider: GitProviderDescriptor | null,
): HostedReviewMutationOperations => {
  const expectedHeadRevision = summary.head.revision
  return {
    submit:
      provider?.capabilities.reviewDecisions === true
        ? (decision, body) =>
            runRendererPromise(
              invokePreload(InvokeChannel.submitHostedReviewDecision, () =>
                api.hostedReviews.submitDecision(
                  SubmitHostedReviewDecisionRequest.make({
                    review: summary.locator,
                    submission: HostedReviewSubmission.make({ decision, body }),
                  }),
                ),
              ),
            )
        : null,
    close:
      provider?.capabilities.reviewClosure === true
        ? () =>
            runRendererPromise(
              invokePreload(InvokeChannel.closeHostedReview, () =>
                api.hostedReviews.close(CloseHostedReviewRequest.make({ review: summary.locator })),
              ),
            )
        : null,
    merge:
      provider?.capabilities.reviewMerge === true && expectedHeadRevision !== null
        ? (method, bypassRules) =>
            runRendererPromise(
              invokePreload(InvokeChannel.mergeHostedReview, () =>
                api.hostedReviews.merge(
                  MergeHostedReviewRequest.make({
                    review: summary.locator,
                    method,
                    bypassRules,
                    expectedHeadRevision,
                  }),
                ),
              ),
            )
        : null,
    mergeBypassSupported: provider?.capabilities.reviewMergeBypass === true,
    updateBranch:
      provider?.capabilities.reviewBranchUpdates === true
        ? () =>
            runRendererPromise(
              invokePreload(InvokeChannel.updateHostedReviewBranch, () =>
                api.hostedReviews.updateBranch(
                  HostedReviewRequest.make({ review: summary.locator }),
                ),
              ),
            )
        : null,
  }
}

/** Builds source operations directly against one typed preload client. */
export const makeReviewSourceOperations = (
  api: ReviewSourcePreloadApi,
  rendererReview: RendererReview,
): ReviewSourceOperationSet => {
  return Match.valueTags(rendererReview, {
    hosted: (hostedReview: HostedRendererReview) => {
      const summary = hostedReview.manifest.detail.summary
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
          hostedReview.provider?.capabilities.reviewDecisions === true
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
                          submission: HostedReviewSubmission.make({
                            decision: "approved",
                            body: "",
                          }),
                        }),
                      ),
                    ),
                  ),
              }
            : { _tag: "unsupported" as const },
      }
    },

    repositoryComparison: (repositoryComparison: RepositoryComparisonRendererReview) => {
      const target = repositoryComparison.target
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

    local: (localReview: LocalRendererReview) => {
      const detail = localReview.manifest.detail
      const target = localReview.target
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
      makeHostedMutations: (summary, provider) =>
        makeHostedReviewMutationOperations(api, summary, provider),
    })
  }),
)
