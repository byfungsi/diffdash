/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import type { GitProviderDescriptor } from "@diffdash/domain/git-provider"
import type {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
  ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import { formatError } from "@/shared/errors"
import type { RendererFailure } from "@/shared/errors"
import { Match } from "effect"
import {
  pullRequestAtomKey,
  serializeLocalReviewAtomKey,
  serializeRepositoryComparisonAtomKey,
} from "./atoms"
import {
  projectRendererReview,
  type RendererReview,
  type SelectedReviewTarget,
} from "./review-subject"

/** Renderer load state supplied to the pure review-selection projection. */
export type ReviewManifestLoadState<Manifest extends ReviewSnapshotManifest> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failure"; readonly error: RendererFailure }
  | { readonly _tag: "ready"; readonly manifest: Manifest; readonly refreshing: boolean }

/** One normalized projection of review navigation and source loading state. */
export type ReviewSelectionProjection =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "loading"
      readonly sourceKey: string
      readonly target: SelectedReviewTarget
      readonly status: string
    }
  | {
      readonly _tag: "failure"
      readonly sourceKey: string
      readonly target: SelectedReviewTarget
      readonly status: string
    }
  | {
      readonly _tag: "ready"
      readonly sourceKey: string
      readonly refreshing: boolean
      readonly review: RendererReview
      readonly status: string
    }

/** Stable source keys used by the hosted and local manifest atoms. */
type ReviewSelectionSourceKeys = {
  readonly comparison: string
  readonly hosted: string
  readonly local: string
}

/** Dependencies for projecting one selected review. */
type ReviewSelectionProjectionInput = {
  readonly target: SelectedReviewTarget | null
  readonly hosted: ReviewManifestLoadState<HostedReviewSnapshotManifest>
  readonly local: ReviewManifestLoadState<LocalReviewSnapshotManifest>
  readonly comparison?: ReviewManifestLoadState<RepositoryComparisonSnapshotManifest>
  readonly providers: readonly GitProviderDescriptor[]
}

/** Returns the single active manifest key while leaving the inactive source key empty. */
export const reviewSelectionSourceKeys = (
  target: SelectedReviewTarget | null,
): ReviewSelectionSourceKeys => {
  if (target === null) return { comparison: "", hosted: "", local: "" }
  if (target.kind === "hosted") {
    return {
      comparison: "",
      hosted: pullRequestAtomKey(
        target.review.repository.providerId,
        target.review.repository.namespace,
        target.review.repository.name,
        target.review.number,
      ),
      local: "",
    }
  }
  if (target.kind === "localDiff") {
    return { comparison: "", hosted: "", local: serializeLocalReviewAtomKey(target.target) }
  }
  return {
    comparison: serializeRepositoryComparisonAtomKey(target.target),
    hosted: "",
    local: "",
  }
}

/** Normalizes hosted and local selection state into one tagged projection. */
export const projectReviewSelection = ({
  target,
  hosted,
  local,
  comparison = { _tag: "loading" },
  providers,
}: ReviewSelectionProjectionInput): ReviewSelectionProjection => {
  if (target === null) return { _tag: "none" }

  const sourceKeys = reviewSelectionSourceKeys(target)
  if (target.kind === "hosted") {
    const sourceKey = sourceKeys.hosted
    const abbreviation =
      providers.find((provider) => provider.id === target.review.repository.providerId)?.terminology
        .reviewAbbreviation ?? "review"
    return Match.valueTags(hosted, {
      loading: () => {
        return {
          _tag: "loading" as const,
          sourceKey,
          target,
          status: `Opening ${abbreviation} #${target.review.number}...`,
        }
      },
      failure: (failure) => ({
        _tag: "failure" as const,
        sourceKey,
        target,
        status: formatError(failure.error, "Could not open pull request"),
      }),
      ready: (ready) => {
        const review = projectRendererReview(ready.manifest, providers)
        const summary = ready.manifest.detail.summary
        return {
          _tag: "ready" as const,
          sourceKey,
          refreshing: ready.refreshing,
          review,
          status: `Opened ${review.provider?.terminology.reviewAbbreviation ?? "review"} #${summary.locator.number}: ${summary.title}`,
        }
      },
    })
  }

  if (target.kind === "repositoryComparison") {
    const sourceKey = sourceKeys.comparison
    return Match.valueTags(comparison, {
      loading: () => ({
        _tag: "loading" as const,
        sourceKey,
        target,
        status: "Opening repository comparison...",
      }),
      failure: (failure) => ({
        _tag: "failure" as const,
        sourceKey,
        target,
        status: formatError(failure.error, "Could not open repository comparison"),
      }),
      ready: (ready) => {
        const review = projectRendererReview(ready.manifest, providers)
        return {
          _tag: "ready" as const,
          sourceKey,
          refreshing: ready.refreshing,
          review,
          status: `Opened ${review.target.baseRef}...${review.target.headRef}`,
        }
      },
    })
  }

  const sourceKey = sourceKeys.local
  return Match.valueTags(local, {
    loading: () => ({
      _tag: "loading" as const,
      sourceKey,
      target,
      status: "Opening local changes...",
    }),
    failure: (failure) => ({
      _tag: "failure" as const,
      sourceKey,
      target,
      status: formatError(failure.error, "Could not open local changes"),
    }),
    ready: (ready) => {
      const review = projectRendererReview(ready.manifest, providers)
      return {
        _tag: "ready" as const,
        sourceKey,
        refreshing: ready.refreshing,
        review,
        status:
          ready.manifest.files.length === 0
            ? `No local changes in ${ready.manifest.detail.repoName}`
            : `Opened local changes in ${ready.manifest.detail.repoName}`,
      }
    },
  })
}
