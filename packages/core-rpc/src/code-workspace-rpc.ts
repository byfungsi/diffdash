import { CodeWorkspaceError, CodeWorkspaceLeaseId } from "@diffdash/domain/code-workspace"
import {
  LocalCheckoutFileChunk,
  LocalCheckoutFileReadError,
} from "@diffdash/domain/local-checkout-file"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware"

import { HostRequestContext } from "./identity"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"

/** Authenticated request to stream one managed Code workspace file. */
export const CoreCodeWorkspaceFileRequest = Schema.Struct({
  ...HostRequestContext.fields,
  leaseId: CodeWorkspaceLeaseId,
  path: RepositoryRelativePath,
}).annotate({ identifier: "CoreCodeWorkspaceFileRequest" })

/** Authenticated request to stream one managed Code workspace file. */
export type CoreCodeWorkspaceFileRequest = typeof CoreCodeWorkspaceFileRequest.Type

/** Streams bounded binary chunks while preserving expected workspace and file failures. */
export const CoreCodeWorkspaceFileError = Schema.Union([
  CodeWorkspaceError,
  LocalCheckoutFileReadError,
])

/** Streams bounded binary chunks while preserving expected workspace and file failures. */
export type CoreCodeWorkspaceFileError = typeof CoreCodeWorkspaceFileError.Type

/** Enforces Core lifecycle and deadline admission for streamed Code workspace files. */
export class CoreCodeWorkspaceFileAdmissionMiddleware extends RpcMiddleware.Service<CoreCodeWorkspaceFileAdmissionMiddleware>()(
  "@diffdash/core-rpc/CoreCodeWorkspaceFileAdmissionMiddleware",
  { error: CoreCodeWorkspaceFileError },
) {}

/** Streams bounded binary chunks while preserving expected workspace and file failures. */
export const CoreCodeWorkspaceFileStreamRpc = Rpc.make("CodeWorkspace.streamFile", {
  payload: CoreCodeWorkspaceFileRequest,
  success: LocalCheckoutFileChunk,
  error: CoreCodeWorkspaceFileError,
  stream: true,
})
  .middleware(CoreCodeWorkspaceFileAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(60_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(8 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(384 * 1_024),
      cancellation: "interruptible",
      requiredScope: "project",
      mutationClass: "read",
      idempotency: "idempotent",
      restartBehavior: "retryInNewEpoch",
      requiredHostCapabilities: [],
    }),
  )

/** Native streamed Code workspace file declarations. */
export const CoreCodeWorkspaceFileRpcs = RpcGroup.make(CoreCodeWorkspaceFileStreamRpc)

export { LocalCheckoutFileReadError }
export type CoreCodeWorkspaceFileChunk = LocalCheckoutFileChunk
