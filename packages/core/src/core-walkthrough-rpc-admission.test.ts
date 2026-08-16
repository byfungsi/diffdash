import { AgentModelQuality } from "@diffdash/domain/ai-settings"
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
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetStoredWalkthroughResult,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughAttemptSummaries,
  WalkthroughCancelResult,
  WalkthroughCandidatePlanFingerprint,
  WalkthroughConfiguredRoute,
  WalkthroughIdempotencyKey,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughReviewGeneration,
} from "@diffdash/core-rpc/walkthrough"
import { WalkthroughBusinessRpcs } from "@diffdash/core-rpc/walkthrough-rpc"
import { CORE_RPC_MAX_CONCURRENCY } from "@diffdash/core-rpc/transport"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema } from "effect"
import * as RpcTest from "effect/unstable/rpc/RpcTest"
import { TestClock } from "effect/testing"

import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { coreRpcAdmissionLayer } from "./core-rpc-admission"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-walkthrough-admission"),
  processEpoch: CoreProcessEpoch.make("epoch-walkthrough-admission"),
} as const
const requestIdentity = {
  ...identity,
  requestId: HostRequestId.make("h:walkthrough-admission"),
} as const
const operationId = WalkthroughOperationId.make("walkthrough-admission-operation")
const stateVersion = WalkthroughOperationStateVersion.make(1)
const timestamp = WalkthroughOperationTimestamp.make("2026-08-16T00:00:00.000Z")
const promptVersion = WalkthroughOperationPromptVersion.make("walkthrough-v4")
const reviewGeneration = WalkthroughReviewGeneration.make({
  kind: "local",
  projectId: ReviewProjectId.make("project-admission"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:0123456789abcdef0123456789abcdef"),
  reviewKey: ReviewKey.make("local:project-admission:working-tree"),
  baseRevision: ReviewRevision.make("base-admission"),
  headRevision: ReviewRevision.make("head-admission"),
})
const target = Schema.decodeUnknownSync(StartWalkthroughRequest.fields.target)({
  kind: "local",
  rootPath: "/workspace/diffdash",
  comparison: { _tag: "workingTree" },
})
const startRequest = StartWalkthroughRequest.make({
  ...requestIdentity,
  target,
  regenerate: false,
  idempotencyKey: WalkthroughIdempotencyKey.make("w:admission-intent"),
})
const getOperationRequest = GetWalkthroughOperationRequest.make({
  ...requestIdentity,
  operationId,
})
const cancelRequest = CancelWalkthroughRequest.make({ ...requestIdentity, operationId })
const getStoredRequest = GetStoredWalkthroughRequest.make({
  ...requestIdentity,
  target,
  promptVersion,
})
const storedNotFound = Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
  status: "notFound",
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
  configuredRoute: Schema.decodeUnknownSync(WalkthroughConfiguredRoute)({
    mode: "auto",
    quality: AgentModelQuality.make("balanced"),
  }),
  candidatePlanFingerprint: WalkthroughCandidatePlanFingerprint.make(
    `walkthrough-plan:v1:${"a".repeat(64)}`,
  ),
  attempts: Schema.decodeUnknownSync(WalkthroughAttemptSummaries)([]),
  acceptedAt: timestamp,
  updatedAt: timestamp,
  state: "active",
  phase: "queued",
})
const cancelledResult = Schema.decodeUnknownSync(WalkthroughCancelResult)({
  status: "cancelled",
  operation: { ...activeOperation, state: "cancelled", terminalAt: timestamp },
})
const accepted = WalkthroughOperationAccepted.make({
  ...requestIdentity,
  operationId,
  stateVersion,
  created: true,
})
const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...requestIdentity,
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-walkthrough-admission"),
})

const makeTestLayer = (options?: {
  readonly start?: Effect.Effect<typeof accepted>
  readonly getOperation?: Effect.Effect<typeof activeOperation>
  readonly cancel?: Effect.Effect<typeof cancelledResult>
  readonly getStored?: Effect.Effect<typeof storedNotFound>
}) => {
  const lifecycleLayer = coreLifecycleLayer(identity)
  const admissionLayer = coreRpcAdmissionLayer.pipe(Layer.provide(lifecycleLayer))
  const handlersLayer = WalkthroughBusinessRpcs.toLayer(
    Effect.succeed({
      "Walkthroughs.start": () => options?.start ?? Effect.succeed(accepted),
      "Walkthroughs.getOperation": () => options?.getOperation ?? Effect.succeed(activeOperation),
      "Walkthroughs.cancel": () => options?.cancel ?? Effect.succeed(cancelledResult),
      "Walkthroughs.getStored": () => options?.getStored ?? Effect.succeed(storedNotFound),
    }),
  )
  return Layer.mergeAll(lifecycleLayer, admissionLayer, handlersLayer)
}

const becomeReady = Effect.gen(function* () {
  const lifecycle = yield* CoreLifecycle
  yield* lifecycle.awaitOwnershipAuthorization
  yield* lifecycle.authorizeDatabaseOwnership(authorizationRequest)
  yield* lifecycle.completeRecovery
})

describe("Core walkthrough RPC admission", () => {
  it.effect("rejects every walkthrough method before Core is ready", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)

      const startFailure = yield* client["Walkthroughs.start"](startRequest).pipe(Effect.flip)
      const getFailure = yield* client["Walkthroughs.getOperation"](getOperationRequest).pipe(
        Effect.flip,
      )
      const cancelFailure = yield* client["Walkthroughs.cancel"](cancelRequest).pipe(Effect.flip)
      const storedFailure = yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(
        Effect.flip,
      )

      expect(startFailure).toMatchObject({
        _tag: "WalkthroughPublicFailure",
        method: "Walkthroughs.start",
        operationId: null,
        code: "CORE_UNAVAILABLE",
      })
      expect(getFailure).toMatchObject({
        method: "Walkthroughs.getOperation",
        operationId,
        code: "CORE_UNAVAILABLE",
      })
      expect(cancelFailure).toMatchObject({
        method: "Walkthroughs.cancel",
        operationId,
        code: "CORE_UNAVAILABLE",
      })
      expect(storedFailure).toMatchObject({
        method: "Walkthroughs.getStored",
        operationId: null,
        code: "CORE_UNAVAILABLE",
      })
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("classifies stale epochs for every walkthrough method as a Core restart", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      const staleIdentity = {
        ...requestIdentity,
        processEpoch: CoreProcessEpoch.make("epoch-stale"),
      } as const
      const staleStart = StartWalkthroughRequest.make({
        ...startRequest,
        ...staleIdentity,
      })
      const staleGet = GetWalkthroughOperationRequest.make({
        ...staleIdentity,
        operationId,
      })
      const staleCancel = CancelWalkthroughRequest.make({ ...staleIdentity, operationId })
      const staleStored = GetStoredWalkthroughRequest.make({
        ...getStoredRequest,
        ...staleIdentity,
      })

      const startFailure = yield* client["Walkthroughs.start"](staleStart).pipe(Effect.flip)
      const getFailure = yield* client["Walkthroughs.getOperation"](staleGet).pipe(Effect.flip)
      const cancelFailure = yield* client["Walkthroughs.cancel"](staleCancel).pipe(Effect.flip)
      const storedFailure = yield* client["Walkthroughs.getStored"](staleStored).pipe(Effect.flip)

      for (const failure of [startFailure, getFailure, cancelFailure, storedFailure]) {
        expect(failure).toMatchObject({ code: "CORE_RESTARTED", processEpoch: "epoch-stale" })
      }
      expect(startFailure).toMatchObject({ method: "Walkthroughs.start", operationId: null })
      expect(getFailure).toMatchObject({ method: "Walkthroughs.getOperation", operationId })
      expect(cancelFailure).toMatchObject({ method: "Walkthroughs.cancel", operationId })
      expect(storedFailure).toMatchObject({ method: "Walkthroughs.getStored", operationId: null })
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("serves an admitted walkthrough read after recovery", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      yield* becomeReady

      expect(yield* client["Walkthroughs.getStored"](getStoredRequest)).toEqual(storedNotFound)
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("projects every private walkthrough handler defect to its method-scoped value", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
      yield* becomeReady
      const startDefect = yield* client["Walkthroughs.start"](startRequest).pipe(
        Effect.catchDefect(Effect.succeed),
      )
      const getDefect = yield* client["Walkthroughs.getOperation"](getOperationRequest).pipe(
        Effect.catchDefect(Effect.succeed),
      )
      const cancelDefect = yield* client["Walkthroughs.cancel"](cancelRequest).pipe(
        Effect.catchDefect(Effect.succeed),
      )
      const storedDefect = yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(
        Effect.catchDefect(Effect.succeed),
      )

      const common = {
        _tag: "WalkthroughPublicFailure",
        ...requestIdentity,
        code: "WALKTHROUGH_INTERNAL_ERROR",
        providerId: null,
        modelId: null,
        retryClass: "notRetryable",
        remediation: "contactSupport",
        safeMessage: "DiffDash Core encountered an internal walkthrough error.",
        attempts: [],
        diagnostic: null,
      } as const
      expect(startDefect).toEqual({ ...common, method: "Walkthroughs.start", operationId: null })
      expect(getDefect).toEqual({
        ...common,
        method: "Walkthroughs.getOperation",
        operationId,
      })
      expect(cancelDefect).toEqual({ ...common, method: "Walkthroughs.cancel", operationId })
      expect(storedDefect).toEqual({
        ...common,
        method: "Walkthroughs.getStored",
        operationId: null,
      })
      expect(JSON.stringify([startDefect, getDefect, cancelDefect, storedDefect])).not.toContain(
        "/Users/example",
      )
    }).pipe(
      Effect.provide(
        makeTestLayer({
          start: Effect.die(new Error("private /Users/example/repository/path")),
          getOperation: Effect.die(new Error("private /Users/example/repository/path")),
          cancel: Effect.die(new Error("private /Users/example/repository/path")),
          getStored: Effect.die(new Error("private /Users/example/repository/path")),
        }),
      ),
    ),
  )

  it.effect("interrupts an admitted walkthrough read when draining begins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const getStored = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const fiber = yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)

        yield* lifecycle.shutdown(requestIdentity)
        yield* Deferred.await(interrupted)
        const exit = yield* Fiber.await(fiber)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("Expected the walkthrough read to be interrupted")
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }).pipe(Effect.provide(makeTestLayer({ getStored })))
    }),
  )

  it.effect("interrupts an admitted start before durable acceptance when draining begins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const acceptanceRecorded = yield* Ref.make(false)
      const start = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.andThen(Ref.set(acceptanceRecorded, true)),
        Effect.as(accepted),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const fiber = yield* client["Walkthroughs.start"](startRequest).pipe(Effect.forkScoped)
        yield* Deferred.await(started)

        yield* lifecycle.shutdown(requestIdentity)
        yield* Deferred.await(interrupted)
        const exit = yield* Fiber.await(fiber)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("Expected walkthrough start to be interrupted")
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Ref.get(acceptanceRecorded)).toBe(false)
      }).pipe(Effect.provide(makeTestLayer({ start })))
    }),
  )

  it.effect("allows admitted cancellation to finish after draining begins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cancel = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(cancelledResult),
      )

      return yield* Effect.gen(function* () {
        const lifecycle = yield* CoreLifecycle
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const fiber = yield* client["Walkthroughs.cancel"](cancelRequest).pipe(Effect.forkScoped)
        yield* Deferred.await(started)

        yield* lifecycle.shutdown(requestIdentity)
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(fiber)).toEqual(cancelledResult)
      }).pipe(Effect.provide(makeTestLayer({ cancel })))
    }),
  )

  it.effect("finishes admitted cancellation after caller interruption", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const cancel = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(completed, undefined)),
        Effect.as(cancelledResult),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const requestFiber = yield* client["Walkthroughs.cancel"](cancelRequest).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        const interruptFiber = yield* Fiber.interrupt(requestFiber).pipe(Effect.forkScoped)

        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(completed)
        yield* Fiber.join(interruptFiber)
      }).pipe(Effect.provide(makeTestLayer({ cancel })))
    }),
  )

  it.effect("interrupts reads at their declared deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const getStored = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const requestFiber = yield* client["Walkthroughs.getStored"](getStoredRequest).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("2 seconds")

        const failure = yield* Fiber.join(requestFiber).pipe(Effect.flip)
        expect(failure).toMatchObject({
          code: "REQUEST_DEADLINE_EXCEEDED",
          method: "Walkthroughs.getStored",
          operationId: null,
        })
        yield* Deferred.await(interrupted)
      }).pipe(Effect.provide(makeTestLayer({ getStored })))
    }),
  )

  it.effect("interrupts operation reads at their declared deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const getOperation = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const requestFiber = yield* client["Walkthroughs.getOperation"](getOperationRequest).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("2 seconds")

        const failure = yield* Fiber.join(requestFiber).pipe(Effect.flip)
        expect(failure).toMatchObject({
          code: "REQUEST_DEADLINE_EXCEEDED",
          method: "Walkthroughs.getOperation",
          operationId,
        })
        yield* Deferred.await(interrupted)
      }).pipe(Effect.provide(makeTestLayer({ getOperation })))
    }),
  )

  it.effect("interrupts start before durable acceptance at its declared deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const start = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const requestFiber = yield* client["Walkthroughs.start"](startRequest).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("5 seconds")

        const failure = yield* Fiber.join(requestFiber).pipe(Effect.flip)
        expect(failure).toMatchObject({
          code: "REQUEST_DEADLINE_EXCEEDED",
          method: "Walkthroughs.start",
          operationId: null,
        })
        yield* Deferred.await(interrupted)
      }).pipe(Effect.provide(makeTestLayer({ start })))
    }),
  )

  it.effect("returns at the cancellation deadline while the mutation completes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const cancel = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(completed, undefined)),
        Effect.as(cancelledResult),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const requestFiber = yield* client["Walkthroughs.cancel"](cancelRequest).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("5 seconds")

        const failure = yield* Fiber.join(requestFiber).pipe(Effect.flip)
        expect(failure).toMatchObject({
          code: "REQUEST_DEADLINE_EXCEEDED",
          method: "Walkthroughs.cancel",
          operationId,
        })
        expect(yield* Deferred.isDone(completed)).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(completed)
      }).pipe(Effect.provide(makeTestLayer({ cancel })))
    }),
  )

  it.effect("bounds cancellation work that continues after request deadlines", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0)
      const completed = yield* Ref.make(0)
      const atCapacity = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cancel = Ref.updateAndGet(started, (count) => count + 1).pipe(
        Effect.tap((count) =>
          count === CORE_RPC_MAX_CONCURRENCY
            ? Deferred.succeed(atCapacity, undefined)
            : Effect.void,
        ),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Ref.update(completed, (count) => count + 1)),
        Effect.as(cancelledResult),
      )

      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WalkthroughBusinessRpcs)
        yield* becomeReady
        const requestFibers = yield* Effect.forEach(
          Array.from({ length: CORE_RPC_MAX_CONCURRENCY }, (_, index) => index),
          (index) =>
            client["Walkthroughs.cancel"](
              CancelWalkthroughRequest.make({
                ...cancelRequest,
                requestId: HostRequestId.make(`h:bounded-cancel-${String(index)}`),
              }),
            ).pipe(Effect.forkScoped),
        )
        yield* Deferred.await(atCapacity)
        yield* TestClock.adjust("5 seconds")
        const failures = yield* Effect.forEach(requestFibers, (fiber) =>
          Fiber.join(fiber).pipe(Effect.flip),
        )
        expect(failures).toHaveLength(CORE_RPC_MAX_CONCURRENCY)
        expect(failures.every((failure) => failure.code === "REQUEST_DEADLINE_EXCEEDED")).toBe(true)

        const overflow = yield* client["Walkthroughs.cancel"](
          CancelWalkthroughRequest.make({
            ...cancelRequest,
            requestId: HostRequestId.make("h:bounded-cancel-overflow"),
          }),
        ).pipe(Effect.flip)
        expect(overflow).toMatchObject({
          code: "CORE_RPC_ERROR",
          method: "Walkthroughs.cancel",
          operationId,
        })
        expect(yield* Ref.get(started)).toBe(CORE_RPC_MAX_CONCURRENCY)

        yield* Deferred.succeed(release, undefined)
        yield* Effect.yieldNow
        expect(yield* Ref.get(completed)).toBe(CORE_RPC_MAX_CONCURRENCY)
      }).pipe(Effect.provide(makeTestLayer({ cancel })))
    }),
  )
})
