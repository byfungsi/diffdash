import type {
  E2eReviewLifecycleDiagnostics,
  E2eReviewLifecycleHold,
} from "@diffdash/protocol/e2e-review-lifecycle"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { BridgeResult } from "@diffdash/protocol/ipc"

import type { createRendererTransport } from "./transport"

/** E2E-build-only preload surface for Core-owned review lifecycle evidence. */
export interface DiffDashE2eDiagnosticsBridgeApi {
  readonly reviewLifecycle: () => Promise<BridgeResult<E2eReviewLifecycleDiagnostics>>
  readonly holdNextReviewAcquisition: () => Promise<BridgeResult<E2eReviewLifecycleHold>>
}

/** Creates the narrow E2E diagnostics bridge over the schema-validated renderer transport. */
export const createDiffDashE2eDiagnosticsBridgeApi = (
  transport: Pick<ReturnType<typeof createRendererTransport>, "invoke">,
): DiffDashE2eDiagnosticsBridgeApi => ({
  reviewLifecycle: () => transport.invoke(InvokeChannel.e2eReviewLifecycleDiagnostics, {}),
  holdNextReviewAcquisition: () => transport.invoke(InvokeChannel.e2eHoldNextReviewAcquisition, {}),
})
