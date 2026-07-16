import { Effect, Layer, Stream } from "effect"

import {
  CODEX_DEFAULT_MODEL,
  CODEX_WALKTHROUGH_POLICY,
  codexModelId,
  makeCodexProvider,
} from "@diffdash/agent-provider-codex"
import { AgentCapabilityReady, WalkthroughRequest } from "@diffdash/agent-provider"
import { CliError, CliService, type CliRunner } from "@diffdash/process/cli"
import { AIAgent, type AIProviderAgent } from "./ai-agent"
import { AppConfig } from "./app-config"

/** Creates the legacy walkthrough adapter over the Codex SDK provider. */
export const makeCodexAgent = (cli: CliRunner, model: string, tempDir: string): AIProviderAgent => {
  const registration = makeCodexProvider({
    cli,
    cliStream: { stream: () => Stream.die(new Error("Review streaming is not used")) },
    tempDirectory: tempDir,
  })
  const walkthrough = registration.walkthrough
  if (walkthrough === undefined) throw new Error("Codex walkthrough capability is not registered")

  return AIAgent.of({
    generateText: Effect.fn("CodexAgent.generateText")(function (prompt, options = {}) {
      const request = WalkthroughRequest.make({
        prompt,
        model: codexModelId(model),
        workingDirectory: options.cwd ?? tempDir,
        timeoutMs: options.timeoutMs ?? 10 * 60 * 1_000,
        reasoningEffort: options.reasoningEffort ?? "medium",
        policy: CODEX_WALKTHROUGH_POLICY,
      })
      return walkthrough.execute(request).pipe(
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

/** Legacy AI agent layer backed by the extracted Codex provider. */
export const CodexAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const cli = yield* CliService
      const config = yield* AppConfig
      return makeCodexAgent(cli, CODEX_DEFAULT_MODEL, config.tempDir)
    }),
  ),
}

const legacyCliError = (stderr: string) =>
  CliError.make({
    command: "codex",
    args: [],
    cwd: null,
    exitCode: null,
    stderr,
    cause: null,
  })
