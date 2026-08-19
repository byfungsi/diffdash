import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { CoreReviewSessionFailure } from "@diffdash/core-rpc/review-session"
import { Match, Schema } from "effect"
import { transportError } from "@diffdash/protocol/transport-error"
import type { ReviewSessionSearchPublication } from "@diffdash/protocol/review-session"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

const progressiveError = <A>(error: A, operation: string) =>
  Schema.is(CoreReviewSessionFailure)(error)
    ? transportError(error.code, error.safeMessage, operation)
    : transportError("INTERNAL_ERROR", "An unexpected error occurred.", operation)

/** Defines review and immutable snapshot IPC handler implementations. */
export const defineReviewHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.listHostedReviews, runtime.core.listHostedReviews)
  handlers.defineCore(CoreMethod.listAssignedHostedReviews, runtime.core.listAssignedHostedReviews)
  handlers.defineCore(CoreMethod.getHostedReviewDecision, runtime.core.getHostedReviewDecision)
  handlers.defineCore(
    CoreMethod.submitHostedReviewDecision,
    runtime.core.submitHostedReviewDecision,
  )
  handlers.defineCore(CoreMethod.resolveLocalBranch, runtime.core.resolveLocalBranch)
  handlers.defineCore(CoreMethod.resolveLastCommit, runtime.core.resolveLastCommit)
  handlers.defineCore(
    CoreMethod.resolveRepositoryComparison,
    runtime.core.resolveRepositoryComparison,
  )
  handlers.defineCore(
    CoreMethod.acquireHostedReviewSnapshot,
    runtime.core.acquireHostedReviewSnapshot,
  )
  handlers.defineCore(
    CoreMethod.acquireLocalReviewSnapshot,
    runtime.core.acquireLocalReviewSnapshot,
  )
  handlers.defineCore(
    CoreMethod.acquireRepositoryComparisonSnapshot,
    runtime.core.acquireRepositoryComparisonSnapshot,
  )
  handlers.define(InvokeChannel.e2eReviewLifecycleDiagnostics, () =>
    runtime.core.e2eReviewLifecycleDiagnostics(),
  )
  handlers.define(InvokeChannel.e2eHoldNextReviewAcquisition, () =>
    runtime.core.e2eHoldNextReviewAcquisition(),
  )
  handlers.defineCore(CoreMethod.listViewedFiles, runtime.core.listViewedFiles)
  handlers.defineCore(CoreMethod.setViewedFile, runtime.core.setViewedFile)
  handlers.defineCore(CoreMethod.listLocalViewedFiles, runtime.core.listLocalViewedFiles)
  handlers.defineCore(CoreMethod.setLocalViewedFile, runtime.core.setLocalViewedFile)
  handlers.defineCore(
    CoreMethod.listRepositoryComparisonViewedFiles,
    runtime.core.listRepositoryComparisonViewedFiles,
  )
  handlers.defineCore(
    CoreMethod.setRepositoryComparisonViewedFile,
    runtime.core.setRepositoryComparisonViewedFile,
  )
  handlers.define(
    InvokeChannel.openProgressiveReviewSession,
    (_event, request) => runtime.progressiveReviews.openSession(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.getProgressiveReviewSession,
    (_event, request) => runtime.progressiveReviews.currentSession(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.closeProgressiveReviewSession,
    (_event, request) => runtime.progressiveReviews.closeSession(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.getProgressiveReviewInventory,
    (_event, request) => runtime.progressiveReviews.inventory(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.readProgressiveReviewRange,
    (_event, request) => runtime.progressiveReviews.readRange(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.waitForProgressiveReviewRange,
    (_event, request) => runtime.progressiveReviews.waitForRange(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.resolveProgressiveReviewTarget,
    (_event, request) => runtime.progressiveReviews.resolveTarget(request),
    progressiveError,
  )
  handlers.define(
    InvokeChannel.searchProgressiveReview,
    async (_event, request) => {
      let finalPublication: ReviewSessionSearchPublication | null = null
      await runtime.progressiveReviews.search(request, (publication) => {
        Match.valueTags(publication, {
          Provisional: () => undefined,
          Final: (current) => {
            finalPublication = current
          },
        })
      })
      return finalPublication === null ? [] : [finalPublication]
    },
    progressiveError,
  )
}
