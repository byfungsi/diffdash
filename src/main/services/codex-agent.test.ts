import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AIAgent } from "./ai-agent"
import { AppConfig } from "./app-config"
import { CliService, type CliResult } from "./cli"
import { CodexAgent } from "./codex-agent"

const makeCliLayer = () => {
  const calls: Array<{
    readonly args: readonly string[]
    readonly command: string
    readonly stdin: string | undefined
    readonly timeoutMs: number | undefined
  }> = []

  const layer = Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args, options) =>
        Effect.sync(() => {
          const outputIndex = args.indexOf("--output-last-message")
          const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined
          if (outputPath !== undefined) writeFileSync(outputPath, "generated", "utf8")
          calls.push({
            args: [...args],
            command,
            stdin: options?.stdin,
            timeoutMs: options?.timeoutMs,
          })
          return {
            args: [...args],
            command,
            cwd: options?.cwd ?? null,
            exitCode: 0,
            stderr: "",
            stdout: args[0] === "--version" ? "codex 0.1.0" : "",
          } satisfies CliResult
        }),
    }),
  )

  return { calls, layer }
}

describe("CodexAgent", () => {
  it.effect("passes reasoning effort and timeout options to codex exec", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeCliLayer()
      const layer = CodexAgent.layer.pipe(
        Layer.provide(cliLayer),
        Layer.provide(
          AppConfig.layer({
            databasePath: join(tmpdir(), "diffdash-test.sqlite"),
            settingsPath: join(tmpdir(), "diffdash-settings.json"),
            tempDir: tmpdir(),
          }),
        ),
      )

      const output = yield* Effect.gen(function* () {
        const agent = yield* AIAgent
        return yield* agent.generateText("prompt", { reasoningEffort: "low", timeoutMs: 123 })
      }).pipe(Effect.provide(layer))

      expect(output).toBe("generated")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe("codex")
      expect(calls[0]?.args).toEqual([
        "exec",
        "--model",
        "gpt-5.3-codex-spark",
        "-c",
        'model_reasoning_effort="low"',
        "--output-last-message",
        expect.stringContaining("codex-output-"),
        "-",
      ])
      expect(calls[0]?.stdin).toBe("prompt")
      expect(calls[0]?.timeoutMs).toBe(123)
    }),
  )
})
