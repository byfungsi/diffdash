import { CoreMethod } from "@diffdash/core"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

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
  handlers.defineCore(CoreMethod.getReviewSnapshotPage, runtime.execute)
  handlers.defineCore(CoreMethod.searchReviewSnapshot, runtime.execute)
  handlers.defineCore(CoreMethod.listViewedFiles, runtime.execute)
  handlers.defineCore(CoreMethod.setViewedFile, runtime.execute)
  handlers.defineCore(CoreMethod.listLocalViewedFiles, runtime.execute)
  handlers.defineCore(CoreMethod.setLocalViewedFile, runtime.execute)
  handlers.defineCore(CoreMethod.listRepositoryComparisonViewedFiles, runtime.execute)
  handlers.defineCore(CoreMethod.setRepositoryComparisonViewedFile, runtime.execute)
}
