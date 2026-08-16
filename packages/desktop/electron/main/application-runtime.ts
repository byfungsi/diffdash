import {
  type CoreMethod,
  type CoreMethodInput,
  type CoreOperationOptions,
  type CoreOperationOutput,
  type CoreResult,
  type EmbeddedCore,
  type GetStoredWalkthrough,
  type StartWalkthroughOperation,
  type WalkthroughOperationAccepted,
  type WalkthroughOperationId,
  type WalkthroughOperationResult,
} from "@diffdash/core"
import type { ProgressiveReviewApi } from "@diffdash/protocol/review-session"

type StoredWalkthrough = Extract<
  WalkthroughOperationResult,
  { readonly _tag: "completed" }
>["walkthrough"]

/** Electron adapter that projects typed Core failures into the existing IPC error boundary. */
export interface ApplicationRuntime {
  readonly start: () => Promise<void>
  readonly execute: <Method extends CoreMethod>(
    method: Method,
    input: CoreMethodInput<Method>,
    options?: CoreOperationOptions,
  ) => Promise<CoreOperationOutput<Method>>
  readonly walkthroughs: {
    readonly start: (request: StartWalkthroughOperation) => Promise<WalkthroughOperationAccepted>
    readonly getOperation: (
      operationId: WalkthroughOperationId,
    ) => Promise<WalkthroughOperationResult>
    readonly cancel: (operationId: WalkthroughOperationId) => Promise<WalkthroughOperationResult>
    /** Nullable only at the existing Core-to-IPC transport boundary. */
    readonly getStored: (request: GetStoredWalkthrough) => Promise<StoredWalkthrough | null>
  }
  readonly progressiveReviews: ProgressiveReviewApi
  readonly dispose: () => Promise<void>
}

/** Adapts the build-selected embedded Core runtime to Electron's IPC boundary. */
export const createApplicationRuntime = (core: EmbeddedCore): ApplicationRuntime => {
  const execute: ApplicationRuntime["execute"] = async (method, input, options) =>
    unwrapCoreResult(await core.execute(method, input, options))
  return {
    start: async () => unwrapCoreResult(await core.start()),
    execute,
    walkthroughs: {
      start: async (request) => unwrapCoreResult(await core.walkthroughs.start(request)),
      getOperation: async (operationId) =>
        unwrapCoreResult(await core.walkthroughs.getOperation(operationId)),
      cancel: async (operationId) => unwrapCoreResult(await core.walkthroughs.cancel(operationId)),
      getStored: async (request) => unwrapCoreResult(await core.walkthroughs.getStored(request)),
    },
    progressiveReviews: unavailableProgressiveReviewApi,
    dispose: core.dispose,
  }
}

const unavailableProgressiveReviewApi: ProgressiveReviewApi = {
  openSession: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  currentSession: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  closeSession: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  inventory: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  readRange: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  waitForRange: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  resolveTarget: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
  search: async () => Promise.reject(new Error("Progressive review RPC is unavailable.")),
}

/** Projects an explicit Core result into Electron's exception-based IPC adapter boundary. */
export const unwrapCoreResult = <Value, Failure>(result: CoreResult<Value, Failure>): Value => {
  if (result.ok) return result.value
  throw result.error
}
