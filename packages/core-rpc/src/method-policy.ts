import { Context, Schema } from "effect"
import type * as Rpc from "effect/unstable/rpc/Rpc"

/** Finite RPC deadline measured in milliseconds. */
export const CoreRpcDeadlineMilliseconds = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("CoreRpcDeadlineMilliseconds"),
)

/** Finite RPC deadline measured in milliseconds. */
export type CoreRpcDeadlineMilliseconds = typeof CoreRpcDeadlineMilliseconds.Type

/** Logical encoded payload budget measured in bytes. */
export const CoreRpcPayloadBytes = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("CoreRpcPayloadBytes"),
)

/** Logical encoded payload budget measured in bytes. */
export type CoreRpcPayloadBytes = typeof CoreRpcPayloadBytes.Type

/** Cancellation behavior applied after a caller or connection interrupts a request. */
export const CoreRpcCancellation = Schema.Literals([
  "interruptible",
  "detachedAfterAcceptance",
  "uninterruptible",
])

/** Cancellation behavior applied after a caller or connection interrupts a request. */
export type CoreRpcCancellation = typeof CoreRpcCancellation.Type

/** Authorization scope required before an RPC may execute. */
export const CoreRpcRequiredScope = Schema.Literals([
  "application",
  "project",
  "review",
  "operation",
])

/** Authorization scope required before an RPC may execute. */
export type CoreRpcRequiredScope = typeof CoreRpcRequiredScope.Type

/** Mutation certainty used by admission, ownership, and retry policy. */
export const CoreRpcMutationClass = Schema.Literals([
  "read",
  "idempotentMutation",
  "uncertainMutation",
])

/** Mutation certainty used by admission, ownership, and retry policy. */
export type CoreRpcMutationClass = typeof CoreRpcMutationClass.Type

/** Duplicate-request behavior declared by an RPC. */
export const CoreRpcIdempotency = Schema.Literals([
  "idempotent",
  "idempotencyKeyRequired",
  "nonIdempotent",
])

/** Duplicate-request behavior declared by an RPC. */
export type CoreRpcIdempotency = typeof CoreRpcIdempotency.Type

/** Behavior required when the Core process epoch changes during an operation. */
export const CoreRpcRestartBehavior = Schema.Literals([
  "retryInNewEpoch",
  "retryByIdempotencyKey",
  "failOnRestart",
  "resumeByOperationId",
])

/** Behavior required when the Core process epoch changes during an operation. */
export type CoreRpcRestartBehavior = typeof CoreRpcRestartBehavior.Type

/** Bounded symbolic name of an Electron capability that a Core RPC may call. */
export const CoreHostCapabilityName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9.]*$/u)),
  Schema.brand("CoreHostCapabilityName"),
)

/** Bounded symbolic name of an Electron capability that a Core RPC may call. */
export type CoreHostCapabilityName = typeof CoreHostCapabilityName.Type

/** Exhaustive application policy attached to every Core RPC declaration. */
export const CoreRpcMethodPolicy = Schema.Struct({
  deadlineMs: CoreRpcDeadlineMilliseconds,
  maxRequestBytes: CoreRpcPayloadBytes,
  maxResponseBytes: CoreRpcPayloadBytes,
  cancellation: CoreRpcCancellation,
  requiredScope: CoreRpcRequiredScope,
  mutationClass: CoreRpcMutationClass,
  idempotency: CoreRpcIdempotency,
  restartBehavior: CoreRpcRestartBehavior,
  requiredHostCapabilities: Schema.Array(CoreHostCapabilityName).pipe(
    Schema.check(Schema.isMaxLength(16)),
  ),
}).annotate({ identifier: "CoreRpcMethodPolicy" })

/** Exhaustive application policy attached to every Core RPC declaration. */
export type CoreRpcMethodPolicy = typeof CoreRpcMethodPolicy.Type

/** Effect annotation key carrying one declaration's complete Core method policy. */
export const CoreRpcMethodPolicyAnnotation = Context.Service<never, CoreRpcMethodPolicy>(
  "@diffdash/core-rpc/CoreRpcMethodPolicy",
)

/** Reads a Core method policy without assuming a declaration was annotated correctly. */
export const getCoreRpcMethodPolicy = (rpc: Rpc.Any): CoreRpcMethodPolicy | undefined =>
  Context.getOrUndefined(rpc.annotations, CoreRpcMethodPolicyAnnotation)
