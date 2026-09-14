import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

import { makeHostDeathAwareProtocol } from "./core-rpc-socket-host"
import {
  CoreAuthenticatedHostSession,
  coreAuthenticatedHostSessionLayer,
} from "./core-transport-authentication"

const makeResponseProtocol = (
  disconnects: Queue.Queue<number>,
  send: RpcServer.Protocol["Service"]["send"],
) =>
  RpcServer.Protocol.of({
    disconnects,
    run: () => Effect.never,
    send,
    end: () => Effect.void,
    clientIds: Effect.succeed(new Set([0, 1])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
  })

describe("Core host response lifecycle", () => {
  it.effect("preserves response delivery for connected clients", () =>
    Effect.gen(function* () {
      const hostSession = yield* CoreAuthenticatedHostSession
      yield* hostSession.authenticated(0)
      const disconnects = yield* Queue.unbounded<number>()
      const writes = yield* Ref.make(0)
      const protocol = yield* makeHostDeathAwareProtocol(
        makeResponseProtocol(disconnects, () => Ref.update(writes, (count) => count + 1)),
        hostSession,
      )
      yield* protocol.send(0, { _tag: "Pong" })
      expect(yield* Ref.get(writes)).toBe(1)
      yield* protocol.send(1, { _tag: "Pong" })
      expect(yield* Ref.get(writes)).toBe(2)
    }).pipe(Effect.provide(coreAuthenticatedHostSessionLayer)),
  )

  it.effect("lets RPC request interruption cancel a stalled response finalizer", () =>
    Effect.gen(function* () {
      const hostSession = yield* CoreAuthenticatedHostSession
      yield* hostSession.authenticated(0)
      const disconnects = yield* Queue.unbounded<number>()
      const writeStarted = yield* Deferred.make<void>()
      const releaseWrite = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)
      const finalized = yield* Ref.make(false)
      const backing = makeResponseProtocol(disconnects, () =>
        Deferred.succeed(writeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseWrite)),
          Effect.onInterrupt(() => Ref.set(interrupted, true)),
        ),
      )
      const protocol = yield* makeHostDeathAwareProtocol(backing, hostSession)
      yield* Effect.gen(function* () {
        // RpcServer writes responses from an uninterruptible request finalizer.
        const response = yield* protocol
          .send(0, { _tag: "Pong" })
          .pipe(Effect.ensuring(Ref.set(finalized, true)), Effect.uninterruptible, Effect.forkChild)
        yield* Deferred.await(writeStarted)
        yield* Queue.offer(disconnects, 1)
        yield* TestClock.adjust(1)
        expect(yield* Ref.get(interrupted)).toBe(false)
        yield* Queue.offer(disconnects, 0)
        yield* hostSession.awaitDeath
        // RpcServer interrupts this client's request fibers when it consumes the disconnect.
        const cancellation = yield* Fiber.interrupt(response).pipe(Effect.forkChild)
        yield* TestClock.adjust(1)
        expect(yield* Ref.get(interrupted)).toBe(true)
        yield* Fiber.join(cancellation)
        expect(yield* Ref.get(finalized)).toBe(true)
      }).pipe(Effect.ensuring(Deferred.succeed(releaseWrite, undefined)))
    }).pipe(Effect.provide(coreAuthenticatedHostSessionLayer)),
  )
})
