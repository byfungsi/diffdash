/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { GitFileRevision, type ReviewDecision } from "@diffdash/domain/git-provider"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewRevision,
  type ReviewFilePatchHash,
  type ReviewKey,
} from "@diffdash/domain/review-identity"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  GenerateHostedWalkthroughRequest,
  HostedReviewRequest,
  HostedWalkthroughRequest,
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
import { Context, Effect, Layer, Match, Option } from "effect"

import type { RendererReview } from "@/review/review-subject"
import { PreloadClient } from "./preload-client"
import { invokePreload } from "./renderer-api-error"
import { runRendererPromise } from "./renderer-effect"

type ReviewSourcePreloadApi = {
  readonly hostedReviews: Pick<DiffDashBridgeApi["hostedReviews"], "getDecision" | "submitDecision">
  readonly localWalkthroughs: DiffDashBridgeApi["localWalkthroughs"]
  readonly openLocalRepositoryFile: DiffDashBridgeApi["openLocalRepositoryFile"]
  readonly openRepositoryFile: DiffDashBridgeApi["openRepositoryFile"]
  readonly repositoryComparisons: Pick<DiffDashBridgeApi["repositoryComparisons"], "openFile">
  readonly repositoryComparisonWalkthroughs: DiffDashBridgeApi["repositoryComparisonWalkthroughs"]
  readonly viewedFiles: DiffDashBridgeApi["viewedFiles"]
  readonly walkthroughs: DiffDashBridgeApi["walkthroughs"]
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
  readonly source: "hosted" | "local" | "repositoryComparison"
  readonly listViewedFiles: () => Promise<readonly ViewedFileRecord[]>
  readonly setViewedFile: (write: ReviewViewedFileWrite) => Promise<void>
  readonly getWalkthrough: () => Promise<StoredWalkthrough | null>
  readonly generateWalkthrough: (regenerate: boolean) => Promise<StoredWalkthrough>
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
        source: "hosted" as const,
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
        getWalkthrough: () =>
          runRendererPromise(
            invokePreload(InvokeChannel.getWalkthrough, () =>
              api.walkthroughs.get(
                HostedWalkthroughRequest.make({
                  review: summary.locator,
                  baseRevision: review.baseRevision,
                  headRevision: review.headRevision,
                }),
              ),
            ).pipe(Effect.map(Option.fromNullishOr), Effect.map(Option.getOrNull)),
          ),
        generateWalkthrough: (regenerate: boolean) =>
          runRendererPromise(
            invokePreload(InvokeChannel.generateWalkthrough, () =>
              api.walkthroughs.generate(
                GenerateHostedWalkthroughRequest.make({ review: summary.locator, regenerate }),
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
        source: "repositoryComparison" as const,
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
        getWalkthrough: () =>
          runRendererPromise(
            invokePreload(InvokeChannel.getRepositoryComparisonWalkthrough, () =>
              api.repositoryComparisonWalkthroughs.get(target),
            ).pipe(Effect.map(Option.fromNullishOr), Effect.map(Option.getOrNull)),
          ),
        generateWalkthrough: (regenerate: boolean) =>
          runRendererPromise(
            invokePreload(InvokeChannel.generateRepositoryComparisonWalkthrough, () =>
              regenerate
                ? api.repositoryComparisonWalkthroughs.regenerate(target)
                : api.repositoryComparisonWalkthroughs.generate(target),
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
        source: "local" as const,
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
        getWalkthrough: () =>
          runRendererPromise(
            invokePreload(InvokeChannel.getLocalWalkthrough, () =>
              api.localWalkthroughs.get(target, review.baseRevision, review.headRevision),
            ).pipe(Effect.map(Option.fromNullishOr), Effect.map(Option.getOrNull)),
          ),
        generateWalkthrough: (regenerate: boolean) =>
          runRendererPromise(
            invokePreload(InvokeChannel.generateLocalWalkthrough, () =>
              regenerate
                ? api.localWalkthroughs.regenerate(target)
                : api.localWalkthroughs.generate(target),
            ),
          ),
        openFile: (path: string) =>
          runRendererPromise(
            invokePreload(InvokeChannel.appOpenLocalRepositoryFile, () =>
              api.openLocalRepositoryFile(
                RepositoryCheckoutPath.make(detail.rootPath),
                RepositoryRelativePath.make(path),
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
