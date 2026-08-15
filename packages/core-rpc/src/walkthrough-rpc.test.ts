import {
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  WalkthroughOperationId,
  WalkthroughOperationPromptVersion,
  WalkthroughOperationStateVersion,
  WalkthroughOperationTimestamp,
} from "@diffdash/domain/walkthrough-operation"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  WalkthroughCancelAdmissionMiddleware,
  WalkthroughGetOperationAdmissionMiddleware,
  WalkthroughGetStoredAdmissionMiddleware,
  WalkthroughStartAdmissionMiddleware,
} from "./admission"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import { getCoreRpcMethodPolicy } from "./method-policy"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetStoredWalkthroughResult,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughAttemptSummaries,
  WalkthroughCancelAdmissionFailure,
  WalkthroughCancelFailure,
  WalkthroughCancelResult,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughGetOperationFailure,
  WalkthroughGetStoredAdmissionFailure,
  WalkthroughGetStoredFailure,
  WalkthroughIdempotencyKey,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughReviewGeneration,
  WalkthroughStartAdmissionFailure,
  WalkthroughStartFailure,
} from "./walkthrough"
import {
  WalkthroughBusinessRpcs,
  WalkthroughCancelDefect,
  WalkthroughCancelRpc,
  WalkthroughGetOperationDefect,
  WalkthroughGetOperationRpc,
  WalkthroughGetStoredDefect,
  WalkthroughGetStoredRpc,
  WalkthroughStartDefect,
  WalkthroughStartRpc,
} from "./walkthrough-rpc"

const requestIdentity = {
  applicationInstanceId: ApplicationInstanceId.make("app-walkthrough-rpc"),
  processEpoch: CoreProcessEpoch.make("epoch-walkthrough-rpc"),
  requestId: HostRequestId.make("h:walkthrough-rpc"),
} as const
const operationId = WalkthroughOperationId.make("walkthrough-operation-rpc")
const stateVersion = WalkthroughOperationStateVersion.make(1)
const timestamp = WalkthroughOperationTimestamp.make("2026-08-15T00:00:00.000Z")
const promptVersion = WalkthroughOperationPromptVersion.make("walkthrough-v4")
const reviewGeneration = WalkthroughReviewGeneration.make({
  kind: "local",
  projectId: ReviewProjectId.make("project-rpc"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:0123456789abcdef0123456789abcdef"),
  reviewKey: ReviewKey.make("local:project-rpc:working-tree"),
  baseRevision: ReviewRevision.make("base-rpc"),
  headRevision: ReviewRevision.make("head-rpc"),
})
const attempts = Schema.decodeUnknownSync(WalkthroughAttemptSummaries)([
  {
    stage: "execute",
    outcome: "provider-exit",
    providerId: "claude",
    modelId: "claude-opus-5",
    attempt: 1,
  },
])
const startRequest = StartWalkthroughRequest.make({
  ...requestIdentity,
  reviewGeneration,
  regenerate: false,
  idempotencyKey: WalkthroughIdempotencyKey.make("w:rpc-intent"),
})
const accepted = WalkthroughOperationAccepted.make({
  ...requestIdentity,
  operationId,
  stateVersion,
  created: true,
})
const getOperationRequest = GetWalkthroughOperationRequest.make({
  ...requestIdentity,
  operationId,
})
const cancelRequest = CancelWalkthroughRequest.make({ ...requestIdentity, operationId })
const getStoredRequest = GetStoredWalkthroughRequest.make({
  ...requestIdentity,
  reviewGeneration,
  promptVersion,
})
const activeOperation = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
  acceptedRequest: requestIdentity,
  operationId,
  stateVersion,
  idempotencyKey: startRequest.idempotencyKey,
  reviewGeneration,
  promptVersion,
  configuredRoute: { mode: "auto", quality: "balanced" },
  candidatePlanFingerprint: `walkthrough-plan:v1:${"a".repeat(64)}`,
  attempts,
  acceptedAt: timestamp,
  updatedAt: timestamp,
  state: "active",
  phase: "falling-back",
})
const cancelledOperation = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
  ...activeOperation,
  state: "cancelled",
  terminalAt: timestamp,
})
const cancelledResult = Schema.decodeUnknownSync(WalkthroughCancelResult)({
  status: "cancelled",
  operation: cancelledOperation,
})
const storedNotFound = Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
  status: "notFound",
  reviewGeneration,
  promptVersion,
})
const startFailure = Schema.decodeUnknownSync(WalkthroughStartFailure)({
  _tag: "WalkthroughPublicFailure",
  ...requestIdentity,
  method: "Walkthroughs.start",
  operationId,
  code: "AGENT_PROVIDER_EXIT",
  providerId: "claude",
  modelId: "claude-opus-5",
  retryClass: "userAction",
  remediation: "reauthenticateProvider",
  safeMessage: "Claude exited before completing walkthrough generation.",
  attempts,
  diagnostic: null,
})
const getOperationFailure = Schema.decodeUnknownSync(WalkthroughGetOperationFailure)({
  _tag: "WalkthroughPublicFailure",
  ...requestIdentity,
  method: "Walkthroughs.getOperation",
  operationId,
  code: "WALKTHROUGH_OPERATION_NOT_FOUND",
  providerId: null,
  modelId: null,
  retryClass: "notRetryable",
  remediation: "none",
  safeMessage: "The walkthrough operation was not found.",
  attempts: [],
  diagnostic: null,
})
const cancelFailure = Schema.decodeUnknownSync(WalkthroughCancelFailure)({
  _tag: "WalkthroughPublicFailure",
  ...requestIdentity,
  method: "Walkthroughs.cancel",
  operationId,
  code: "WALKTHROUGH_OPERATION_STORE",
  providerId: null,
  modelId: null,
  retryClass: "userAction",
  remediation: "retry",
  safeMessage: "DiffDash could not persist walkthrough cancellation.",
  attempts: [],
  diagnostic: null,
})
const getStoredFailure = Schema.decodeUnknownSync(WalkthroughGetStoredFailure)({
  _tag: "WalkthroughPublicFailure",
  ...requestIdentity,
  method: "Walkthroughs.getStored",
  operationId: null,
  code: "WALKTHROUGH_STORE",
  providerId: null,
  modelId: null,
  retryClass: "userAction",
  remediation: "retry",
  safeMessage: "DiffDash could not read the stored walkthrough.",
  attempts: [],
  diagnostic: null,
})
const startAdmissionFailure = Schema.decodeUnknownSync(WalkthroughStartAdmissionFailure)({
  _tag: "WalkthroughPublicFailure",
  ...requestIdentity,
  method: "Walkthroughs.start",
  operationId: null,
  code: "CORE_DRAINING",
  providerId: null,
  modelId: null,
  retryClass: "automatic",
  remediation: "retry",
  safeMessage: "DiffDash Core is draining.",
  attempts: [],
  diagnostic: null,
})
const getOperationAdmissionFailure = Schema.decodeUnknownSync(
  WalkthroughGetOperationAdmissionFailure,
)({ ...startAdmissionFailure, method: "Walkthroughs.getOperation", operationId })
const cancelAdmissionFailure = Schema.decodeUnknownSync(WalkthroughCancelAdmissionFailure)({
  ...startAdmissionFailure,
  method: "Walkthroughs.cancel",
  operationId,
})
const getStoredAdmissionFailure = Schema.decodeUnknownSync(WalkthroughGetStoredAdmissionFailure)({
  ...startAdmissionFailure,
  method: "Walkthroughs.getStored",
  operationId: null,
})
const getStoredResponseOverflowFailure = Schema.decodeUnknownSync(
  WalkthroughGetStoredAdmissionFailure,
)({
  ...getStoredAdmissionFailure,
  code: "RESPONSE_TOO_LARGE",
  retryClass: "notRetryable",
  remediation: "none",
  safeMessage: "The walkthrough response exceeded its size limit.",
})

const passAdmissionLayer = Layer.mergeAll(
  Layer.succeed(WalkthroughStartAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughCancelAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, (effect) => effect),
)

const makeDefect = <Method extends string, OperationId extends string | null>(
  method: Method,
  defectOperationId: OperationId,
) => ({
  _tag: "WalkthroughPublicFailure" as const,
  ...requestIdentity,
  method,
  operationId: defectOperationId,
  code: "WALKTHROUGH_INTERNAL_ERROR" as const,
  providerId: null,
  modelId: null,
  retryClass: "notRetryable" as const,
  remediation: "contactSupport" as const,
  safeMessage: "DiffDash Core encountered an internal walkthrough error." as const,
  attempts,
  diagnostic: null,
})

describe("walkthrough RPC declarations", () => {
  it.effect(
    "executes every walkthrough method through the native in-memory client and server",
    () => {
      const handlers = WalkthroughBusinessRpcs.toLayer({
        "Walkthroughs.start": () => Effect.succeed(accepted),
        "Walkthroughs.getOperation": () => Effect.succeed(activeOperation),
        "Walkthroughs.cancel": () => Effect.succeed(cancelledResult),
        "Walkthroughs.getStored": () => Effect.succeed(storedNotFound),
      })

      return Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        expect(yield* client["Walkthroughs.start"](startRequest)).toEqual(accepted)
        expect(yield* client["Walkthroughs.getOperation"](getOperationRequest)).toEqual(
          activeOperation,
        )
        expect(yield* client["Walkthroughs.cancel"](cancelRequest)).toEqual(cancelledResult)
        expect(yield* client["Walkthroughs.getStored"](getStoredRequest)).toEqual(storedNotFound)
      }).pipe(Effect.provide(handlers), Effect.provide(passAdmissionLayer))
    },
  )

  it.effect("preserves every method-scoped plain expected failure through native RPC", () => {
    const handlers = WalkthroughBusinessRpcs.toLayer({
      "Walkthroughs.start": () => Effect.fail(startFailure),
      "Walkthroughs.getOperation": () => Effect.fail(getOperationFailure),
      "Walkthroughs.cancel": () => Effect.fail(cancelFailure),
      "Walkthroughs.getStored": () => Effect.fail(getStoredFailure),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      const failures = [
        yield* client["Walkthroughs.start"](startRequest).pipe(Effect.flip),
        yield* client["Walkthroughs.getOperation"](getOperationRequest).pipe(Effect.flip),
        yield* client["Walkthroughs.cancel"](cancelRequest).pipe(Effect.flip),
        yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(Effect.flip),
      ]
      expect(failures).toEqual([startFailure, getOperationFailure, cancelFailure, getStoredFailure])
      for (const failure of failures) {
        expect(failure).not.toBeInstanceOf(Error)
        expect(failure).not.toHaveProperty("cause")
        expect(failure).not.toHaveProperty("stack")
        expect(failure).not.toHaveProperty("path")
      }
    }).pipe(Effect.provide(handlers), Effect.provide(passAdmissionLayer))
  })

  it.effect("preserves every method-scoped admission failure through native RPC", () => {
    const handlers = WalkthroughBusinessRpcs.toLayer({
      "Walkthroughs.start": () => Effect.succeed(accepted),
      "Walkthroughs.getOperation": () => Effect.succeed(activeOperation),
      "Walkthroughs.cancel": () => Effect.succeed(cancelledResult),
      "Walkthroughs.getStored": () => Effect.succeed(storedNotFound),
    })
    const rejectAdmissionLayer = Layer.mergeAll(
      Layer.succeed(WalkthroughStartAdmissionMiddleware, () => Effect.fail(startAdmissionFailure)),
      Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, () =>
        Effect.fail(getOperationAdmissionFailure),
      ),
      Layer.succeed(WalkthroughCancelAdmissionMiddleware, () =>
        Effect.fail(cancelAdmissionFailure),
      ),
      Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, () =>
        Effect.fail(getStoredAdmissionFailure),
      ),
    )

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      const failures = [
        yield* client["Walkthroughs.start"](startRequest).pipe(Effect.flip),
        yield* client["Walkthroughs.getOperation"](getOperationRequest).pipe(Effect.flip),
        yield* client["Walkthroughs.cancel"](cancelRequest).pipe(Effect.flip),
        yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(Effect.flip),
      ]
      expect(failures).toEqual([
        startAdmissionFailure,
        getOperationAdmissionFailure,
        cancelAdmissionFailure,
        getStoredAdmissionFailure,
      ])
    }).pipe(Effect.provide(handlers), Effect.provide(rejectAdmissionLayer))
  })

  it.effect("projects every sanitized walkthrough defect through native RPC", () => {
    const startDefect = WalkthroughStartDefect.make(makeDefect("Walkthroughs.start", operationId))
    const getOperationDefect = WalkthroughGetOperationDefect.make(
      makeDefect("Walkthroughs.getOperation", operationId),
    )
    const cancelDefect = WalkthroughCancelDefect.make(
      makeDefect("Walkthroughs.cancel", operationId),
    )
    const getStoredDefect = WalkthroughGetStoredDefect.make(
      makeDefect("Walkthroughs.getStored", null),
    )
    const handlers = WalkthroughBusinessRpcs.toLayer({
      "Walkthroughs.start": () => Effect.die(new Error("private /Users/example/repository")),
      "Walkthroughs.getOperation": () => Effect.die(new Error("private operation defect")),
      "Walkthroughs.cancel": () => Effect.die(new Error("private cancellation defect")),
      "Walkthroughs.getStored": () => Effect.die(new Error("private stored defect")),
    })
    const defectAdmissionLayer = Layer.mergeAll(
      Layer.succeed(WalkthroughStartAdmissionMiddleware, (effect) =>
        effect.pipe(Effect.catchDefect(() => Effect.die(startDefect))),
      ),
      Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, (effect) =>
        effect.pipe(Effect.catchDefect(() => Effect.die(getOperationDefect))),
      ),
      Layer.succeed(WalkthroughCancelAdmissionMiddleware, (effect) =>
        effect.pipe(Effect.catchDefect(() => Effect.die(cancelDefect))),
      ),
      Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, (effect) =>
        effect.pipe(Effect.catchDefect(() => Effect.die(getStoredDefect))),
      ),
    )

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      const defects = [
        yield* client["Walkthroughs.start"](startRequest).pipe(Effect.catchDefect(Effect.succeed)),
        yield* client["Walkthroughs.getOperation"](getOperationRequest).pipe(
          Effect.catchDefect(Effect.succeed),
        ),
        yield* client["Walkthroughs.cancel"](cancelRequest).pipe(
          Effect.catchDefect(Effect.succeed),
        ),
        yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(
          Effect.catchDefect(Effect.succeed),
        ),
      ]
      expect(defects).toEqual([startDefect, getOperationDefect, cancelDefect, getStoredDefect])
      for (const defect of defects) {
        expect(defect).not.toBeInstanceOf(Error)
        expect(defect).not.toHaveProperty("cause")
        expect(defect).not.toHaveProperty("stack")
        expect(defect).not.toHaveProperty("path")
      }
    }).pipe(Effect.provide(handlers), Effect.provide(defectAdmissionLayer))
  })

  it("declares exhaustive policies for every walkthrough method", () => {
    expect(getCoreRpcMethodPolicy(WalkthroughStartRpc)).toEqual(
      Option.some({
        deadlineMs: 5_000,
        maxRequestBytes: 8 * 1_024,
        maxResponseBytes: 64 * 1_024,
        cancellation: "detachedAfterAcceptance",
        requiredScope: "review",
        mutationClass: "idempotentMutation",
        idempotency: "idempotencyKeyRequired",
        restartBehavior: "retryByIdempotencyKey",
        requiredHostCapabilities: [],
      }),
    )
    expect(getCoreRpcMethodPolicy(WalkthroughGetOperationRpc)).toEqual(
      Option.some({
        deadlineMs: 2_000,
        maxRequestBytes: 2 * 1_024,
        maxResponseBytes: 384 * 1_024,
        cancellation: "interruptible",
        requiredScope: "operation",
        mutationClass: "read",
        idempotency: "idempotent",
        restartBehavior: "resumeByOperationId",
        requiredHostCapabilities: [],
      }),
    )
    expect(getCoreRpcMethodPolicy(WalkthroughCancelRpc)).toEqual(
      Option.some({
        deadlineMs: 5_000,
        maxRequestBytes: 2 * 1_024,
        maxResponseBytes: 384 * 1_024,
        cancellation: "uninterruptible",
        requiredScope: "operation",
        mutationClass: "idempotentMutation",
        idempotency: "idempotent",
        restartBehavior: "resumeByOperationId",
        requiredHostCapabilities: [],
      }),
    )
    expect(getCoreRpcMethodPolicy(WalkthroughGetStoredRpc)).toEqual(
      Option.some({
        deadlineMs: 2_000,
        maxRequestBytes: 8 * 1_024,
        maxResponseBytes: 384 * 1_024,
        cancellation: "interruptible",
        requiredScope: "review",
        mutationClass: "read",
        idempotency: "idempotent",
        restartBehavior: "retryInNewEpoch",
        requiredHostCapabilities: [],
      }),
    )
  })

  it("keeps failures method-scoped and roundtrips expected failures and defects via MessagePack", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(WalkthroughStartRpc.errorSchema)(cancelFailure)),
    ).toBe(true)

    const getOperationDefect = WalkthroughGetOperationDefect.make(
      makeDefect("Walkthroughs.getOperation", operationId),
    )
    const cancelDefect = WalkthroughCancelDefect.make(
      makeDefect("Walkthroughs.cancel", operationId),
    )
    const getStoredDefect = WalkthroughGetStoredDefect.make(
      makeDefect("Walkthroughs.getStored", null),
    )
    const values = [
      [WalkthroughStartRpc, Exit.fail(startFailure)],
      [WalkthroughStartRpc, Exit.fail(startAdmissionFailure)],
      [
        WalkthroughStartRpc,
        Exit.die(WalkthroughStartDefect.make(makeDefect("Walkthroughs.start", operationId))),
      ],
      [WalkthroughGetOperationRpc, Exit.fail(getOperationFailure)],
      [WalkthroughGetOperationRpc, Exit.fail(getOperationAdmissionFailure)],
      [WalkthroughGetOperationRpc, Exit.die(getOperationDefect)],
      [WalkthroughCancelRpc, Exit.fail(cancelFailure)],
      [WalkthroughCancelRpc, Exit.fail(cancelAdmissionFailure)],
      [WalkthroughCancelRpc, Exit.die(cancelDefect)],
      [WalkthroughGetStoredRpc, Exit.fail(getStoredFailure)],
      [WalkthroughGetStoredRpc, Exit.fail(getStoredAdmissionFailure)],
      [WalkthroughGetStoredRpc, Exit.fail(getStoredResponseOverflowFailure)],
      [WalkthroughGetStoredRpc, Exit.die(getStoredDefect)],
    ] as const
    const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 512 * 1_024 }).makeUnsafe()

    for (const [rpc, exit] of values) {
      const codec = Schema.toCodecJson(Rpc.exitSchema(rpc))
      const encoded = Schema.encodeSync(codec)(exit)
      const bytes = parser.encode(encoded)
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected native MessagePack bytes")
      const [decodedValue] = parser.decode(bytes)
      const decodedExit = Schema.decodeUnknownSync(codec)(decodedValue)
      expect(Exit.isFailure(decodedExit)).toBe(true)
      if (Exit.isSuccess(decodedExit)) throw new Error("Expected walkthrough failure exit")
      const decodedFailure = Cause.squash(decodedExit.cause)
      expect(decodedFailure).not.toBeInstanceOf(Error)
      expect(decodedFailure).not.toHaveProperty("cause")
      expect(decodedFailure).not.toHaveProperty("stack")
      expect(decodedFailure).not.toHaveProperty("path")
    }

    expect(getOperationFailure.method).toBe("Walkthroughs.getOperation")
    expect(getStoredFailure.method).toBe("Walkthroughs.getStored")
  })
})
