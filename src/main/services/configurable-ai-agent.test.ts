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

const makeCliLayer = () => {
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
            if (command === "codex" && args[0] === "exec") {
              return Effect.fail(
                CliError.make({
                  command,
                  args: [...args],
                  cwd: null,
                  exitCode: 1,
                  stderr: "codex failed",
                  cause: null,
                }),
              )
            }

            return Effect.succeed(makeCliResult(command, args, `${command} generated`))
          }),
        ),
    }),
  )

  return { calls, layer }
}

const makeEmptyCodexCliLayer = () => {
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
          const stdout = command === "codex" && args[0] === "exec" ? "" : `${command} generated`
          return makeCliResult(command, args, stdout)
        }),
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
  it.effect("uses Codex, Claude, then OpenCode fallback order for auto", () =>
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
      expect(calls.map((call) => call.command)).toEqual(["codex", "claude"])
      expect(calls[0]?.args).toContain("gpt-5.3-codex-spark")
      expect(calls[1]?.args).toContain("claude-sonnet-5")
    }),
  )

  it.effect("falls back when Codex exits successfully without generated text", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeEmptyCodexCliLayer()
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
      expect(calls.map((call) => call.command)).toEqual(["codex", "claude"])
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
