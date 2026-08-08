import { Repo } from "@diffdash/domain/repository"
import { InvokeChannel } from "@diffdash/protocol/channels"
import {
  bridgeTransportError,
  TransportError,
  transportError,
} from "@diffdash/protocol/transport-error"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { invokePreload } from "./renderer-api-error"
import { runRendererPromise } from "./renderer-runtime"

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
