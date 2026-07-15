import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { DEFAULT_AI_SETTINGS, type CodexModel } from "@diffdash/domain/ai-settings"
import {
  AIAgent,
  type AIAgentGenerateOptions,
  type AIProviderAgent,
  requireGeneratedText,
} from "./ai-agent"
import { AppConfig } from "./app-config"
import { CliError, CliService, type CliResult, type CliRunner } from "./cli"

/** Creates a Codex-backed AI agent using the provided model ID. */
export const makeCodexAgent = (
  cli: CliRunner,
  model: CodexModel,
  tempDir: string,
): AIProviderAgent =>
  AIAgent.of({
    generateText: Effect.fn("CodexAgent.generateText")(function (prompt, options = {}) {
      const configArgs = reasoningConfigArgs(options)
      const skipGitRepoCheckArgs = options.cwd === undefined ? ["--skip-git-repo-check"] : []
      const cliOptions = {
        cwd: options.cwd ?? tempDir,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        stdin: prompt,
      }
      return createCodexOutputPath(tempDir).pipe(
        Effect.flatMap((outputPath) =>
          cli
            .run(
              "codex",
              [
                "exec",
                "--ephemeral",
                ...skipGitRepoCheckArgs,
                "--model",
                model,
                ...configArgs,
                "--output-last-message",
                outputPath,
                "-",
              ],
              cliOptions,
            )
            .pipe(
              Effect.flatMap((result) => readCodexOutput(outputPath, result)),
              Effect.ensuring(removeCodexOutputFile(outputPath)),
            ),
        ),
      )
    }),
    isAvailable: cli.run("codex", ["--version"]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  })

/** AI agent implementation backed by the local `codex` CLI. */
export const CodexAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const cli = yield* CliService
      const config = yield* AppConfig
      return makeCodexAgent(cli, DEFAULT_AI_SETTINGS.models.codex, config.tempDir)
    }),
  ),
}

const reasoningConfigArgs = (options: AIAgentGenerateOptions): readonly string[] =>
  options.reasoningEffort === undefined
    ? []
    : ["-c", `model_reasoning_effort="${options.reasoningEffort}"`]

const createCodexOutputPath = (tempDir: string): Effect.Effect<string, CliError> =>
  Effect.try({
    try: () => {
      mkdirSync(tempDir, { recursive: true })
      return join(tempDir, `codex-output-${randomUUID()}.txt`)
    },
    catch: (cause) =>
      CliError.make({
        command: "codex",
        args: [],
        cwd: null,
        exitCode: null,
        stderr: "Could not create temporary Codex output file.",
        cause,
      }),
  })

const readCodexOutput = (outputPath: string, result: CliResult): Effect.Effect<string, CliError> =>
  Effect.sync(() => {
    try {
      const fileOutput = readFileSync(outputPath, "utf8")
      return fileOutput.trim().length > 0 ? fileOutput : result.stdout
    } catch {
      return result.stdout
    }
  }).pipe(Effect.flatMap((output) => requireGeneratedText(result, "Codex", output)))

const removeCodexOutputFile = (path: string): Effect.Effect<void> =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
