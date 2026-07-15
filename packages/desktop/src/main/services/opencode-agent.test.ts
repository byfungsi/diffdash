import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AIAgent } from "./ai-agent"
import { AppConfig } from "./app-config"
import { CliService, type CliResult } from "@diffdash/process/cli"
import { OpenCodeAgent } from "./opencode-agent"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-opencode-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeCliLayer = () => {
  const calls: Array<{
    readonly args: readonly string[]
    readonly command: string
    readonly cwd: string | null
    readonly prompt: string | null
    readonly promptPath: string | null
    readonly timeoutMs: number | undefined
  }> = []

  const layer = Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args, options) =>
        Effect.sync(() => {
          const fileIndex = args.indexOf("--file")
          const promptPath = fileIndex >= 0 ? (args[fileIndex + 1] ?? null) : null
          calls.push({
            args: [...args],
            command,
            cwd: options?.cwd ?? null,
            prompt: promptPath === null ? null : readFileSync(promptPath, "utf8"),
            promptPath,
            timeoutMs: options?.timeoutMs,
          })
          return {
            args: [...args],
            command,
            cwd: options?.cwd ?? null,
            exitCode: 0,
            stderr: "",
            stdout: args[0] === "--version" ? "opencode 1.17.15" : "generated",
          } satisfies CliResult
        }),
    }),
  )

  return { calls, layer }
}

describe("OpenCodeAgent", () => {
  it.scoped("passes model, variant, cwd, timeout, and prompt attachment to opencode run", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const { calls, layer: cliLayer } = makeCliLayer()
      const layer = OpenCodeAgent.layer.pipe(
        Layer.provide(cliLayer),
        Layer.provide(
          AppConfig.layer({
            databasePath: join(directory, "test.sqlite"),
            settingsPath: join(directory, "settings.json"),
            tempDir: directory,
          }),
        ),
      )

      const output = yield* Effect.gen(function* () {
        const agent = yield* AIAgent
        return yield* agent.generateText("prompt", {
          cwd: "/workspace/repo",
          reasoningEffort: "low",
          timeoutMs: 123,
        })
      }).pipe(Effect.provide(layer))

      expect(output).toBe("generated")
      expect(calls).toHaveLength(1)
      const promptPath = calls[0]?.promptPath
      expect(calls[0]?.command).toBe("opencode")
      expect(calls[0]?.args).toEqual([
        "run",
        "--model",
        "openai/gpt-5.3-codex-spark",
        "--file",
        promptPath,
        "--variant",
        "minimal",
        "Generate a DiffDash walkthrough from the attached prompt file. Return JSON only.",
      ])
      expect(calls[0]?.args).not.toContain("prompt")
      expect(calls[0]?.cwd).toBe("/workspace/repo")
      expect(calls[0]?.prompt).toBe("prompt")
      expect(promptPath).not.toBeNull()
      if (promptPath !== null && promptPath !== undefined) {
        expect(existsSync(promptPath)).toBe(false)
      }
      expect(calls[0]?.timeoutMs).toBe(123)
    }),
  )
})
