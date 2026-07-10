import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AIProviderModels, AISettings, DEFAULT_AI_SETTINGS } from "../../shared/ai-settings"
import { AIAgent } from "./ai-agent"
import { AppConfig } from "./app-config"
import { AppSettings } from "./app-settings"
import { CliError, CliService, type CliResult } from "./cli"
import { ConfigurableAIAgent } from "./configurable-ai-agent"

const makeCliResult = (command: string, args: readonly string[], stdout: string): CliResult => ({
  args: [...args],
  command,
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout,
})

const makeCliLayer = ({
  empty = () => false,
  fail = () => false,
}: {
  readonly empty?: (command: string, args: readonly string[]) => boolean
  readonly fail?: (command: string, args: readonly string[]) => boolean
} = {}) => {
  const calls: Array<{
    readonly args: readonly string[]
    readonly command: string
    readonly stdin: string | undefined
  }> = []

  const layer = Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args, options) =>
        Effect.sync(() => {
          calls.push({ args: [...args], command, stdin: options?.stdin })
        }).pipe(
          Effect.flatMap(() => {
            if (fail(command, args)) {
              return Effect.fail(
                CliError.make({
                  command,
                  args: [...args],
                  cwd: null,
                  exitCode: 1,
                  stderr: `${command} failed`,
                  cause: null,
                }),
              )
            }

            const stdout = empty(command, args) ? "" : `${command} generated`
            return Effect.succeed(makeCliResult(command, args, stdout))
          }),
        ),
    }),
  )

  return { calls, layer }
}

const makeSettingsLayer = (settings: AISettings) =>
  Layer.succeed(
    AppSettings,
    AppSettings.of({
      get: Effect.succeed(settings),
      save: (nextSettings) => Effect.succeed(nextSettings),
    }),
  )

const makeConfigLayer = () =>
  AppConfig.layer({
    databasePath: join(tmpdir(), "diffdash-test.sqlite"),
    settingsPath: join(tmpdir(), "diffdash-settings.json"),
    tempDir: tmpdir(),
  })

describe("ConfigurableAIAgent", () => {
  it.effect("defaults to auto balance and uses Claude first when available", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeCliLayer()
      const layer = ConfigurableAIAgent.layer.pipe(
        Layer.provide(cliLayer),
        Layer.provide(makeSettingsLayer(DEFAULT_AI_SETTINGS)),
        Layer.provide(makeConfigLayer()),
      )

      const output = yield* Effect.gen(function* () {
        const agent = yield* AIAgent
        return yield* agent.generateText("prompt", { reasoningEffort: "low" })
      }).pipe(Effect.provide(layer))

      expect(output).toBe("claude generated")
      expect(DEFAULT_AI_SETTINGS.provider).toBe("auto")
      expect(DEFAULT_AI_SETTINGS.models.auto).toBe("balance")
      expect(calls.map((call) => call.command)).toEqual(["claude"])
      expect(calls[0]?.args).toContain("claude-sonnet-5")
    }),
  )

  it.effect("falls back from Claude to Codex using the selected auto tier", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeCliLayer({
        fail: (command) => command === "claude",
      })
      const settings = AISettings.make({
        provider: "auto",
        models: AIProviderModels.make({
          ...DEFAULT_AI_SETTINGS.models,
          auto: "fast",
        }),
      })
      const layer = ConfigurableAIAgent.layer.pipe(
        Layer.provide(cliLayer),
        Layer.provide(makeSettingsLayer(settings)),
        Layer.provide(makeConfigLayer()),
      )

      const output = yield* Effect.gen(function* () {
        const agent = yield* AIAgent
        return yield* agent.generateText("prompt", { reasoningEffort: "low" })
      }).pipe(Effect.provide(layer))

      expect(output).toBe("codex generated")
      expect(calls.map((call) => call.command)).toEqual(["claude", "codex"])
      expect(calls[0]?.args).toContain("claude-haiku-4-5")
      expect(calls[1]?.args).toContain("gpt-5.4-mini")
    }),
  )

  it.effect("falls back from OpenCode Anthropic to OpenCode OpenAI for auto", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeCliLayer({
        fail: (command, args) =>
          command === "claude" ||
          command === "codex" ||
          (command === "opencode" && args.includes("anthropic/claude-opus-4-8")),
      })
      const settings = AISettings.make({
        provider: "auto",
        models: AIProviderModels.make({
          ...DEFAULT_AI_SETTINGS.models,
          auto: "best",
        }),
      })
      const layer = ConfigurableAIAgent.layer.pipe(
        Layer.provide(cliLayer),
        Layer.provide(makeSettingsLayer(settings)),
        Layer.provide(makeConfigLayer()),
      )

      const output = yield* Effect.gen(function* () {
        const agent = yield* AIAgent
        return yield* agent.generateText("prompt", { reasoningEffort: "low" })
      }).pipe(Effect.provide(layer))

      expect(output).toBe("opencode generated")
      expect(calls.map((call) => call.command)).toEqual(["claude", "codex", "opencode", "opencode"])
      expect(calls[0]?.args).toContain("claude-opus-4-8")
      expect(calls[1]?.args).toContain("gpt-5.5")
      expect(calls[2]?.args).toContain("anthropic/claude-opus-4-8")
      expect(calls[3]?.args).toContain("openai/gpt-5.5")
    }),
  )

  it.effect("uses only the selected direct provider", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeCliLayer()
      const settings = AISettings.make({
        provider: "claude",
        models: AIProviderModels.make({
          ...DEFAULT_AI_SETTINGS.models,
          claude: "claude-opus-4-8",
        }),
      })
      const layer = ConfigurableAIAgent.layer.pipe(
        Layer.provide(cliLayer),
        Layer.provide(makeSettingsLayer(settings)),
        Layer.provide(makeConfigLayer()),
      )

      const output = yield* Effect.gen(function* () {
        const agent = yield* AIAgent
        return yield* agent.generateText("prompt")
      }).pipe(Effect.provide(layer))

      expect(output).toBe("claude generated")
      expect(calls.map((call) => call.command)).toEqual(["claude"])
      expect(calls[0]?.args).toContain("claude-opus-4-8")
    }),
  )
})
