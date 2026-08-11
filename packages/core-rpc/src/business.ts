import { AppState } from "@diffdash/domain/app-state"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import { AppStateGetDefectSchema, AppStateReadFailure } from "./failure"
import { HostRequestContext } from "./identity"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"

/** Business RPC that reads application state without exposing its storage implementation. */
export const AppStateGetRpc = Rpc.make("AppState.get", {
  payload: HostRequestContext,
  success: AppState,
  error: AppStateReadFailure,
  defect: AppStateGetDefectSchema,
}).annotate(
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

/** Electron-to-Core business RPC declarations. */
export const CoreBusinessRpcs = RpcGroup.make(AppStateGetRpc)
