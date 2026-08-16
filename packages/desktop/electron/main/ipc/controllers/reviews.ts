import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { CoreReviewSessionFailure } from "@diffdash/core-rpc/review-session"
import { Schema } from "effect"
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
  handlers.defineCore(CoreMethod.listHostedReviews, runtime.execute)
  handlers.defineCore(CoreMethod.listAssignedHostedReviews, runtime.execute)
  handlers.defineCore(CoreMethod.getHostedReviewDecision, runtime.execute)
  handlers.defineCore(CoreMethod.submitHostedReviewDecision, runtime.execute)
  handlers.defineCore(CoreMethod.resolveLocalBranch, runtime.execute)
  handlers.defineCore(CoreMethod.resolveLastCommit, runtime.execute)
  handlers.defineCore(CoreMethod.resolveRepositoryComparison, runtime.execute)
  handlers.defineCore(CoreMethod.acquireHostedReviewSnapshot, runtime.execute)
  handlers.defineCore(CoreMethod.acquireLocalReviewSnapshot, runtime.execute)
  handlers.defineCore(CoreMethod.acquireRepositoryComparisonSnapshot, runtime.execute)
  handlers.defineCore(CoreMethod.listViewedFiles, runtime.execute)
  handlers.defineCore(CoreMethod.setViewedFile, runtime.execute)
  handlers.defineCore(CoreMethod.listLocalViewedFiles, runtime.execute)
  handlers.defineCore(CoreMethod.setLocalViewedFile, runtime.execute)
  handlers.defineCore(CoreMethod.listRepositoryComparisonViewedFiles, runtime.execute)
  handlers.defineCore(CoreMethod.setRepositoryComparisonViewedFile, runtime.execute)
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
      const publications: ReviewSessionSearchPublication[] = []
      await runtime.progressiveReviews.search(request, (publication) =>
        publications.push(publication),
      )
      return publications
    },
    progressiveError,
  )
}
