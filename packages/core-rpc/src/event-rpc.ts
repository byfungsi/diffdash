import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import {
  CoreCommandAcknowledgeAdmissionMiddleware,
  CoreCommandGetAdmissionMiddleware,
  CoreCommandListAdmissionMiddleware,
  CoreEventReplayAdmissionMiddleware,
} from "./admission"
import {
  CoreCommandAcknowledgement,
  CoreCommandListRequest,
  CoreCommandListResult,
  CoreCommandQueryRequest,
  CoreCommandQueryResult,
  CoreCommandSnapshot,
  CoreEventReplayRequest,
  CoreEventReplayResult,
  CoreStateDeliveryFailure,
} from "./event"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"

/** Sanitized defect codec shared by the state-delivery RPC audience. */
export const CoreStateDeliveryDefectSchema = CoreStateDeliveryFailure.pipe(
  Schema.decodeTo(Schema.NullishOr(Schema.ObjectKeyword)),
)

const readPolicy = (maxResponseBytes: number): CoreRpcMethodPolicy =>
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(2_000),
    maxRequestBytes: CoreRpcPayloadBytes.make(2 * 1_024),
    maxResponseBytes: CoreRpcPayloadBytes.make(maxResponseBytes),
    cancellation: "interruptible",
    requiredScope: "application",
    mutationClass: "read",
    idempotency: "idempotent",
    restartBehavior: "retryInNewEpoch",
    requiredHostCapabilities: [],
  })

/** Reconnect-safe bounded replay of hint-only Core events. */
export const CoreEventReplayRpc = Rpc.make("CoreEvents.replay", {
  payload: CoreEventReplayRequest,
  success: CoreEventReplayResult,
  error: CoreStateDeliveryFailure,
  defect: CoreStateDeliveryDefectSchema,
})
  .middleware(CoreEventReplayAdmissionMiddleware)
  .annotate(CoreRpcMethodPolicyAnnotation, readPolicy(256 * 1_024))

/** Authoritative lookup for one durable Core command. */
export const CoreCommandGetRpc = Rpc.make("CoreCommands.get", {
  payload: CoreCommandQueryRequest,
  success: CoreCommandQueryResult,
  error: CoreStateDeliveryFailure,
  defect: CoreStateDeliveryDefectSchema,
})
  .middleware(CoreCommandGetAdmissionMiddleware)
  .annotate(CoreRpcMethodPolicyAnnotation, readPolicy(8 * 1_024))

/** Bounded authoritative query for terminal commands awaiting acknowledgement. */
export const CoreCommandListRpc = Rpc.make("CoreCommands.listUnacknowledged", {
  payload: CoreCommandListRequest,
  success: CoreCommandListResult,
  error: CoreStateDeliveryFailure,
  defect: CoreStateDeliveryDefectSchema,
})
  .middleware(CoreCommandListAdmissionMiddleware)
  .annotate(CoreRpcMethodPolicyAnnotation, readPolicy(256 * 1_024))

/** Idempotent guarded acknowledgement of the current terminal command version. */
export const CoreCommandAcknowledgeRpc = Rpc.make("CoreCommands.acknowledge", {
  payload: CoreCommandAcknowledgement,
  success: CoreCommandSnapshot,
  error: CoreStateDeliveryFailure,
  defect: CoreStateDeliveryDefectSchema,
})
  .middleware(CoreCommandAcknowledgeAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(5_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(2 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(8 * 1_024),
      cancellation: "uninterruptible",
      requiredScope: "application",
      mutationClass: "idempotentMutation",
      idempotency: "idempotent",
      restartBehavior: "retryInNewEpoch",
      requiredHostCapabilities: [],
    }),
  )

/** Native event replay and durable command query/acknowledgement declarations. */
export const CoreStateDeliveryRpcs = RpcGroup.make(
  CoreEventReplayRpc,
  CoreCommandGetRpc,
  CoreCommandListRpc,
  CoreCommandAcknowledgeRpc,
)
