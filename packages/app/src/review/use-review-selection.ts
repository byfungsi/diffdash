import type { GitProviderDescriptor } from "@diffdash/domain/git-provider"
import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import { useAtomValue } from "@effect/atom-react"
import { Cause, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import {
  hostedReviewManifestAtom,
  localReviewManifestAtom,
  repositoryComparisonManifestAtom,
} from "./atoms"
import {
  type ReviewManifestLoadState,
  type ReviewSelectionProjection,
  projectReviewSelection,
  reviewSelectionSourceKeys,
} from "./review-selection"
import { rendererTransportError, type RendererFailure } from "@/shared/errors"
import type { SelectedReviewTarget } from "./review-subject"

const manifestLoadState = <Manifest extends ReviewSnapshotManifest>(
  result: AsyncResult.AsyncResult<Manifest | null, RendererFailure>,
): ReviewManifestLoadState<Manifest> => {
  if (AsyncResult.isSuccess(result)) {
    return result.value === null
      ? { _tag: "loading" }
      : { _tag: "ready", manifest: result.value, refreshing: AsyncResult.isWaiting(result) }
  }
  if (AsyncResult.isFailure(result)) {
    const failure = Cause.findErrorOption(result.cause)
    return {
      _tag: "failure",
      error: Option.isSome(failure)
        ? failure.value
        : rendererTransportError(result.cause, "renderer:review-selection"),
    }
  }
  return { _tag: "loading" }
}

/** Reads both source atoms unconditionally and returns one normalized review projection. */
export const useReviewSelection = (
  target: SelectedReviewTarget | null,
  providers: readonly GitProviderDescriptor[],
  acquireHostedSnapshot = true,
): ReviewSelectionProjection => {
  const snapshotTarget = target?.kind === "hosted" && !acquireHostedSnapshot ? null : target
  const sourceKeys = reviewSelectionSourceKeys(snapshotTarget)
  const hostedResult = useAtomValue(hostedReviewManifestAtom(sourceKeys.hosted))
  const localResult = useAtomValue(localReviewManifestAtom(sourceKeys.local))
  const comparisonResult = useAtomValue(repositoryComparisonManifestAtom(sourceKeys.comparison))

  return projectReviewSelection({
    target: snapshotTarget,
    hosted: manifestLoadState(hostedResult),
    local: manifestLoadState(localResult),
    comparison: manifestLoadState(comparisonResult),
    providers,
  })
}
