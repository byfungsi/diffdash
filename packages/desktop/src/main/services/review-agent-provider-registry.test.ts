import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"

import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { CliStreamError, CliStreamService } from "@diffdash/process/cli-stream"
import { OpenCodeSdkClient } from "./opencode-sdk-client"
import {
  ReviewAgentProviderRegistry,
  ReviewAgentProviderUnavailableError,
} from "./review-agent-provider-registry"

const unavailable = (command: string) =>
  CliStreamError.make({
    command,
    args: ["--version"],
    cwd: null,
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: `${command} unavailable`,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: false,
    reason: "spawn",
    message: `${command} unavailable`,
    cause: null,
  })

const layer = ReviewAgentProviderRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        OpenCodeSdkClient,
        OpenCodeSdkClient.of({
          isAvailable: Effect.succeed(false),
          runTurn: () => Effect.die(new Error("OpenCode turn is not used")),
        }),
      ),
      Layer.succeed(
        CliStreamService,
        CliStreamService.of({
          stream: (command) =>
            command === "codex" ? Stream.empty : Stream.fail(unavailable(command)),
        }),
      ),
      AgentArtifactNormalizer.layer,
    ),
  ),
)

describe("ReviewAgentProviderRegistry", () => {
  it.scoped("FUN-72 AC: selects the first available provider for auto settings", () =>
    Effect.gen(function* () {
      const registry = yield* ReviewAgentProviderRegistry
      const provider = yield* registry.resolve("auto")
      expect(provider.id).toBe("codex")
    }).pipe(Effect.provide(layer)),
  )

  it.scoped("FUN-72 AC: fails closed when an explicitly selected provider is unavailable", () =>
    Effect.gen(function* () {
      const registry = yield* ReviewAgentProviderRegistry
      const error = yield* registry.resolve("opencode").pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewAgentProviderUnavailableError)
      expect(error.reason).toContain("not installed or available")
    }).pipe(Effect.provide(layer)),
  )
})
