import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

import {
  HostedRepositoryLocator,
  HostedReviewLocator,
  HostedReviewSummary,
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
} from "@diffdash/domain/git-provider"
import { LocalReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryComparisonTarget } from "@diffdash/domain/repository-comparison"
import { HostedRepositoryRequest, HostedReviewRequest } from "@diffdash/protocol/hosted-git"
import { rendererRuntime } from "@/platform/renderer-runtime"
import { ReviewContent } from "@/platform/review-content"
import { makeSchemaAtomKeyCodec } from "@/shared/schema-atom-key"

const localReviewAtomKeyCodec = makeSchemaAtomKeyCodec(LocalReviewTarget)
const hostedRepositoryAtomKeyCodec = makeSchemaAtomKeyCodec(HostedRepositoryLocator)
const hostedReviewAtomKeyCodec = makeSchemaAtomKeyCodec(HostedReviewLocator)
const repositoryComparisonAtomKeyCodec = makeSchemaAtomKeyCodec(RepositoryComparisonTarget)
const EMPTY_HOSTED_REVIEWS: readonly HostedReviewSummary[] = []

/** Open hosted reviews for one repository. */
export const pullRequestsAtom = Atom.family((key: string) =>
  rendererRuntime.atom(
    Effect.gen(function* () {
      const parsedKey = key.length === 0 ? null : hostedRepositoryAtomKeyCodec.decode(key)
      if (parsedKey === null) return EMPTY_HOSTED_REVIEWS
      const reviews = yield* ReviewContent
      return yield* reviews.hostedReviews.list(
        HostedRepositoryRequest.make({
          repository: parsedKey,
        }),
      )
    }),
    { initialValue: EMPTY_HOSTED_REVIEWS },
  ),
)

/** Hosted review manifest backed by one coherent main-process snapshot. */
export const hostedReviewManifestAtom = Atom.family((key: string) =>
  rendererRuntime.atom(
    Effect.gen(function* () {
      const parsedKey = key.length === 0 ? null : hostedReviewAtomKeyCodec.decode(key)
      if (parsedKey === null) return null
      const reviews = yield* ReviewContent
      return yield* reviews.snapshots.acquireHosted(HostedReviewRequest.make({ review: parsedKey }))
    }),
    { initialValue: null },
  ),
)

/** Local review manifest backed by one coherent main-process snapshot. */
export const localReviewManifestAtom = Atom.family((key: string) =>
  rendererRuntime.atom(
    Effect.gen(function* () {
      const target = key.length === 0 ? null : localReviewAtomKeyCodec.decode(key)
      if (target === null) return null
      const reviews = yield* ReviewContent
      return yield* reviews.snapshots.acquireLocal(target)
    }),
    { initialValue: null },
  ),
)

/** Immutable repository comparison manifest backed by one coherent main-process snapshot. */
export const repositoryComparisonManifestAtom = Atom.family((key: string) =>
  rendererRuntime.atom(
    Effect.gen(function* () {
      const target = key.length === 0 ? null : repositoryComparisonAtomKeyCodec.decode(key)
      if (target === null) return null
      const reviews = yield* ReviewContent
      return yield* reviews.snapshots.acquireRepositoryComparison(target)
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
