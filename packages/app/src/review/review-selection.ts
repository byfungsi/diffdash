/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import type { GitProviderDescriptor } from "@diffdash/domain/git-provider"
import type {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  ReviewSnapshotFileInventory,
  ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import { formatError } from "@/shared/errors"
import { pullRequestAtomKey, serializeLocalReviewAtomKey } from "./atoms"
import {
  type ReviewSubject,
  type SelectedReviewTarget,
  reviewSubjectRepositoryLabel,
  reviewSubjectTitle,
} from "./review-subject"

/** Renderer load state supplied to the pure review-selection projection. */
export type ReviewManifestLoadState<Manifest extends ReviewSnapshotManifest> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failure"; readonly error: unknown }
  | { readonly _tag: "ready"; readonly manifest: Manifest; readonly refreshing: boolean }

/** Source-specific data retained by a ready review selection. */
type ReadyReviewSource =
  | {
      readonly _tag: "hosted"
      readonly provider: GitProviderDescriptor | null
    }
  | { readonly _tag: "local" }

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
      readonly target: SelectedReviewTarget
      readonly manifest: ReviewSnapshotManifest
      readonly refreshing: boolean
      readonly subject: ReviewSubject
      readonly source: ReadyReviewSource
      readonly status: string
      readonly inventory: readonly ReviewSnapshotFileInventory[]
      readonly repositoryLabel: string
      readonly title: string
    }

/** Stable source keys used by the hosted and local manifest atoms. */
type ReviewSelectionSourceKeys = {
  readonly hosted: string
  readonly local: string
}

/** Dependencies for projecting one selected review. */
type ReviewSelectionProjectionInput = {
  readonly target: SelectedReviewTarget | null
  readonly hosted: ReviewManifestLoadState<HostedReviewSnapshotManifest>
  readonly local: ReviewManifestLoadState<LocalReviewSnapshotManifest>
  readonly providers: readonly GitProviderDescriptor[]
}

/** Returns the single active manifest key while leaving the inactive source key empty. */
export const reviewSelectionSourceKeys = (
  target: SelectedReviewTarget | null,
): ReviewSelectionSourceKeys => {
  if (target === null) return { hosted: "", local: "" }
  return target.kind === "hosted"
    ? {
        hosted: pullRequestAtomKey(
          target.review.repository.providerId,
          target.review.repository.namespace,
          target.review.repository.name,
          target.review.number,
        ),
        local: "",
      }
    : {
        hosted: "",
        local: serializeLocalReviewAtomKey(target.target),
      }
}

/** Normalizes hosted and local selection state into one tagged projection. */
export const projectReviewSelection = ({
  target,
  hosted,
  local,
  providers,
}: ReviewSelectionProjectionInput): ReviewSelectionProjection => {
  if (target === null) return { _tag: "none" }

  const sourceKeys = reviewSelectionSourceKeys(target)
  if (target.kind === "hosted") {
    const sourceKey = sourceKeys.hosted
    const abbreviation =
      providers.find((provider) => provider.id === target.review.repository.providerId)?.terminology
        .reviewAbbreviation ?? "review"
    if (hosted._tag === "loading") {
      return {
        _tag: "loading",
        sourceKey,
        target,
        status: `Opening ${abbreviation} #${target.review.number}...`,
      }
    }
    if (hosted._tag === "failure") {
      return {
        _tag: "failure",
        sourceKey,
        target,
        status: formatError(hosted.error, "Could not open pull request"),
      }
    }

    const subject: ReviewSubject = { kind: "hosted", hostedReview: hosted.manifest.detail }
    const provider =
      providers.find(
        (candidate) => candidate.id === subject.hostedReview.summary.locator.repository.providerId,
      ) ?? null
    return {
      _tag: "ready",
      sourceKey,
      target,
      manifest: hosted.manifest,
      refreshing: hosted.refreshing,
      subject,
      source: { _tag: "hosted", provider },
      status: `Opened ${provider?.terminology.reviewAbbreviation ?? "review"} #${subject.hostedReview.summary.locator.number}: ${subject.hostedReview.summary.title}`,
      inventory: hosted.manifest.files,
      repositoryLabel: reviewSubjectRepositoryLabel(subject),
      title: reviewSubjectTitle(subject),
    }
  }

  const sourceKey = sourceKeys.local
  if (local._tag === "loading") {
    return { _tag: "loading", sourceKey, target, status: "Opening local changes..." }
  }
  if (local._tag === "failure") {
    return {
      _tag: "failure",
      sourceKey,
      target,
      status: formatError(local.error, "Could not open local changes"),
    }
  }

  const subject: ReviewSubject = { kind: "localDiff", localReview: local.manifest.detail }
  return {
    _tag: "ready",
    sourceKey,
    target,
    manifest: local.manifest,
    refreshing: local.refreshing,
    subject,
    source: { _tag: "local" },
    status:
      local.manifest.files.length === 0
        ? `No local changes in ${subject.localReview.repoName}`
        : `Opened local changes in ${subject.localReview.repoName}`,
    inventory: local.manifest.files,
    repositoryLabel: reviewSubjectRepositoryLabel(subject),
    title: reviewSubjectTitle(subject),
  }
}
