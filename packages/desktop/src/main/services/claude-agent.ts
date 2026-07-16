import { Effect, Layer, Stream } from "effect"

import { AgentCapabilityReady, WalkthroughRequest } from "@diffdash/agent-provider"
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_WALKTHROUGH_POLICY,
  claudeModelId,
  makeClaudeProvider,
} from "@diffdash/agent-provider-claude"
import { CliError, CliService, type CliRunner } from "@diffdash/process/cli"
import { AIAgent, type AIProviderAgent } from "./ai-agent"

/** Creates the legacy walkthrough adapter over the Claude SDK provider. */
export const makeClaudeAgent = (cli: CliRunner, model: string): AIProviderAgent => {
  const registration = makeClaudeProvider({
    cli,
    cliStream: { stream: () => Stream.die(new Error("Review streaming is not used")) },
  })
  const walkthrough = registration.walkthrough
  if (walkthrough === undefined) throw new Error("Claude walkthrough capability is not registered")

  return AIAgent.of({
    generateText: Effect.fn("ClaudeAgent.generateText")(function (prompt, options = {}) {
      return walkthrough
        .execute(
          WalkthroughRequest.make({
            prompt,
            model: claudeModelId(model),
            workingDirectory: options.cwd ?? process.cwd(),
            timeoutMs: options.timeoutMs ?? 10 * 60 * 1_000,
            reasoningEffort: options.reasoningEffort ?? "medium",
            policy: CLAUDE_WALKTHROUGH_POLICY,
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

/** Legacy AI agent layer backed by the extracted Claude provider. */
export const ClaudeAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const cli = yield* CliService
      return makeClaudeAgent(cli, CLAUDE_DEFAULT_MODEL)
    }),
  ),
}

const legacyCliError = (stderr: string) =>
  CliError.make({
    command: "claude",
    args: [],
    cwd: null,
    exitCode: null,
    stderr,
    cause: null,
  })
