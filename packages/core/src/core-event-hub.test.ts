import { ApplicationInstanceId, CoreEventSequence, CoreProcessEpoch } from "@diffdash/core-rpc"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"

import { CoreEventHub, makeCoreEventHubLayer } from "./core-event-hub"

const epoch = CoreProcessEpoch.make("epoch-1")
const layer = makeCoreEventHubLayer({
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: epoch,
  replayCapacity: 2,
})

const draft = (stateVersion: number) => ({
  topic: "walkthrough.operation.progress",
  schemaVersion: 1,
  scopes: [{ name: "project", id: "project-1" }],
  source: "walkthrough-operation",
  reason: "state-transition",
  subject: { kind: "operation" as const, operationId: "operation-1" },
  kind: "operationProgress" as const,
  stateVersion,
})

describe("CoreEventHub", () => {
  it.effect("isolates failed subscribers and preserves publication order", () =>
    Effect.gen(function* () {
      const hub = yield* CoreEventHub
      const failed = yield* hub.events.pipe(
        Stream.runForEach(() => Effect.fail("subscriber failed")),
        Effect.forkChild,
      )
      const successful = yield* hub.events.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow

      yield* hub.publish(draft(1))
      yield* hub.publish(draft(2))

      expect((yield* Fiber.join(successful)).map(({ stateVersion }) => stateVersion)).toEqual([
        1, 2,
      ])
      expect((yield* Fiber.await(failed))._tag).toBe("Failure")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("replays retained hints or explicitly requires authoritative resync", () =>
    Effect.gen(function* () {
      const hub = yield* CoreEventHub
      yield* hub.publish(draft(1))
      yield* hub.publish(draft(2))
      yield* hub.publish(draft(3))
      yield* hub.publish(draft(4))

      expect(yield* hub.replay(epoch, CoreEventSequence.make(2))).toMatchObject({
        kind: "replay",
        events: [{ stateVersion: 3 }, { stateVersion: 4 }],
      })
      expect(yield* hub.replay(epoch, CoreEventSequence.make(1))).toMatchObject({
        kind: "resyncRequired",
        reason: "cursorExpired",
      })
      expect(yield* hub.replay(CoreProcessEpoch.make("epoch-old"), null)).toMatchObject({
        kind: "resyncRequired",
        reason: "epochChanged",
      })
      expect(yield* hub.replay(epoch, CoreEventSequence.make(99))).toMatchObject({
        kind: "resyncRequired",
        reason: "sequenceGap",
      })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("serializes concurrent publication across sequence, retention, and subscribers", () =>
    Effect.gen(function* () {
      const hub = yield* CoreEventHub
      const subscriber = yield* hub.events.pipe(
        Stream.take(20),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* Effect.all(
        Array.from({ length: 20 }, (_, index) => hub.publish(draft(index + 1))),
        { concurrency: "unbounded" },
      )

      expect((yield* Fiber.join(subscriber)).map(({ metadata }) => metadata.sequence)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      )
      expect(yield* hub.replay(epoch, CoreEventSequence.make(18))).toMatchObject({
        kind: "replay",
        events: [{ metadata: { sequence: 19 } }, { metadata: { sequence: 20 } }],
      })
    }).pipe(
      Effect.provide(
        makeCoreEventHubLayer({
          applicationInstanceId: ApplicationInstanceId.make("app-concurrent"),
          processEpoch: epoch,
          replayCapacity: 2,
        }),
      ),
    ),
  )
})
