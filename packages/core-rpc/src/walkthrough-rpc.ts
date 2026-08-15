import { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

import {
  WalkthroughCancelAdmissionMiddleware,
  WalkthroughGetOperationAdmissionMiddleware,
  WalkthroughGetStoredAdmissionMiddleware,
  WalkthroughStartAdmissionMiddleware,
} from "./admission"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import {
  CoreRpcDeadlineMilliseconds,
  CoreRpcMethodPolicy,
  CoreRpcMethodPolicyAnnotation,
  CoreRpcPayloadBytes,
} from "./method-policy"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetStoredWalkthroughResult,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughAttemptSummaries,
  WalkthroughCancelResult,
  WalkthroughCancelFailure,
  WalkthroughGetOperationFailure,
  WalkthroughGetStoredFailure,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughSafeDiagnostic,
  WalkthroughStartFailure,
} from "./walkthrough"

const WalkthroughDefectValue = Schema.NullishOr(Schema.ObjectKeyword)
const WalkthroughDefectIdentity = {
  applicationInstanceId: ApplicationInstanceId,
  processEpoch: CoreProcessEpoch,
  requestId: HostRequestId,
} as const
const WalkthroughDefectDetail = {
  code: Schema.Literal("WALKTHROUGH_INTERNAL_ERROR"),
  providerId: Schema.Null,
  modelId: Schema.Null,
  retryClass: Schema.Literal("notRetryable"),
  remediation: Schema.Literal("contactSupport"),
  safeMessage: Schema.Literal("DiffDash Core encountered an internal walkthrough error."),
  attempts: WalkthroughAttemptSummaries,
  diagnostic: Schema.NullOr(WalkthroughSafeDiagnostic),
} as const

/** Sanitized defect value for `Walkthroughs.start`. */
export const WalkthroughStartDefect = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughDefectIdentity,
  ...WalkthroughDefectDetail,
  method: Schema.Literal("Walkthroughs.start"),
  operationId: Schema.NullOr(WalkthroughOperationId),
}).annotate({ identifier: "WalkthroughStartDefect" })

/** Sanitized defect value for `Walkthroughs.start`. */
export type WalkthroughStartDefect = typeof WalkthroughStartDefect.Type

/** RPC defect codec whose wire form is the sanitized `Walkthroughs.start` defect. */
export const WalkthroughStartDefectSchema = WalkthroughStartDefect.pipe(
  Schema.decodeTo(WalkthroughDefectValue),
)

/** Sanitized defect value for `Walkthroughs.getOperation`. */
export const WalkthroughGetOperationDefect = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughDefectIdentity,
  ...WalkthroughDefectDetail,
  method: Schema.Literal("Walkthroughs.getOperation"),
  operationId: WalkthroughOperationId,
}).annotate({ identifier: "WalkthroughGetOperationDefect" })

/** Sanitized defect value for `Walkthroughs.getOperation`. */
export type WalkthroughGetOperationDefect = typeof WalkthroughGetOperationDefect.Type

/** RPC defect codec whose wire form is the sanitized `Walkthroughs.getOperation` defect. */
export const WalkthroughGetOperationDefectSchema = WalkthroughGetOperationDefect.pipe(
  Schema.decodeTo(WalkthroughDefectValue),
)

/** Sanitized defect value for `Walkthroughs.cancel`. */
export const WalkthroughCancelDefect = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughDefectIdentity,
  ...WalkthroughDefectDetail,
  method: Schema.Literal("Walkthroughs.cancel"),
  operationId: WalkthroughOperationId,
}).annotate({ identifier: "WalkthroughCancelDefect" })

/** Sanitized defect value for `Walkthroughs.cancel`. */
export type WalkthroughCancelDefect = typeof WalkthroughCancelDefect.Type

/** RPC defect codec whose wire form is the sanitized `Walkthroughs.cancel` defect. */
export const WalkthroughCancelDefectSchema = WalkthroughCancelDefect.pipe(
  Schema.decodeTo(WalkthroughDefectValue),
)

/** Sanitized defect value for `Walkthroughs.getStored`. */
export const WalkthroughGetStoredDefect = Schema.TaggedStruct("WalkthroughPublicFailure", {
  ...WalkthroughDefectIdentity,
  ...WalkthroughDefectDetail,
  method: Schema.Literal("Walkthroughs.getStored"),
  operationId: Schema.Null,
}).annotate({ identifier: "WalkthroughGetStoredDefect" })

/** Sanitized defect value for `Walkthroughs.getStored`. */
export type WalkthroughGetStoredDefect = typeof WalkthroughGetStoredDefect.Type

/** RPC defect codec whose wire form is the sanitized `Walkthroughs.getStored` defect. */
export const WalkthroughGetStoredDefectSchema = WalkthroughGetStoredDefect.pipe(
  Schema.decodeTo(WalkthroughDefectValue),
)

/** Business RPC that durably accepts or finds one walkthrough generation intent. */
export const WalkthroughStartRpc = Rpc.make("Walkthroughs.start", {
  payload: StartWalkthroughRequest,
  success: WalkthroughOperationAccepted,
  error: WalkthroughStartFailure,
  defect: WalkthroughStartDefectSchema,
})
  .middleware(WalkthroughStartAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(5_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(8 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(64 * 1_024),
      cancellation: "detachedAfterAcceptance",
      requiredScope: "review",
      mutationClass: "idempotentMutation",
      idempotency: "idempotencyKeyRequired",
      restartBehavior: "retryByIdempotencyKey",
      requiredHostCapabilities: [],
    }),
  )

/** Business RPC that reads authoritative state for one walkthrough operation. */
export const WalkthroughGetOperationRpc = Rpc.make("Walkthroughs.getOperation", {
  payload: GetWalkthroughOperationRequest,
  success: WalkthroughOperationSnapshot,
  error: WalkthroughGetOperationFailure,
  defect: WalkthroughGetOperationDefectSchema,
})
  .middleware(WalkthroughGetOperationAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(2_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(2 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(384 * 1_024),
      cancellation: "interruptible",
      requiredScope: "operation",
      mutationClass: "read",
      idempotency: "idempotent",
      restartBehavior: "resumeByOperationId",
      requiredHostCapabilities: [],
    }),
  )

/** Business RPC that requests cancellation unless a terminal operation state already won. */
export const WalkthroughCancelRpc = Rpc.make("Walkthroughs.cancel", {
  payload: CancelWalkthroughRequest,
  success: WalkthroughCancelResult,
  error: WalkthroughCancelFailure,
  defect: WalkthroughCancelDefectSchema,
})
  .middleware(WalkthroughCancelAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(5_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(2 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(384 * 1_024),
      cancellation: "uninterruptible",
      requiredScope: "operation",
      mutationClass: "idempotentMutation",
      idempotency: "idempotent",
      restartBehavior: "resumeByOperationId",
      requiredHostCapabilities: [],
    }),
  )

/** Business RPC that looks up the exact stored artifact for one immutable generation. */
export const WalkthroughGetStoredRpc = Rpc.make("Walkthroughs.getStored", {
  payload: GetStoredWalkthroughRequest,
  success: GetStoredWalkthroughResult,
  error: WalkthroughGetStoredFailure,
  defect: WalkthroughGetStoredDefectSchema,
})
  .middleware(WalkthroughGetStoredAdmissionMiddleware)
  .annotate(
    CoreRpcMethodPolicyAnnotation,
    CoreRpcMethodPolicy.make({
      deadlineMs: CoreRpcDeadlineMilliseconds.make(2_000),
      maxRequestBytes: CoreRpcPayloadBytes.make(8 * 1_024),
      maxResponseBytes: CoreRpcPayloadBytes.make(384 * 1_024),
      cancellation: "interruptible",
      requiredScope: "review",
      mutationClass: "read",
      idempotency: "idempotent",
      restartBehavior: "retryInNewEpoch",
      requiredHostCapabilities: [],
    }),
  )

/** Standalone Electron-to-Core walkthrough business declarations awaiting handler activation. */
export const WalkthroughBusinessRpcs = RpcGroup.make(
  WalkthroughStartRpc,
  WalkthroughGetOperationRpc,
  WalkthroughCancelRpc,
  WalkthroughGetStoredRpc,
)
