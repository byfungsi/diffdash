import { AppState } from "@diffdash/domain/app-state"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import { AppStateGetAdmissionMiddleware } from "./admission"
import { AppStateGetDefectSchema, AppStateReadFailure } from "./failure"
import { HostRequestContext } from "./identity"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"
import { WalkthroughBusinessRpcs } from "./walkthrough-rpc"
import { ReviewAgentBusinessRpcs } from "./review-agent-rpc"

/** Business RPC that reads application state without exposing its storage implementation. */
export const AppStateGetRpc = Rpc.make("AppState.get", {
  payload: HostRequestContext,
  success: AppState,
  error: AppStateReadFailure,
  defect: AppStateGetDefectSchema,
})
  .middleware(AppStateGetAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(2_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(4_096),
      cancellation: "interruptible",
      requiredScope: "application",
      mutationClass: "read",
      idempotency: "idempotent",
      restartBehavior: "retryInNewEpoch",
      requiredHostCapabilities: [],
    }),
  )

/** App-state business declarations with concrete Core handlers in the current composition. */
export const AppStateBusinessRpcs = RpcGroup.make(AppStateGetRpc)

/** Authoritative Electron-to-Core business RPC audience catalog. */
export const CoreBusinessRpcs =
  AppStateBusinessRpcs.merge(WalkthroughBusinessRpcs).merge(ReviewAgentBusinessRpcs)
