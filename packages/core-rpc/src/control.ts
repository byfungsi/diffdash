import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import { HostRequestContext } from "./identity"
import { CoreHealth } from "./lifecycle"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"

/** Health RPC used to verify the exact launched Core epoch and lifecycle state. */
export const CoreHealthRpc = Rpc.make("Core.health", {
  payload: HostRequestContext,
  success: CoreHealth,
}).annotate(
  CoreRpcMethodPolicyAnnotation,
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(1_000),
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

/** Electron-to-Core control RPC declarations. */
export const CoreControlRpcs = RpcGroup.make(CoreHealthRpc)
