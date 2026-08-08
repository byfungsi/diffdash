import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines review and immutable snapshot IPC handler implementations. */
export const defineReviewHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(InvokeChannel.listHostedReviews, async (_event, request) =>
    runtime.execute(CoreMethod.listHostedReviews, request),
  )
  handlers.define(InvokeChannel.listAssignedHostedReviews, async (_event, request) =>
    runtime.execute(CoreMethod.listAssignedHostedReviews, request),
  )
  handlers.define(InvokeChannel.getHostedReviewDecision, async (_event, request) =>
    runtime.execute(CoreMethod.getHostedReviewDecision, request),
  )
  handlers.define(InvokeChannel.submitHostedReviewDecision, async (_event, request) =>
    runtime.execute(CoreMethod.submitHostedReviewDecision, request),
  )
  handlers.define(InvokeChannel.resolveLocalBranch, async (_event, request) =>
    runtime.execute(CoreMethod.resolveLocalBranch, request),
  )
  handlers.define(InvokeChannel.resolveRepositoryComparison, async (_event, request) =>
    runtime.execute(CoreMethod.resolveRepositoryComparison, request),
  )
  handlers.define(InvokeChannel.acquireHostedReviewSnapshot, async (_event, request) =>
    runtime.execute(CoreMethod.acquireHostedReviewSnapshot, request),
  )
  handlers.define(InvokeChannel.acquireLocalReviewSnapshot, async (_event, request) =>
    runtime.execute(CoreMethod.acquireLocalReviewSnapshot, request),
  )
  handlers.define(InvokeChannel.acquireRepositoryComparisonSnapshot, async (_event, request) =>
    runtime.execute(CoreMethod.acquireRepositoryComparisonSnapshot, request),
  )
  handlers.define(InvokeChannel.getReviewSnapshotPage, async (_event, request) =>
    runtime.execute(CoreMethod.getReviewSnapshotPage, request),
  )
  handlers.define(InvokeChannel.searchReviewSnapshot, async (_event, request) =>
    runtime.execute(CoreMethod.searchReviewSnapshot, request),
  )
  handlers.define(InvokeChannel.listViewedFiles, async (_event, request) =>
    runtime.execute(CoreMethod.listViewedFiles, request),
  )
  handlers.define(InvokeChannel.setViewedFile, async (_event, request) =>
    runtime.execute(CoreMethod.setViewedFile, request),
  )
  handlers.define(InvokeChannel.listLocalViewedFiles, async (_event, request) =>
    runtime.execute(CoreMethod.listLocalViewedFiles, request),
  )
  handlers.define(InvokeChannel.setLocalViewedFile, async (_event, request) =>
    runtime.execute(CoreMethod.setLocalViewedFile, request),
  )
  handlers.define(InvokeChannel.listRepositoryComparisonViewedFiles, async (_event, request) =>
    runtime.execute(CoreMethod.listRepositoryComparisonViewedFiles, request),
  )
  handlers.define(InvokeChannel.setRepositoryComparisonViewedFile, async (_event, request) =>
    runtime.execute(CoreMethod.setRepositoryComparisonViewedFile, request),
  )
}
