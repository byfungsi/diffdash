import { Repo } from "@diffdash/domain/repository"
import { AppUpdateChecking, AppUpdateIdle } from "@diffdash/protocol/app-update"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  bridgeTransportError,
  TransportError,
  transportError,
} from "@diffdash/protocol/transport-error"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"

import { invokePreload, preloadEventStream } from "./renderer-api-error"
import { consumeRendererStream, runRendererPromise } from "./renderer-runtime"

describe("invokePreload", () => {
  it.effect("rehydrates schema classes after the context bridge", () =>
    Effect.gen(function* () {
      const repositories = yield* invokePreload(InvokeChannel.listRepositories, async () => [
        {
          id: "repo-1",
          provider: "local",
          owner: "local",
          name: "diffdash",
          remoteUrl: "",
          localPath: "/workspace/diffdash",
          isFavorite: true,
          lastOpenedAt: null,
          lastSyncedAt: null,
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        },
      ])

      expect(repositories[0]).toBeInstanceOf(Repo)
      expect(repositories[0]?.localPath).toBe("/workspace/diffdash")
    }),
  )

  it.effect("restores structured transport failures", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        invokePreload(InvokeChannel.listRepositories, async () => {
          throw bridgeTransportError(
            transportError("REPOSITORY_UNAVAILABLE", "Repository unavailable", "repositories:list"),
          )
        }),
      )

      expect(failure).toBeInstanceOf(TransportError)
      expect(failure.code).toBe("REPOSITORY_UNAVAILABLE")
      expect(failure.message).toBe("Repository unavailable")
    }),
  )

  it.effect("redacts unstructured preload failures", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        invokePreload(InvokeChannel.listRepositories, async () => {
          throw new Error("internal stack and credentials")
        }),
      )

      expect(failure.code).toBe("RENDERER_API_FAILURE")
      expect(failure.message).toBe("DiffDash could not complete the request.")
      expect(failure.operation).toBe(InvokeChannel.listRepositories)
    }),
  )

  it.effect("rejects context-bridged values that violate the response schema", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        invokePreload(InvokeChannel.listRepositories, async () => ({ repositories: [] })),
      )

      expect(failure.code).toBe("INVALID_RESPONSE")
      expect(failure.operation).toBe(InvokeChannel.listRepositories)
    }),
  )

  it("preserves the exact expected failure at Promise-based UI boundaries", async () => {
    const failure = transportError(
      "AgentProviderAuthenticationError",
      "Authentication failed",
      "localWalkthroughs:generate",
    )

    await expect(runRendererPromise(Effect.fail(failure))).rejects.toBe(failure)
  })
})

describe("renderer streams", () => {
  it.effect("subscribes before loading initial state and replays buffered events afterward", () =>
    Effect.gen(function* () {
      let listener: ((payload: unknown) => void) | undefined
      let subscribed = false
      const initial = AppUpdateIdle.make({ currentVersion: "1.0.0" })
      const checking = AppUpdateChecking.make({ currentVersion: "1.0.0" })
      const stream = preloadEventStream(
        EventChannel.updateStateChanged,
        (next) => {
          listener = next
          subscribed = true
          return () => {
            subscribed = false
          }
        },
        Effect.sync(() => {
          if (listener === undefined) throw new Error("Subscription was not installed")
          listener(checking)
          return initial
        }),
      )

      const values = yield* stream.pipe(Stream.take(2), Stream.runCollect)

      expect(Array.from(values)).toEqual([initial, checking])
      expect(subscribed).toBe(false)
    }),
  )

  it.effect("reports typed failures and reconnects the stream", () =>
    Effect.gen(function* () {
      const failure = transportError("INVALID_EVENT", "Invalid updater event", "updates")
      const errors: TransportError[] = []
      const values: string[] = []
      let attempts = 0
      const stream = Stream.unwrap(
        Effect.sync(() => {
          attempts += 1
          return attempts === 1 ? Stream.fail(failure) : Stream.make("reconnected")
        }),
      )
      const fiber = yield* consumeRendererStream(
        stream,
        (value) => Effect.sync(() => void values.push(value)),
        (error) => Effect.sync(() => void errors.push(error)),
      ).pipe(Effect.forkChild)

      yield* Effect.yieldNow
      expect(errors).toEqual([failure])
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(fiber)

      expect(attempts).toBe(2)
      expect(values).toEqual(["reconnected"])
    }),
  )
})
