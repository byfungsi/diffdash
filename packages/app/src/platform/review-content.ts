import { Context, Effect, Layer } from "effect"

import type { HostedReviewSummary, ReviewDecision } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import type {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import type {
  HostedRepositoryRequest,
  HostedReviewRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "@diffdash/protocol/hosted-git"
import type {
  OpenRepositoryComparisonFileRequest,
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
  ReviewSnapshotSearchRequest,
  ReviewSnapshotSearchResponse,
} from "@diffdash/protocol/review-snapshot"
import type {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  RepositoryComparisonViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  SetRepositoryComparisonViewedFileRequest,
  ViewedFileRecord,
} from "@diffdash/protocol/viewed-files"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer review discovery, immutable snapshot, viewed-state, decision, and file capabilities. */
export class ReviewContent extends Context.Tag("@diffdash/app/ReviewContent")<
  ReviewContent,
  {
    readonly hostedReviews: {
      readonly list: (
        request: HostedRepositoryRequest,
      ) => Effect.Effect<readonly HostedReviewSummary[], RendererApiError>
      readonly getDecision: (
        request: HostedReviewRequest,
      ) => Effect.Effect<ReviewDecision, RendererApiError>
      readonly submitDecision: (
        request: SubmitHostedReviewDecisionRequest,
      ) => Effect.Effect<void, RendererApiError>
    }
    readonly snapshots: {
      readonly acquireHosted: (
        request: HostedReviewRequest,
      ) => Effect.Effect<HostedReviewSnapshotManifest, RendererApiError>
      readonly acquireLocal: (
        target: LocalReviewTarget,
      ) => Effect.Effect<LocalReviewSnapshotManifest, RendererApiError>
      readonly acquireRepositoryComparison: (
        target: RepositoryComparisonTarget,
      ) => Effect.Effect<RepositoryComparisonSnapshotManifest, RendererApiError>
      readonly getPage: (
        request: ReviewSnapshotPageRequest,
      ) => Effect.Effect<ReviewSnapshotPageResponse, RendererApiError>
      readonly search: (
        request: ReviewSnapshotSearchRequest,
      ) => Effect.Effect<ReviewSnapshotSearchResponse, RendererApiError>
    }
    readonly viewedFiles: {
      readonly listHosted: (
        request: HostedViewedFilesRequest,
      ) => Effect.Effect<readonly ViewedFileRecord[], RendererApiError>
      readonly setHosted: (
        request: SetHostedViewedFileRequest,
      ) => Effect.Effect<void, RendererApiError>
      readonly listLocal: (
        request: LocalViewedFilesRequest,
      ) => Effect.Effect<readonly ViewedFileRecord[], RendererApiError>
      readonly setLocal: (
        request: SetLocalViewedFileRequest,
      ) => Effect.Effect<void, RendererApiError>
      readonly listRepositoryComparison: (
        request: RepositoryComparisonViewedFilesRequest,
      ) => Effect.Effect<readonly ViewedFileRecord[], RendererApiError>
      readonly setRepositoryComparison: (
        request: SetRepositoryComparisonViewedFileRequest,
      ) => Effect.Effect<void, RendererApiError>
    }
    readonly openHostedFile: (
      request: OpenHostedReviewFileRequest,
    ) => Effect.Effect<void, RendererApiError>
    readonly openLocalFile: (
      rootPath: string,
      filePath: string,
    ) => Effect.Effect<void, RendererApiError>
    readonly openRepositoryComparisonFile: (
      request: OpenRepositoryComparisonFileRequest,
    ) => Effect.Effect<void, RendererApiError>
  }
>() {}

/** Desktop implementation of renderer review content capabilities. */
export const reviewContentLayer = Layer.effect(
  ReviewContent,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return ReviewContent.of({
      hostedReviews: {
        list: (request) =>
          invokePreload(InvokeChannel.listHostedReviews, () => api.hostedReviews.list(request)),
        getDecision: (request) =>
          invokePreload(InvokeChannel.getHostedReviewDecision, () =>
            api.hostedReviews.getDecision(request),
          ),
        submitDecision: (request) =>
          invokePreload(InvokeChannel.submitHostedReviewDecision, () =>
            api.hostedReviews.submitDecision(request),
          ),
      },
      snapshots: {
        acquireHosted: (request) =>
          invokePreload(InvokeChannel.acquireHostedReviewSnapshot, () =>
            api.reviewSnapshots.acquireHosted(request),
          ),
        acquireLocal: (target) =>
          invokePreload(InvokeChannel.acquireLocalReviewSnapshot, () =>
            api.reviewSnapshots.acquireLocal(target),
          ),
        acquireRepositoryComparison: (target) =>
          invokePreload(InvokeChannel.acquireRepositoryComparisonSnapshot, () =>
            api.reviewSnapshots.acquireRepositoryComparison(target),
          ),
        getPage: (request) =>
          invokePreload(InvokeChannel.getReviewSnapshotPage, () =>
            api.reviewSnapshots.getPage(request),
          ),
        search: (request) =>
          invokePreload(InvokeChannel.searchReviewSnapshot, () =>
            api.reviewSnapshots.search(request),
          ),
      },
      viewedFiles: {
        listHosted: (request) =>
          invokePreload(InvokeChannel.listViewedFiles, () => api.viewedFiles.list(request)),
        setHosted: (request) =>
          invokePreload(InvokeChannel.setViewedFile, () => api.viewedFiles.set(request)),
        listLocal: (request) =>
          invokePreload(InvokeChannel.listLocalViewedFiles, () =>
            api.viewedFiles.listLocal(request),
          ),
        setLocal: (request) =>
          invokePreload(InvokeChannel.setLocalViewedFile, () => api.viewedFiles.setLocal(request)),
        listRepositoryComparison: (request) =>
          invokePreload(InvokeChannel.listRepositoryComparisonViewedFiles, () =>
            api.viewedFiles.listRepositoryComparison(request),
          ),
        setRepositoryComparison: (request) =>
          invokePreload(InvokeChannel.setRepositoryComparisonViewedFile, () =>
            api.viewedFiles.setRepositoryComparison(request),
          ),
      },
      openHostedFile: (request) =>
        invokePreload(InvokeChannel.appOpenRepositoryFile, () => api.openRepositoryFile(request)),
      openLocalFile: (rootPath, filePath) =>
        invokePreload(InvokeChannel.appOpenLocalRepositoryFile, () =>
          api.openLocalRepositoryFile(rootPath, filePath),
        ),
      openRepositoryComparisonFile: (request) =>
        invokePreload(InvokeChannel.appOpenRepositoryComparisonFile, () =>
          api.repositoryComparisons.openFile(request),
        ),
    })
  }),
)
