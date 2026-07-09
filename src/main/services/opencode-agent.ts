import { Effect, Layer } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { DEFAULT_AI_SETTINGS, type OpenCodeModel } from "../../shared/ai-settings"
import {
  AIAgent,
  type AIAgentGenerateOptions,
  type AIProviderAgent,
  requireGeneratedText,
} from "./ai-agent"
import { AppConfig } from "./app-config"
import { CliError, CliService, type CliRunner } from "./cli"

const OPENCODE_PROMPT_MESSAGE =
  "Generate a DiffDash walkthrough from the attached prompt file. Return JSON only."

/** Creates an OpenCode-backed AI agent using the provided provider/model ID. */
export const makeOpenCodeAgent = (
  cli: CliRunner,
  model: OpenCodeModel,
  tempDir: string,
): AIProviderAgent =>
  AIAgent.of({
    generateText: Effect.fn("OpenCodeAgent.generateText")(function (prompt, options = {}) {
      return writePromptFile(tempDir, prompt).pipe(
        Effect.flatMap((promptPath) =>
          cli
            .run(
              "opencode",
              [
                "run",
                "--model",
                model,
                "--file",
                promptPath,
                ...variantArgs(options),
                OPENCODE_PROMPT_MESSAGE,
              ],
              options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
            )
            .pipe(
              Effect.flatMap((result) => requireGeneratedText(result, "OpenCode", result.stdout)),
              Effect.ensuring(removePromptFile(promptPath)),
            ),
        ),
      )
    }),
    isAvailable: cli.run("opencode", ["--version"]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  })

/** AI agent implementation backed by the local `opencode` CLI. */
export const OpenCodeAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const cli = yield* CliService
      const config = yield* AppConfig
      return makeOpenCodeAgent(cli, DEFAULT_AI_SETTINGS.models.opencode, config.tempDir)
    }),
  ),
}

const variantArgs = (options: AIAgentGenerateOptions): readonly string[] => {
  if (options.reasoningEffort === undefined) return []
  const variant = options.reasoningEffort === "low" ? "minimal" : options.reasoningEffort
  return ["--variant", variant]
}

const writePromptFile = (tempDir: string, prompt: string): Effect.Effect<string, CliError> =>
  Effect.try({
    try: () => {
      mkdirSync(tempDir, { recursive: true })
      const promptPath = join(tempDir, `opencode-prompt-${randomUUID()}.txt`)
      writeFileSync(promptPath, prompt, "utf8")
      return promptPath
    },
    catch: (cause) =>
      CliError.make({
        command: "opencode",
        args: [],
        cwd: null,
        exitCode: null,
        stderr: "Could not write temporary OpenCode prompt file.",
        cause,
      }),
  })

const removePromptFile = (path: string): Effect.Effect<void> =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
