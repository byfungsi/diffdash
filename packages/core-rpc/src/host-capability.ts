import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import { CoreRequestContext } from "./identity"
import {
  CoreHostCapabilityName,
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"

/** Native host capabilities that Core may request; no renderer API accepts these names. */
export const CoreHostCapability = {
  openExternal: CoreHostCapabilityName.make("shell.openExternal"),
  openPath: CoreHostCapabilityName.make("shell.openPath"),
} as const

/** One method in the closed Core-to-host RPC audience. */
export type CoreHostCapabilityMethod = "Host.openExternal" | "Host.openPath"

/** Closed allowlist of reverse RPC methods accepted by Electron. */
export const CoreHostCapabilityAllowlist: ReadonlySet<CoreHostCapabilityMethod> = new Set([
  "Host.openExternal",
  "Host.openPath",
])

const HostExternalUrl = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(2_048)),
  Schema.check(Schema.isPattern(/^https?:\/\/[^\s]+$/u)),
)
const HostAbsolutePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
  Schema.check(Schema.isPattern(/^\/(?!.*\0).*$/u)),
)

/** Core request to open an HTTP(S) URL with the operating system. */
export const HostOpenExternalRequest = Schema.Struct({
  context: CoreRequestContext,
  url: HostExternalUrl,
}).annotate({ identifier: "HostOpenExternalRequest" })

/** Core request to open an HTTP(S) URL with the operating system. */
export type HostOpenExternalRequest = typeof HostOpenExternalRequest.Type

/** Core request to open one already-authorized absolute path with the operating system. */
export const HostOpenPathRequest = Schema.Struct({
  context: CoreRequestContext,
  path: HostAbsolutePath,
}).annotate({ identifier: "HostOpenPathRequest" })

/** Core request to open one already-authorized absolute path with the operating system. */
export type HostOpenPathRequest = typeof HostOpenPathRequest.Type

/** Stable plain failure returned by an allowlisted native host capability. */
export const CoreHostCapabilityFailure = Schema.TaggedStruct("CoreHostCapabilityFailure", {
  method: Schema.Literals(["Host.openExternal", "Host.openPath"]),
  applicationInstanceId: CoreRequestContext.fields.applicationInstanceId,
  processEpoch: CoreRequestContext.fields.processEpoch,
  requestId: CoreRequestContext.fields.requestId,
  code: Schema.Literals([
    "HOST_CAPABILITY_REJECTED",
    "HOST_CAPABILITY_FAILED",
    "HOST_CAPABILITY_DEADLINE_EXCEEDED",
  ]),
  retryClass: Schema.Literals(["automatic", "notRetryable"]),
  safeMessage: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(240)),
  ),
}).annotate({ identifier: "CoreHostCapabilityFailure" })

/** Stable plain failure returned by an allowlisted native host capability. */
export type CoreHostCapabilityFailure = typeof CoreHostCapabilityFailure.Type

const hostCapabilityPolicy = (capability: CoreHostCapabilityName): CoreRpcMethodPolicy =>
  CoreRpcMethodPolicy.make({
    deadlineMs: CoreRpcDeadlineMilliseconds.make(5_000),
    maxRequestBytes: CoreRpcPayloadBytes.make(8 * 1_024),
    maxResponseBytes: CoreRpcPayloadBytes.make(1_024),
    cancellation: "interruptible",
    requiredScope: "application",
    mutationClass: "uncertainMutation",
    idempotency: "nonIdempotent",
    restartBehavior: "failOnRestart",
    requiredHostCapabilities: [capability],
  })

/** Reverse RPC that delegates an HTTP(S) URL to Electron's shell policy. */
export const HostOpenExternalRpc = Rpc.make("Host.openExternal", {
  payload: HostOpenExternalRequest,
  success: Schema.Void,
  error: CoreHostCapabilityFailure,
}).annotate(CoreRpcMethodPolicyAnnotation, hostCapabilityPolicy(CoreHostCapability.openExternal))

/** Reverse RPC that delegates an authorized local path to Electron's shell policy. */
export const HostOpenPathRpc = Rpc.make("Host.openPath", {
  payload: HostOpenPathRequest,
  success: Schema.Void,
  error: CoreHostCapabilityFailure,
}).annotate(CoreRpcMethodPolicyAnnotation, hostCapabilityPolicy(CoreHostCapability.openPath))

/** Core-to-Electron host-capability declarations kept separate from renderer-facing RPCs. */
export const CoreHostCapabilityRpcs = RpcGroup.make(HostOpenExternalRpc, HostOpenPathRpc)
