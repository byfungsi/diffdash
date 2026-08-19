import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import {
  CoreAuthorizeDatabaseOwnershipDefectSchema,
  CoreAuthorizeDatabaseOwnershipFailure,
  CoreHealthDefectSchema,
  CoreHealthIdentityMismatchFailure,
  CoreShutdownDefectSchema,
  CoreShutdownFailure,
} from "./failure"
import { HostRequestContext } from "./identity"
import {
  AuthorizeDatabaseOwnershipRequest,
  CoreHealth,
  CoreShutdownAcknowledged,
  DatabaseOwnershipAuthorized,
} from "./lifecycle"
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
  error: CoreHealthIdentityMismatchFailure,
  defect: CoreHealthDefectSchema,
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

/** Control RPC authorizing this exact Core epoch to begin acquiring product SQLite. */
export const CoreAuthorizeDatabaseOwnershipRpc = Rpc.make("Core.authorizeDatabaseOwnership", {
  payload: AuthorizeDatabaseOwnershipRequest,
  success: DatabaseOwnershipAuthorized,
  error: CoreAuthorizeDatabaseOwnershipFailure,
  defect: CoreAuthorizeDatabaseOwnershipDefectSchema,
}).annotate(
  CoreRpcMethodPolicyAnnotation,
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(1_000),
    maxRequestBytes: CoreRpcPayloadBytes.make(1_024),
    maxResponseBytes: CoreRpcPayloadBytes.make(4_096),
    cancellation: "uninterruptible",
    requiredScope: "application",
    mutationClass: "idempotentMutation",
    idempotency: "idempotencyKeyRequired",
    restartBehavior: "failOnRestart",
    requiredHostCapabilities: [],
  }),
)

/** Control RPC that atomically stops admission and begins graceful Core draining. */
export const CoreShutdownRpc = Rpc.make("Core.shutdown", {
  payload: HostRequestContext,
  success: CoreShutdownAcknowledged,
  error: CoreShutdownFailure,
  defect: CoreShutdownDefectSchema,
}).annotate(
  CoreRpcMethodPolicyAnnotation,
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(1_000),
    maxRequestBytes: CoreRpcPayloadBytes.make(1_024),
    maxResponseBytes: CoreRpcPayloadBytes.make(4_096),
    cancellation: "uninterruptible",
    requiredScope: "application",
    mutationClass: "idempotentMutation",
    idempotency: "idempotent",
    restartBehavior: "failOnRestart",
    requiredHostCapabilities: [],
  }),
)

/** Electron-to-Core control RPC declarations. */
export const CoreControlRpcs = RpcGroup.make(
  CoreHealthRpc,
  CoreAuthorizeDatabaseOwnershipRpc,
  CoreShutdownRpc,
)
