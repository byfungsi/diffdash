/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { useAtomRefresh, useAtomSet } from "@effect-atom/atom-react"
import { repoPrCountsAtom, reviewRequestsAtom } from "@/home/atoms"
import {
  hostedReviewManifestAtom,
  localReviewManifestAtom,
  refreshPullRequestsAtom,
  repoKey,
} from "./atoms"
import type { ReviewSelectionProjection } from "./review-selection"
import { type ReviewSourceOperations, mapReviewSourceOperations } from "./review-source-operations"

/** Source-operation mapping while no ready review is available. */
export type ReviewSourceOperationProjection =
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "ready"; readonly operations: ReviewSourceOperations }

/** Builds source operations after registering hosted and local refresh hooks unconditionally. */
export const useReviewSourceOperations = (
  selection: ReviewSelectionProjection,
): ReviewSourceOperationProjection => {
  const hostedKey =
    selection._tag === "ready" && selection.target.kind === "hosted" ? selection.sourceKey : ""
  const localKey =
    selection._tag === "ready" && selection.target.kind === "localDiff" ? selection.sourceKey : ""
  const refreshHostedManifest = useAtomRefresh(hostedReviewManifestAtom(hostedKey))
  const refreshLocalManifest = useAtomRefresh(localReviewManifestAtom(localKey))
  const refreshPullRequests = useAtomSet(refreshPullRequestsAtom)
  const refreshReviewRequests = useAtomRefresh(reviewRequestsAtom)
  const refreshRepoPrCounts = useAtomRefresh(repoPrCountsAtom)

  if (selection._tag !== "ready") return { _tag: "unavailable" }

  return {
    _tag: "ready",
    operations: mapReviewSourceOperations(selection, {
      api: window.diffDash,
      refreshHosted: () => {
        refreshHostedManifest()
        if (selection.target.kind === "hosted") {
          refreshPullRequests(
            repoKey(
              selection.target.review.repository.providerId,
              selection.target.review.repository.namespace,
              selection.target.review.repository.name,
            ),
          )
        }
        refreshReviewRequests()
        refreshRepoPrCounts()
      },
      refreshLocal: refreshLocalManifest,
    }),
  }
}
