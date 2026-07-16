import { Atom } from "@effect-atom/atom-react"
import { Effect, Schema } from "effect"

import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import type { PullRequestSummary } from "@diffdash/domain/pull-request"
import { HostedRepositoryRequest, HostedReviewRequest } from "@diffdash/protocol/hosted-git"
import { fetchEffect } from "@/shared/effect-api"

/** Open hosted reviews for one repository. */
export const pullRequestsAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parseRepoAtomKey(key)
      if (parsedKey === null) return [] as readonly PullRequestSummary[]
      return yield* fetchEffect(() =>
        window.diffDash.hostedReviews.list(
          HostedRepositoryRequest.make({
            repository: hostedRepository(parsedKey.providerId, parsedKey.owner, parsedKey.name),
          }),
        ),
      )
    }),
    { initialValue: [] as readonly PullRequestSummary[] },
  ),
)

/** Coherent hosted review metadata and parsed diff snapshot. */
export const hostedReviewSnapshotAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parsePullRequestAtomKey(key)
      if (parsedKey === null) return null
      const snapshot = yield* fetchEffect(() =>
        window.diffDash.hostedReviews.getSnapshot(
          HostedReviewRequest.make({
            review: hostedReview(
              parsedKey.providerId,
              parsedKey.owner,
              parsedKey.name,
              parsedKey.number,
            ),
          }),
        ),
      )
      return { ...snapshot, parsedDiff: parseUnifiedDiff(snapshot.diff.diff) }
    }),
    { initialValue: null },
  ),
)

/** Coherent local review metadata and parsed diff snapshot. */
export const localReviewSnapshotAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const target = parseLocalReviewAtomKey(key)
      if (target === null) return null
      const snapshot = yield* fetchEffect(() => window.diffDash.localReviews.getSnapshot(target))
      return { ...snapshot, parsedDiff: parseUnifiedDiff(snapshot.diff.diff) }
    }),
    { initialValue: null },
  ),
)

/** Refreshes the selected repository review list. */
export const refreshPullRequestsAtom = Atom.fnSync((key: string, get) => {
  get.refresh(pullRequestsAtom(key))
})

/** Stable repository atom key. */
export const repoKey = (providerId: string, owner: string, name: string) =>
  `${providerId.toLowerCase()}\u0000${owner.toLowerCase()}\u0000${name.toLowerCase()}`

/** Stable hosted review atom key. */
export const pullRequestAtomKey = (
  providerId: string,
  owner: string,
  name: string,
  number: number,
) => `${repoKey(providerId, owner, name)}#${number}`

/** Stable local review atom key. */
export const serializeLocalReviewAtomKey = (target: LocalReviewTarget) => JSON.stringify(target)

const parseLocalReviewAtomKey = (key: string) => {
  if (key.length === 0) return null
  try {
    return Schema.decodeUnknownSync(LocalReviewTarget)(JSON.parse(key))
  } catch {
    return null
  }
}

const parseRepoAtomKey = (key: string) => {
  const [providerId, owner, name] = key.split("\u0000")
  if (providerId === undefined || owner === undefined || name === undefined) return null
  return { providerId: GitProviderId.make(providerId), owner, name }
}

const parsePullRequestAtomKey = (key: string) => {
  const separatorIndex = key.lastIndexOf("#")
  if (separatorIndex < 1 || separatorIndex === key.length - 1) return null
  const repository = parseRepoAtomKey(key.slice(0, separatorIndex))
  const number = Number(key.slice(separatorIndex + 1))
  if (repository === null || !Number.isInteger(number)) return null
  return { ...repository, number }
}

const hostedRepository = (providerId: string, owner: string, name: string) =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make(providerId),
    namespace: RepositoryNamespace.make(owner),
    name: HostedRepositoryName.make(name),
  })

const hostedReview = (providerId: string, owner: string, name: string, number: number) =>
  HostedReviewLocator.make({
    repository: hostedRepository(providerId, owner, name),
    number: HostedReviewNumber.make(number),
  })
