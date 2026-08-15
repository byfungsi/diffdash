import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware"

import { AppStateGetAdmissionFailure, CoreTransportAuthenticationFailure } from "./failure"
import {
  WalkthroughCancelAdmissionFailure,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughGetStoredAdmissionFailure,
  WalkthroughStartAdmissionFailure,
} from "./walkthrough"
import {
  ReviewAgentCancelFailure,
  ReviewAgentGetOperationFailure,
  ReviewAgentStartFailure,
} from "./review-agent"
import { CoreStateDeliveryFailure } from "./event"

/** Server-side authentication boundary shared by all Electron-to-Core RPCs. */
export class CoreTransportAuthenticationMiddleware extends RpcMiddleware.Service<CoreTransportAuthenticationMiddleware>()(
  "@diffdash/core-rpc/CoreTransportAuthenticationMiddleware",
  { error: CoreTransportAuthenticationFailure },
) {}

/** Server-side admission boundary for `AppState.get`. */
export class AppStateGetAdmissionMiddleware extends RpcMiddleware.Service<AppStateGetAdmissionMiddleware>()(
  "@diffdash/core-rpc/AppStateGetAdmissionMiddleware",
  { error: AppStateGetAdmissionFailure },
) {}

/** Server-side admission boundary for `Walkthroughs.start`. */
export class WalkthroughStartAdmissionMiddleware extends RpcMiddleware.Service<WalkthroughStartAdmissionMiddleware>()(
  "@diffdash/core-rpc/WalkthroughStartAdmissionMiddleware",
  { error: WalkthroughStartAdmissionFailure },
) {}

/** Server-side admission boundary for `Walkthroughs.getOperation`. */
export class WalkthroughGetOperationAdmissionMiddleware extends RpcMiddleware.Service<WalkthroughGetOperationAdmissionMiddleware>()(
  "@diffdash/core-rpc/WalkthroughGetOperationAdmissionMiddleware",
  { error: WalkthroughGetOperationAdmissionFailure },
) {}

/** Server-side admission boundary for `Walkthroughs.cancel`. */
export class WalkthroughCancelAdmissionMiddleware extends RpcMiddleware.Service<WalkthroughCancelAdmissionMiddleware>()(
  "@diffdash/core-rpc/WalkthroughCancelAdmissionMiddleware",
  { error: WalkthroughCancelAdmissionFailure },
) {}

/** Server-side admission boundary for `Walkthroughs.getStored`. */
export class WalkthroughGetStoredAdmissionMiddleware extends RpcMiddleware.Service<WalkthroughGetStoredAdmissionMiddleware>()(
  "@diffdash/core-rpc/WalkthroughGetStoredAdmissionMiddleware",
  { error: WalkthroughGetStoredAdmissionFailure },
) {}

/** Server-side admission boundary for `ReviewAgents.start`. */
export class ReviewAgentStartAdmissionMiddleware extends RpcMiddleware.Service<ReviewAgentStartAdmissionMiddleware>()(
  "@diffdash/core-rpc/ReviewAgentStartAdmissionMiddleware",
  { error: ReviewAgentStartFailure },
) {}

/** Server-side admission boundary for `ReviewAgents.getOperation`. */
export class ReviewAgentGetOperationAdmissionMiddleware extends RpcMiddleware.Service<ReviewAgentGetOperationAdmissionMiddleware>()(
  "@diffdash/core-rpc/ReviewAgentGetOperationAdmissionMiddleware",
  { error: ReviewAgentGetOperationFailure },
) {}

/** Server-side admission boundary for `ReviewAgents.cancel`. */
export class ReviewAgentCancelAdmissionMiddleware extends RpcMiddleware.Service<ReviewAgentCancelAdmissionMiddleware>()(
  "@diffdash/core-rpc/ReviewAgentCancelAdmissionMiddleware",
  { error: ReviewAgentCancelFailure },
) {}

/** Server-side admission boundary for reconnect-safe Core event replay. */
export class CoreEventReplayAdmissionMiddleware extends RpcMiddleware.Service<CoreEventReplayAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreEventReplayAdmissionMiddleware",
  { error: CoreStateDeliveryFailure },
) {}

/** Server-side admission boundary for one authoritative durable command query. */
export class CoreCommandGetAdmissionMiddleware extends RpcMiddleware.Service<CoreCommandGetAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreCommandGetAdmissionMiddleware",
  { error: CoreStateDeliveryFailure },
) {}

/** Server-side admission boundary for the bounded unacknowledged command query. */
export class CoreCommandListAdmissionMiddleware extends RpcMiddleware.Service<CoreCommandListAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreCommandListAdmissionMiddleware",
  { error: CoreStateDeliveryFailure },
) {}

/** Server-side admission boundary for guarded durable command acknowledgement. */
export class CoreCommandAcknowledgeAdmissionMiddleware extends RpcMiddleware.Service<CoreCommandAcknowledgeAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreCommandAcknowledgeAdmissionMiddleware",
  { error: CoreStateDeliveryFailure },
) {}
