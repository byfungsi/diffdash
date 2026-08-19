import { describe, expect, it } from "@effect/vitest"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { WalkthroughOperationId } from "@diffdash/domain/walkthrough-operation"
import { WalkthroughOperationStoreError } from "@diffdash/persistence/walkthrough-operation-store"
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect"
import { readFileSync } from "node:fs"

import { CoreDefectSummary } from "../core-contract"
import { makeWalkthroughActiveWorkers, summarizeCoreDefect } from "./walkthrough-operations"

describe("Durable walkthrough operation architecture", () => {
  it("keeps terminal history out of Core memory", () => {
    const source = readFileSync(new URL("./walkthrough-operations.ts", import.meta.url), "utf8")

    expect(source).toContain("FiberMap.make<")
    expect(source).not.toContain("Deferred")
    expect(source).not.toContain("MAX_RETAINED_WALKTHROUGH_OPERATIONS")
    expect(source).not.toContain("WalkthroughOperationCapacityExceeded")
    expect(source).not.toContain("new Map<WalkthroughOperationIdType")
  })

  it("summarizes defects into bounded serializable terminal data", () => {
    const summary = summarizeCoreDefect({
      _tag: "WalkthroughWorkerDefect",
      name: "WorkerFailure",
      message: "x".repeat(300),
    })

    expect(summary).toEqual({
      tag: "WalkthroughWorkerDefect",
      name: "WorkerFailure",
      message: "x".repeat(256),
    })
    expect(
      Schema.decodeUnknownSync(CoreDefectSummary)(
        JSON.parse(JSON.stringify(Schema.encodeSync(CoreDefectSummary)(summary))),
      ),
    ).toEqual(summary)
  })

  it.effect("removes successful workers without retaining terminal results", () =>
    Effect.gen(function* () {
      const workers = yield* makeWalkthroughActiveWorkers
      const operationId = WalkthroughOperationId.make("successful-active-worker")

      const fiber = yield* workers.run(operationId, Effect.succeed(Option.none()))
      const exit = yield* Fiber.join(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* workers.size).toBe(0)
      expect(Option.isNone(yield* workers.get(operationId))).toBe(true)
    }),
  )

  it.effect("isolates worker persistence failures without closing active tracking", () =>
    Effect.gen(function* () {
      const workers = yield* makeWalkthroughActiveWorkers
      const failedId = WalkthroughOperationId.make("failed-active-worker")
      const remainingId = WalkthroughOperationId.make("remaining-active-worker")
      const failure = WalkthroughOperationStoreError.make({
        operation: DiagnosticOperation.make("worker.test"),
        message: "Injected worker persistence failure.",
        cause: new Error("injected"),
      })

      const failedFiber = yield* workers.run(failedId, Effect.fail(failure))
      const failedExit = yield* Fiber.join(failedFiber)
      yield* workers.run(remainingId, Effect.never)

      expect(Exit.isFailure(failedExit)).toBe(true)
      expect(yield* workers.size).toBe(1)
      yield* workers.cancel(remainingId)
      expect(yield* workers.size).toBe(0)
    }),
  )

  it.effect("runs provider cleanup before cancellation leaves active tracking", () =>
    Effect.gen(function* () {
      const workers = yield* makeWalkthroughActiveWorkers
      const operationId = WalkthroughOperationId.make("cancelled-active-worker")
      const started = yield* Deferred.make<void>()
      const cleanedUp = yield* Ref.make(false)
      const provider = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(cleanedUp, true)),
      )

      yield* workers.run(operationId, provider)
      yield* Deferred.await(started)
      expect(yield* workers.size).toBe(1)

      yield* workers.cancel(operationId)

      expect(yield* Ref.get(cleanedUp)).toBe(true)
      expect(yield* workers.size).toBe(0)
    }),
  )

  it.effect("interrupts provider work when the Core operation scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cleanedUp = yield* Ref.make(false)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWalkthroughActiveWorkers
          yield* workers.run(
            WalkthroughOperationId.make("scope-closed-active-worker"),
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Ref.set(cleanedUp, true)),
            ),
          )
          yield* Deferred.await(started)
          expect(yield* workers.size).toBe(1)
        }),
      )

      expect(yield* Ref.get(cleanedUp)).toBe(true)
    }),
  )

  it.effect("leaves no active worker when completion races cancellation", () =>
    Effect.gen(function* () {
      const workers = yield* makeWalkthroughActiveWorkers
      const operationId = WalkthroughOperationId.make("terminal-active-worker-race")
      const completion = yield* Deferred.make<void>()
      const finalizations = yield* Ref.make(0)
      const worker = Deferred.await(completion).pipe(
        Effect.as(Option.none()),
        Effect.ensuring(Ref.update(finalizations, (count) => count + 1)),
      )
      const fiber = yield* workers.run(operationId, worker)

      yield* Effect.all([workers.cancel(operationId), Deferred.succeed(completion, undefined)], {
        concurrency: "unbounded",
      })
      yield* Fiber.await(fiber)

      expect(yield* Ref.get(finalizations)).toBe(1)
      expect(yield* workers.size).toBe(0)
    }),
  )
})
