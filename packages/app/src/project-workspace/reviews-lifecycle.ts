import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import type { LocalReviewSnapshotManifest } from "@diffdash/domain/review-context"
import type { Repo } from "@diffdash/domain/repository"
import { Cause, Match, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { rendererTransportError, type RendererFailure } from "@/shared/errors"

import type { RibbonLifecycle } from "./ribbon-lifecycle"

/** Independently loaded local review source shown by the Reviews ribbon. */
export type LocalReviewsLifecycle = RibbonLifecycle<
  LocalReviewSnapshotManifest,
  RendererFailure,
  string
>

/** Independently loaded hosted review source shown by the Reviews ribbon. */
export type HostedReviewsLifecycle = RibbonLifecycle<
  readonly HostedReviewSummary[],
  RendererFailure,
  string
>

/** Independently projected sources retained by the composite Reviews ribbon. */
export interface ReviewsLifecycleData {
  readonly hosted: HostedReviewsLifecycle
  readonly local: LocalReviewsLifecycle
}

/** Composite Reviews ribbon lifecycle across local and hosted review sources. */
export type ReviewsLifecycle = RibbonLifecycle<ReviewsLifecycleData, RendererFailure, string>

/** Projects the local working-tree atom without depending on hosted review availability. */
export const projectLocalReviewsLifecycle = (
  repo: Repo,
  result: AsyncResult.AsyncResult<LocalReviewSnapshotManifest | null, RendererFailure>,
): LocalReviewsLifecycle => {
  if (repo.localPath === null) return { _tag: "unavailable", reason: "No local checkout linked." }
  if (AsyncResult.isSuccess(result)) {
    if (result.value === null) return { _tag: "loading" }
    const refresh = AsyncResult.isWaiting(result) ? "refreshing" : "idle"
    return result.value.files.length === 0
      ? { _tag: "empty", refresh }
      : { _tag: "ready", data: result.value, refresh }
  }
  if (AsyncResult.isFailure(result)) {
    const failure = Cause.findErrorOption(result.cause)
    return {
      _tag: "failure",
      error: Option.isSome(failure)
        ? failure.value
        : rendererTransportError(result.cause, "renderer:local-reviews"),
    }
  }
  return { _tag: "loading" }
}

/** Combines local and hosted source lifecycles without hiding partial availability. */
export const projectReviewsLifecycle = (
  local: LocalReviewsLifecycle,
  hosted: HostedReviewsLifecycle,
): ReviewsLifecycle => {
  const data = { local, hosted }
  const sources = [local, hosted] as const
  const refresh = sources.some(sourceRefreshing) ? "refreshing" : "idle"
  const invalidReason = sources
    .map((source) =>
      Match.valueTags(source, {
        invalid: ({ reason }) => reason,
        loading: () => null,
        ready: () => null,
        empty: () => null,
        unavailable: () => null,
        failure: () => null,
        stale: () => null,
        degraded: () => null,
      }),
    )
    .find((reason) => reason !== null)
  if (invalidReason !== undefined && invalidReason !== null) {
    return { _tag: "invalid", reason: invalidReason }
  }

  const staleReasons = sources.flatMap((source) =>
    Match.valueTags(source, {
      stale: ({ reason }) => [reason],
      loading: () => [],
      ready: () => [],
      empty: () => [],
      unavailable: () => [],
      failure: () => [],
      invalid: () => [],
      degraded: () => [],
    }),
  )
  if (staleReasons.length > 0) {
    return {
      _tag: "stale",
      data,
      reason: staleReasons.join(" "),
      refresh,
    }
  }

  const usable = sources.filter((source) =>
    Match.valueTags(source, {
      ready: () => true,
      empty: () => true,
      degraded: () => true,
      loading: () => false,
      unavailable: () => false,
      failure: () => false,
      stale: () => false,
      invalid: () => false,
    }),
  )
  const issues = sources.flatMap(sourceIssue)
  if (usable.length > 0 && issues.length > 0) {
    const [firstIssue, ...remainingIssues] = issues
    if (firstIssue !== undefined) {
      return {
        _tag: "degraded",
        data,
        issues: [firstIssue, ...remainingIssues],
        refresh,
      }
    }
  }

  if (
    sources.every((source) =>
      Match.valueTags(source, {
        loading: () => true,
        ready: () => false,
        empty: () => false,
        unavailable: () => false,
        failure: () => false,
        stale: () => false,
        invalid: () => false,
        degraded: () => false,
      }),
    )
  ) {
    return { _tag: "loading" }
  }
  if (
    sources.every((source) =>
      Match.valueTags(source, {
        empty: () => true,
        loading: () => false,
        ready: () => false,
        unavailable: () => false,
        failure: () => false,
        stale: () => false,
        invalid: () => false,
        degraded: () => false,
      }),
    )
  ) {
    return { _tag: "empty", refresh }
  }
  if (issues.length === 0) return { _tag: "ready", data, refresh }

  const failureError = sources
    .map((source) =>
      Match.valueTags(source, {
        failure: ({ error }) => error,
        loading: () => null,
        ready: () => null,
        empty: () => null,
        unavailable: () => null,
        stale: () => null,
        invalid: () => null,
        degraded: () => null,
      }),
    )
    .find((error) => error !== null)
  if (failureError !== undefined && failureError !== null) {
    return { _tag: "failure", error: failureError }
  }
  return { _tag: "unavailable", reason: issues.join(" ") }
}

const sourceRefreshing = (source: LocalReviewsLifecycle | HostedReviewsLifecycle): boolean =>
  Match.valueTags(source, {
    ready: ({ refresh }) => refresh === "refreshing",
    empty: ({ refresh }) => refresh === "refreshing",
    stale: ({ refresh }) => refresh === "refreshing",
    degraded: ({ refresh }) => refresh === "refreshing",
    loading: () => false,
    unavailable: () => false,
    failure: () => false,
    invalid: () => false,
  })

const sourceIssue = (source: LocalReviewsLifecycle | HostedReviewsLifecycle): readonly string[] => {
  return Match.valueTags(source, {
    loading: () => ["One review source is still loading."],
    unavailable: ({ reason }) => [reason],
    failure: () => ["One review source could not be loaded."],
    degraded: ({ issues }) => issues,
    ready: () => [],
    empty: () => [],
    stale: () => [],
    invalid: () => [],
  })
}

/** Projects hosted pull requests without depending on working-tree availability. */
export const projectHostedReviewsLifecycle = (
  repo: Repo,
  result: AsyncResult.AsyncResult<readonly HostedReviewSummary[], RendererFailure>,
): HostedReviewsLifecycle => {
  if (
    Match.valueTags(repo.source, {
      local: () => true,
      hosted: () => false,
    })
  )
    return { _tag: "unavailable", reason: "This is a local-only project." }
  if (AsyncResult.isSuccess(result)) {
    const refresh = AsyncResult.isWaiting(result) ? "refreshing" : "idle"
    return result.value.length === 0
      ? { _tag: "empty", refresh }
      : { _tag: "ready", data: result.value, refresh }
  }
  if (AsyncResult.isFailure(result)) {
    const failure = Cause.findErrorOption(result.cause)
    return {
      _tag: "failure",
      error: Option.isSome(failure)
        ? failure.value
        : rendererTransportError(result.cause, "renderer:hosted-reviews"),
    }
  }
  return { _tag: "loading" }
}
