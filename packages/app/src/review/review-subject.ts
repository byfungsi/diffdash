/* oxlint-disable eslint/no-underscore-dangle -- Renderer review variants use Effect-compatible _tag discriminants. */
import { LocalReviewTarget, localReviewTargetKey } from "@diffdash/domain/local-review"
import {
  GitProviderDescriptor,
  HostedReviewLocator,
  makeHostedReviewKey,
} from "@diffdash/domain/git-provider"
import {
  makeRepositoryComparisonReviewKey,
  RepositoryComparisonTarget,
} from "@diffdash/domain/repository-comparison"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
  type ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import {
  type StoredWalkthrough,
  walkthroughLocalDiffScope,
  walkthroughHostedReviewScope,
  walkthroughRepositoryComparisonScope,
} from "@diffdash/domain/walkthrough"
import { Match, Schema } from "effect"
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

/** Hosted renderer review with one authoritative source manifest. */
export class HostedRendererReview extends Schema.TaggedClass<HostedRendererReview>()("hosted", {
  manifest: HostedReviewSnapshotManifest,
  provider: Schema.NullOr(GitProviderDescriptor),
}) {
  get target(): HostedReviewLocator {
    return this.manifest.detail.summary.locator
  }

  get baseRevision(): ReviewRevision {
    return this.manifest.baseRevision
  }

  get headRevision(): ReviewRevision {
    return this.manifest.headRevision
  }

  get identity(): string {
    return `hosted:${makeHostedReviewKey(this.target)}`
  }

  get repositoryLabel(): string {
    return `${this.target.repository.namespace}/${this.target.repository.name}`
  }

  get title(): string {
    return this.manifest.detail.summary.title
  }
}

/** Local renderer review with one authoritative source manifest. */
export class LocalRendererReview extends Schema.TaggedClass<LocalRendererReview>()("local", {
  manifest: LocalReviewSnapshotManifest,
}) {
  get target(): LocalReviewTarget {
    return LocalReviewTarget.make({
      kind: "local",
      rootPath: this.manifest.detail.rootPath,
      comparison: this.manifest.detail.comparison,
    })
  }

  get baseRevision(): ReviewRevision {
    return this.manifest.baseRevision
  }

  get headRevision(): ReviewRevision {
    return this.manifest.headRevision
  }

  get identity(): string {
    return `local:${localReviewTargetKey(this.target)}`
  }

  get repositoryLabel(): string {
    return this.manifest.detail.rootPath
  }

  get title(): string {
    return this.manifest.detail.title
  }
}

/** Repository-comparison renderer review with one authoritative source manifest. */
export class RepositoryComparisonRendererReview extends Schema.TaggedClass<RepositoryComparisonRendererReview>()(
  "repositoryComparison",
  { manifest: RepositoryComparisonSnapshotManifest },
) {
  get target(): RepositoryComparisonTarget {
    return this.manifest.detail.target
  }

  get baseRevision(): ReviewRevision {
    return this.manifest.baseRevision
  }

  get headRevision(): ReviewRevision {
    return this.manifest.headRevision
  }

  get identity(): string {
    return `repository-comparison:${makeRepositoryComparisonReviewKey(this.target)}`
  }

  get repositoryLabel(): string {
    return `${this.target.repository.namespace}/${this.target.repository.name}`
  }

  get title(): string {
    return this.manifest.detail.title
  }
}

/** Schema-backed source-neutral review fields consumed by renderer presentation. */
export const RendererReview = Schema.Union([
  HostedRendererReview,
  LocalRendererReview,
  RepositoryComparisonRendererReview,
])

/** Schema-backed source-neutral review fields consumed by renderer presentation. */
export type RendererReview = typeof RendererReview.Type

/** Hosted review navigation target. */
export type HostedReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "hosted" }>

/** Local review navigation target. */
export type LocalDiffReviewTarget = Extract<SelectedReviewTarget, { readonly kind: "localDiff" }>

/** Immutable repository comparison navigation target. */
export type RepositoryComparisonReviewTarget = Extract<
  SelectedReviewTarget,
  { readonly kind: "repositoryComparison" }
>

/** Projects one hosted manifest into its matching renderer review variant. */
export function projectRendererReview(
  manifest: HostedReviewSnapshotManifest,
  providers: readonly GitProviderDescriptor[],
): HostedRendererReview

/** Projects one local manifest into its matching renderer review variant. */
export function projectRendererReview(
  manifest: LocalReviewSnapshotManifest,
  providers: readonly GitProviderDescriptor[],
): LocalRendererReview

/** Projects one repository-comparison manifest into its matching renderer review variant. */
export function projectRendererReview(
  manifest: RepositoryComparisonSnapshotManifest,
  providers: readonly GitProviderDescriptor[],
): RepositoryComparisonRendererReview

export function projectRendererReview(
  manifest: ReviewSnapshotManifest,
  providers: readonly GitProviderDescriptor[],
): RendererReview {
  return Match.valueTags(manifest, {
    hosted: (hostedManifest) => {
      const providerId = hostedManifest.detail.summary.locator.repository.providerId
      return HostedRendererReview.make({
        manifest: hostedManifest,
        provider: providers.find((candidate) => candidate.id === providerId) ?? null,
      })
    },
    local: (localManifest) => LocalRendererReview.make({ manifest: localManifest }),
    repositoryComparison: (comparisonManifest) =>
      RepositoryComparisonRendererReview.make({ manifest: comparisonManifest }),
  })
}

/** Adapts a normalized renderer review into the thread API scope. */
export const reviewThreadScope = (review: RendererReview): ReviewThreadScope => {
  return Match.valueTags(review, {
    hosted: (hostedReview) => ({
      kind: "hosted" as const,
      review: hostedReview.target,
      baseRevision: hostedReview.baseRevision,
      headRevision: hostedReview.headRevision,
    }),
    local: (localReview) => ({
      kind: "local" as const,
      target: localReview.target,
      baseRevision: localReview.baseRevision,
      headRevision: localReview.headRevision,
    }),
    repositoryComparison: (comparisonReview) => ({
      kind: "repositoryComparison" as const,
      target: comparisonReview.target,
      baseRevision: comparisonReview.baseRevision,
      headRevision: comparisonReview.headRevision,
    }),
  })
}

/** Adapts a normalized renderer review into its persisted walkthrough scope. */
export const reviewWalkthroughScope = (
  review: RendererReview,
  storedWalkthrough: StoredWalkthrough | null = null,
) => {
  return Match.valueTags(review, {
    hosted: (hostedReview) => walkthroughHostedReviewScope(hostedReview.target),
    local: (localReview) =>
      walkthroughLocalDiffScope(storedWalkthrough?.headSha ?? localReview.headRevision),
    repositoryComparison: (comparisonReview) =>
      walkthroughRepositoryComparisonScope(
        makeRepositoryComparisonReviewKey(comparisonReview.target),
      ),
  })
}
