import { Effect, Layer, Stream } from "effect"

import { AgentCapabilityReady, WalkthroughRequest } from "@diffdash/agent-provider"
import {
  makeOpenCodeProvider,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_WALKTHROUGH_POLICY,
  openCodeModelId,
} from "@diffdash/agent-provider-opencode"
import { CliError, CliService, type CliRunner } from "@diffdash/process/cli"
import { AIAgent, type AIProviderAgent } from "./ai-agent"
import { AppConfig } from "./app-config"

/** Creates the legacy walkthrough adapter over the OpenCode SDK provider. */
export const makeOpenCodeAgent = (
  cli: CliRunner,
  model: string,
  tempDir: string,
): AIProviderAgent => {
  const registration = makeOpenCodeProvider({
    cli,
    cliStream: { stream: () => Stream.die(new Error("Review streaming is not used")) },
    tempDirectory: tempDir,
  })
  const walkthrough = registration.walkthrough
  if (walkthrough === undefined)
    throw new Error("OpenCode walkthrough capability is not registered")

  return AIAgent.of({
    generateText: Effect.fn("OpenCodeAgent.generateText")(function (prompt, options = {}) {
      return walkthrough
        .execute(
          WalkthroughRequest.make({
            prompt,
            model: openCodeModelId(model),
            workingDirectory: options.cwd ?? tempDir,
            timeoutMs: options.timeoutMs ?? 10 * 60 * 1_000,
            reasoningEffort: options.reasoningEffort ?? "medium",
            policy: OPENCODE_WALKTHROUGH_POLICY,
          }),
        )
        .pipe(
          Effect.map(({ text }) => text),
          Effect.mapError((cause) => legacyCliError(cause.reason)),
        )
    }),
    isAvailable: walkthrough.probe.pipe(
      Effect.map((result) => result instanceof AgentCapabilityReady),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  })
}

/** Legacy AI agent layer backed by the extracted OpenCode provider. */
export const OpenCodeAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const cli = yield* CliService
      const config = yield* AppConfig
      return makeOpenCodeAgent(cli, OPENCODE_DEFAULT_MODEL, config.tempDir)
    }),
  ),
}

const legacyCliError = (stderr: string) =>
  CliError.make({
    command: "opencode",
    args: [],
    cwd: null,
    exitCode: null,
    stderr,
    cause: null,
  })
