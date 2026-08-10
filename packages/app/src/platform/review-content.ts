import { Context, Effect, Layer } from "effect"

import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import type {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import type { HostedRepositoryRequest, HostedReviewRequest } from "@diffdash/protocol/hosted-git"
import type {
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
  ReviewSnapshotSearchRequest,
  ReviewSnapshotSearchResponse,
} from "@diffdash/protocol/review-snapshot"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer review discovery and immutable snapshot page/search capabilities. */
export class ReviewContent extends Context.Service<
  ReviewContent,
  {
    readonly hostedReviews: {
      readonly list: (
        request: HostedRepositoryRequest,
      ) => Effect.Effect<readonly HostedReviewSummary[], RendererApiError>
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
  }
>()("@diffdash/app/ReviewContent") {}

/** Desktop implementation of renderer review content capabilities. */
export const reviewContentLayer = Layer.effect(
  ReviewContent,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return ReviewContent.of({
      hostedReviews: {
        list: (request) =>
          invokePreload(InvokeChannel.listHostedReviews, () => api.hostedReviews.list(request)),
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
    })
  }),
)
