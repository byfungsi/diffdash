import { Atom } from "@effect-atom/atom-react"
import { Effect } from "effect"

import type { PullRequestSummary } from "@diffdash/domain/pull-request"
import { HostedProviderRequest } from "@diffdash/protocol/hosted-git"
import { providersAtom, repositoriesAtom, isBookmarkedPullRequestRepo } from "@/repositories/atoms"
import { pullRequestsAtom, repoKey } from "@/review/atoms"
import { fetchEffect } from "@/shared/effect-api"

/** Hosted review requests assigned to the current user. */
export const reviewRequestsAtom = Atom.make(
  Effect.fnUntraced(function* (get: Atom.Context) {
    const providers = yield* get.result(providersAtom)
    const reviews = yield* Effect.all(
      providers
        .filter((provider) => provider.capabilities.assignedReviews)
        .map((provider) =>
          fetchEffect(() =>
            window.diffDash.hostedReviews.listAssigned(
              HostedProviderRequest.make({ providerId: provider.id }),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    )
    return reviews.flat()
  }),
  { initialValue: [] as readonly PullRequestSummary[] },
).pipe(Atom.keepAlive)

/** Open review counts for bookmarked repositories. */
export const repoPrCountsAtom = Atom.make(
  Effect.fnUntraced(function* (get: Atom.Context) {
    const repos = yield* get.result(repositoriesAtom)
    const entries = yield* Effect.all(
      repos.filter(isBookmarkedPullRequestRepo).map((repo) =>
        get.result(pullRequestsAtom(repoKey(repo.provider, repo.owner, repo.name))).pipe(
          Effect.map((pullRequests) => [repo.id, pullRequests.length] as const),
          Effect.catchAll(() => Effect.succeed(null)),
        ),
      ),
    )
    return Object.fromEntries(entries.filter(isNonNull)) as Record<string, number>
  }),
  { initialValue: {} as Record<string, number> },
).pipe(Atom.keepAlive)

const isNonNull = <A>(value: A | null): value is A => value !== null
