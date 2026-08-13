/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { useAtomRefresh, useAtomSet } from "@effect/atom-react"
import { Match } from "effect"
import { useReviewSourceOperationsFactory } from "@/platform/renderer-runtime"
import type { ReviewSourceOperationSet } from "@/platform/review-source-operations"
import {
  hostedReviewManifestAtom,
  localReviewManifestAtom,
  repositoryComparisonManifestAtom,
  refreshPullRequestsAtom,
  repoKey,
} from "./atoms"
import type { ReviewSelectionProjection } from "./review-selection"

/** Source operations plus cache-tier refresh behavior used by review UI. */
export type ReviewSourceOperations = ReviewSourceOperationSet & { readonly refresh: () => void }

/** Source-operation mapping while no ready review is available. */
export type ReviewSourceOperationProjection =
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "ready"; readonly operations: ReviewSourceOperations }

/** Builds source operations after registering hosted and local refresh hooks unconditionally. */
export const useReviewSourceOperations = (
  selection: ReviewSelectionProjection,
): ReviewSourceOperationProjection => {
  const readySelection = Match.valueTags(selection, {
    ready: (ready) => ready,
    loading: () => null,
    failure: () => null,
    none: () => null,
  })
  const hostedKey =
    readySelection === null
      ? ""
      : Match.valueTags(readySelection.review, {
          hosted: () => readySelection.sourceKey,
          local: () => "",
          repositoryComparison: () => "",
        })
  const localKey =
    readySelection === null
      ? ""
      : Match.valueTags(readySelection.review, {
          hosted: () => "",
          local: () => readySelection.sourceKey,
          repositoryComparison: () => "",
        })
  const refreshHostedManifest = useAtomRefresh(hostedReviewManifestAtom(hostedKey))
  const refreshLocalManifest = useAtomRefresh(localReviewManifestAtom(localKey))
  const comparisonKey =
    readySelection === null
      ? ""
      : Match.valueTags(readySelection.review, {
          hosted: () => "",
          local: () => "",
          repositoryComparison: () => readySelection.sourceKey,
        })
  const refreshRepositoryComparisonManifest = useAtomRefresh(
    repositoryComparisonManifestAtom(comparisonKey),
  )
  const refreshPullRequests = useAtomSet(refreshPullRequestsAtom)
  const sourceOperations = useReviewSourceOperationsFactory()

  if (readySelection === null) return { _tag: "unavailable" }

  return {
    _tag: "ready",
    operations: {
      ...sourceOperations.make(readySelection.review),
      refresh: () => {
        Match.valueTags(readySelection.review, {
          local: () => refreshLocalManifest(),
          repositoryComparison: () => refreshRepositoryComparisonManifest(),
          hosted: (hosted) => {
            refreshHostedManifest()
            refreshPullRequests(
              repoKey(
                hosted.target.repository.providerId,
                hosted.target.repository.namespace,
                hosted.target.repository.name,
              ),
            )
          },
        })
      },
    },
  }
}
