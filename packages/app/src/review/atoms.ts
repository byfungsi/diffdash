import { Atom } from "@effect-atom/atom-react"
import { Effect, Schema } from "effect"

import {
  HostedRepositoryLocator,
  HostedReviewLocator,
  HostedReviewSummary,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import {
  HostedReviewSnapshotManifest,
  LocalReviewSnapshotManifest,
  RepositoryComparisonSnapshotManifest,
} from "@diffdash/domain/review-context"
import { HostedRepositoryRequest, HostedReviewRequest } from "@diffdash/protocol/hosted-git"
import { fetchSchemaEffect } from "@/shared/effect-api"
import { makeSchemaAtomKeyCodec } from "@/shared/schema-atom-key"

const localReviewAtomKeyCodec = makeSchemaAtomKeyCodec(LocalReviewTarget)
const hostedRepositoryAtomKeyCodec = makeSchemaAtomKeyCodec(HostedRepositoryLocator)
const hostedReviewAtomKeyCodec = makeSchemaAtomKeyCodec(HostedReviewLocator)
const repositoryComparisonAtomKeyCodec = makeSchemaAtomKeyCodec(RepositoryComparisonTarget)

/** Open hosted reviews for one repository. */
export const pullRequestsAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parseRepoAtomKey(key)
      if (parsedKey === null) return [] as readonly HostedReviewSummary[]
      return yield* fetchSchemaEffect(Schema.Array(HostedReviewSummary), () =>
        window.diffDash.hostedReviews.list(
          HostedRepositoryRequest.make({
            repository: parsedKey,
          }),
        ),
      )
    }),
    { initialValue: [] as readonly HostedReviewSummary[] },
  ),
)

/** Hosted review manifest backed by one coherent main-process snapshot. */
export const hostedReviewManifestAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const parsedKey = parseHostedReviewAtomKey(key)
      if (parsedKey === null) return null
      return yield* fetchSchemaEffect(HostedReviewSnapshotManifest, () =>
        window.diffDash.reviewSnapshots.acquireHosted(
          HostedReviewRequest.make({ review: parsedKey }),
        ),
      )
    }),
    { initialValue: null },
  ),
)

/** Local review manifest backed by one coherent main-process snapshot. */
export const localReviewManifestAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const target = parseLocalReviewAtomKey(key)
      if (target === null) return null
      return yield* fetchSchemaEffect(LocalReviewSnapshotManifest, () =>
        window.diffDash.reviewSnapshots.acquireLocal(target),
      )
    }),
    { initialValue: null },
  ),
)

/** Immutable repository comparison manifest backed by one coherent main-process snapshot. */
export const repositoryComparisonManifestAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const target = parseRepositoryComparisonAtomKey(key)
      if (target === null) return null
      return yield* fetchSchemaEffect(RepositoryComparisonSnapshotManifest, () =>
        window.diffDash.reviewSnapshots.acquireRepositoryComparison(target),
      )
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
  hostedRepositoryAtomKeyCodec.encode(makeHostedRepositoryLocator(providerId, owner, name))

/** Stable hosted review atom key. */
export const pullRequestAtomKey = (
  providerId: string,
  owner: string,
  name: string,
  number: number,
) => hostedReviewAtomKeyCodec.encode(makeHostedReviewLocator(providerId, owner, name, number))

/** Stable local review atom key. */
export const serializeLocalReviewAtomKey = (target: LocalReviewTarget) =>
  localReviewAtomKeyCodec.encode(target)

/** Stable immutable repository comparison atom key. */
export const serializeRepositoryComparisonAtomKey = (target: RepositoryComparisonTarget) =>
  repositoryComparisonAtomKeyCodec.encode(target)

const parseLocalReviewAtomKey = (key: string) =>
  key.length === 0 ? null : localReviewAtomKeyCodec.decode(key)

const parseRepoAtomKey = (key: string) =>
  key.length === 0 ? null : hostedRepositoryAtomKeyCodec.decode(key)

const parseHostedReviewAtomKey = (key: string) =>
  key.length === 0 ? null : hostedReviewAtomKeyCodec.decode(key)

const parseRepositoryComparisonAtomKey = (key: string) =>
  key.length === 0 ? null : repositoryComparisonAtomKeyCodec.decode(key)
