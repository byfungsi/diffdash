import type { GitProviderDescriptor } from "@diffdash/domain/git-provider"
import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { hostedReviewManifestAtom, localReviewManifestAtom } from "./atoms"
import {
  type ReviewManifestLoadState,
  type ReviewSelectionProjection,
  projectReviewSelection,
  reviewSelectionSourceKeys,
} from "./review-selection"
import type { SelectedReviewTarget } from "./review-subject"

const manifestLoadState = <Manifest extends ReviewSnapshotManifest>(
  result: Result.Result<Manifest | null, unknown>,
): ReviewManifestLoadState<Manifest> => {
  if (Result.isSuccess(result)) {
    return result.value === null
      ? { _tag: "loading" }
      : { _tag: "ready", manifest: result.value, refreshing: Result.isWaiting(result) }
  }
  if (Result.isFailure(result)) return { _tag: "failure", error: result.cause }
  return { _tag: "loading" }
}

/** Reads both source atoms unconditionally and returns one normalized review projection. */
export const useReviewSelection = (
  target: SelectedReviewTarget | null,
  providers: readonly GitProviderDescriptor[],
): ReviewSelectionProjection => {
  const sourceKeys = reviewSelectionSourceKeys(target)
  const hostedResult = useAtomValue(hostedReviewManifestAtom(sourceKeys.hosted))
  const localResult = useAtomValue(localReviewManifestAtom(sourceKeys.local))

  return projectReviewSelection({
    target,
    hosted: manifestLoadState(hostedResult),
    local: manifestLoadState(localResult),
    providers,
  })
}
