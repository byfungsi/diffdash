import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import type { LocalReviewSnapshotManifest } from "@diffdash/domain/review-context"
import type { Repo } from "@diffdash/domain/repository"
import { Result } from "@effect-atom/atom-react"

import type { RibbonLifecycle } from "./ribbon-lifecycle"

/** Independently loaded local review source shown by the Reviews ribbon. */
export type LocalReviewsLifecycle = RibbonLifecycle<LocalReviewSnapshotManifest, unknown, string>

/** Independently loaded hosted review source shown by the Reviews ribbon. */
export type HostedReviewsLifecycle = RibbonLifecycle<
  readonly HostedReviewSummary[],
  unknown,
  string
>

/** Independently projected sources retained by the composite Reviews ribbon. */
export interface ReviewsLifecycleData {
  readonly hosted: HostedReviewsLifecycle
  readonly local: LocalReviewsLifecycle
}

/** Composite Reviews ribbon lifecycle across local and hosted review sources. */
export type ReviewsLifecycle = RibbonLifecycle<ReviewsLifecycleData, unknown, string>

/** Projects the local working-tree atom without depending on hosted review availability. */
export const projectLocalReviewsLifecycle = (
  repo: Repo,
  result: Result.Result<LocalReviewSnapshotManifest | null, unknown>,
): LocalReviewsLifecycle => {
  if (repo.localPath === null) return { _tag: "unavailable", reason: "No local checkout linked." }
  if (Result.isSuccess(result)) {
    if (result.value === null) return { _tag: "loading" }
    return result.value.files.length === 0
      ? { _tag: "empty", refreshing: Result.isWaiting(result) }
      : { _tag: "ready", data: result.value, refreshing: Result.isWaiting(result) }
  }
  if (Result.isFailure(result)) return { _tag: "failure", error: result.cause }
  return { _tag: "loading" }
}

/** Combines local and hosted source lifecycles without hiding partial availability. */
export const projectReviewsLifecycle = (
  local: LocalReviewsLifecycle,
  hosted: HostedReviewsLifecycle,
): ReviewsLifecycle => {
  const data = { local, hosted }
  const sources = [local, hosted] as const
  const refreshing = sources.some(sourceRefreshing)
  const invalid = sources.find((source) => source._tag === "invalid")
  if (invalid !== undefined) return { _tag: "invalid", reason: invalid.reason }

  const staleReasons = sources.flatMap((source) => (source._tag === "stale" ? [source.reason] : []))
  if (staleReasons.length > 0) {
    return {
      _tag: "stale",
      data,
      reason: staleReasons.join(" "),
      refreshing,
    }
  }

  const usable = sources.filter(
    (source) => source._tag === "ready" || source._tag === "empty" || source._tag === "degraded",
  )
  const issues = sources.flatMap(sourceIssue)
  if (usable.length > 0 && issues.length > 0) {
    const [firstIssue, ...remainingIssues] = issues
    if (firstIssue !== undefined) {
      return {
        _tag: "degraded",
        data,
        issues: [firstIssue, ...remainingIssues],
        refreshing,
      }
    }
  }

  if (sources.every((source) => source._tag === "loading")) return { _tag: "loading" }
  if (sources.every((source) => source._tag === "empty")) {
    return { _tag: "empty", refreshing }
  }
  if (issues.length === 0) return { _tag: "ready", data, refreshing }

  const failure = sources.find((source) => source._tag === "failure")
  if (failure !== undefined) return { _tag: "failure", error: failure.error }
  return { _tag: "unavailable", reason: issues.join(" ") }
}

const sourceRefreshing = (source: LocalReviewsLifecycle | HostedReviewsLifecycle): boolean =>
  source._tag === "ready" ||
  source._tag === "empty" ||
  source._tag === "stale" ||
  source._tag === "degraded"
    ? source.refreshing
    : false

const sourceIssue = (source: LocalReviewsLifecycle | HostedReviewsLifecycle): readonly string[] => {
  if (source._tag === "loading") return ["One review source is still loading."]
  if (source._tag === "unavailable") return [source.reason]
  if (source._tag === "failure") return ["One review source could not be loaded."]
  if (source._tag === "degraded") return source.issues
  return []
}

/** Projects hosted pull requests without depending on working-tree availability. */
export const projectHostedReviewsLifecycle = (
  repo: Repo,
  result: Result.Result<readonly HostedReviewSummary[], unknown>,
): HostedReviewsLifecycle => {
  if (repo.provider === "local") {
    return { _tag: "unavailable", reason: "This is a local-only project." }
  }
  if (Result.isSuccess(result)) {
    return result.value.length === 0
      ? { _tag: "empty", refreshing: Result.isWaiting(result) }
      : { _tag: "ready", data: result.value, refreshing: Result.isWaiting(result) }
  }
  if (Result.isFailure(result)) return { _tag: "failure", error: result.cause }
  return { _tag: "loading" }
}
