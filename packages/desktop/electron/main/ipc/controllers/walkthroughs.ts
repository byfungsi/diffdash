import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { HostedReviewTarget } from "@diffdash/domain/review-thread"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { ApplicationRuntime } from "../../application-runtime"
import { toPublicWalkthroughError } from "../walkthrough-public-error"
import { IpcControllerRegistry } from "./controller-registry"

const generateWalkthrough = async (
  runtime: ApplicationRuntime,
  target: ReviewThreadTarget,
  regenerate: boolean,
): Promise<StoredWalkthrough> => {
  const accepted = await runtime.walkthroughs.start({ target, regenerate })
  const result = await runtime.walkthroughs.getOperation(accepted.operationId)
  if ("walkthrough" in result) return result.walkthrough
  if ("error" in result) throw result.error
  if ("defect" in result) throw result.defect
  throw new Error("Walkthrough generation was cancelled.")
}

/** Defines walkthrough IPC handlers over the Core-owned operation boundary. */
export const defineWalkthroughHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(InvokeChannel.getWalkthrough, async (_event, request) =>
    runtime.walkthroughs.getStored({
      target: HostedReviewTarget.make({ kind: "hosted", review: request.review }),
      expectedBaseRevision: request.baseRevision,
      expectedHeadRevision: request.headRevision,
    }),
  )
  handlers.define(InvokeChannel.getLocalWalkthrough, async (_event, request) =>
    runtime.walkthroughs.getStored({
      target: request.target,
      expectedBaseRevision: request.baseSha,
      expectedHeadRevision: request.headSha,
    }),
  )
  handlers.define(
    InvokeChannel.generateWalkthrough,
    async (_event, request) =>
      generateWalkthrough(
        runtime,
        HostedReviewTarget.make({ kind: "hosted", review: request.review }),
        request.regenerate,
      ),
    toPublicWalkthroughError,
  )
  handlers.define(
    InvokeChannel.generateLocalWalkthrough,
    async (_event, request) => generateWalkthrough(runtime, request.target, request.regenerate),
    toPublicWalkthroughError,
  )
  handlers.define(InvokeChannel.getRepositoryComparisonWalkthrough, async (_event, request) =>
    runtime.walkthroughs.getStored({
      target: request.target,
      expectedBaseRevision: null,
      expectedHeadRevision: null,
    }),
  )
  handlers.define(
    InvokeChannel.generateRepositoryComparisonWalkthrough,
    async (_event, request) => generateWalkthrough(runtime, request.target, request.regenerate),
    toPublicWalkthroughError,
  )
}
