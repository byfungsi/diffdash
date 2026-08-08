import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import {
  createEmbeddedCore,
  type CoreConfiguration,
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
  readonly dispose: EmbeddedCore["dispose"]
}

/** Creates the one embedded Core runtime owned by the desktop application. */
export const createApplicationRuntime = (configuration: CoreConfiguration): ApplicationRuntime => {
  const core = createEmbeddedCore(configuration)
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
    dispose: core.dispose,
  }
}

/** Projects an explicit Core result into Electron's exception-based IPC adapter boundary. */
export const unwrapCoreResult = <Value, Failure>(result: CoreResult<Value, Failure>): Value => {
  if (result.ok) return result.value
  throw result.error
}
