import { Effect, Layer } from "effect"

import { DEFAULT_AI_SETTINGS, type ClaudeModel } from "../../shared/ai-settings"
import {
  AIAgent,
  type AIAgentGenerateOptions,
  type AIProviderAgent,
  requireGeneratedText,
} from "./ai-agent"
import { CliService, type CliRunner } from "./cli"

/** Creates a Claude-backed AI agent using the provided model ID. */
export const makeClaudeAgent = (cli: CliRunner, model: ClaudeModel): AIProviderAgent =>
  AIAgent.of({
    generateText: Effect.fn("ClaudeAgent.generateText")(function (prompt, options = {}) {
      const effortArgs = reasoningEffortArgs(options)
      const cliOptions = {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        stdin: prompt,
      }
      return cli
        .run(
          "claude",
          [
            "--print",
            "--input-format",
            "text",
            "--output-format",
            "text",
            "--no-session-persistence",
            "--model",
            model,
            ...effortArgs,
          ],
          cliOptions,
        )
        .pipe(Effect.flatMap((result) => requireGeneratedText(result, "Claude", result.stdout)))
    }),
    isAvailable: cli.run("claude", ["--version"]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  })

/** AI agent implementation backed by the local `claude` CLI. */
export const ClaudeAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const cli = yield* CliService
      return makeClaudeAgent(cli, DEFAULT_AI_SETTINGS.models.claude)
    }),
  ),
}

const reasoningEffortArgs = (options: AIAgentGenerateOptions): readonly string[] => {
  if (options.reasoningEffort === undefined) return []
  const effort = options.reasoningEffort === "minimal" ? "low" : options.reasoningEffort
  return ["--effort", effort]
}
