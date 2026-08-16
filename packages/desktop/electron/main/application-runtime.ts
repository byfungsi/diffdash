import {
  type CoreMethod,
  type CoreMethodInput,
  type CoreOperationOptions,
  type CoreOperationOutput,
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
