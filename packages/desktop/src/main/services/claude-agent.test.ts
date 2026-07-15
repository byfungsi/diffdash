import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { AIAgent } from "./ai-agent"
import { ClaudeAgent } from "./claude-agent"
import { CliService, type CliResult } from "@diffdash/process/cli"

const makeCliLayer = () => {
  const calls: Array<{
    readonly args: readonly string[]
    readonly command: string
    readonly cwd: string | null
    readonly stdin: string | undefined
    readonly timeoutMs: number | undefined
  }> = []

  const layer = Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args, options) =>
        Effect.sync(() => {
          calls.push({
            args: [...args],
            command,
            cwd: options?.cwd ?? null,
            stdin: options?.stdin,
            timeoutMs: options?.timeoutMs,
          })
          return {
            args: [...args],
            command,
            cwd: options?.cwd ?? null,
            exitCode: 0,
            stderr: "",
            stdout: args[0] === "--version" ? "2.1.205 (Claude Code)" : "generated",
          } satisfies CliResult
        }),
    }),
  )

  return { calls, layer }
}

describe("ClaudeAgent", () => {
  it.effect("passes model, effort, cwd, timeout, and prompt to claude print mode", () =>
    Effect.gen(function* () {
      const { calls, layer: cliLayer } = makeCliLayer()
      const layer = ClaudeAgent.layer.pipe(Layer.provide(cliLayer))

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
      expect(calls[0]?.command).toBe("claude")
      expect(calls[0]?.args).toEqual([
        "--print",
        "--input-format",
        "text",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--model",
        "claude-sonnet-5",
        "--effort",
        "low",
      ])
      expect(calls[0]?.cwd).toBe("/workspace/repo")
      expect(calls[0]?.stdin).toBe("prompt")
      expect(calls[0]?.timeoutMs).toBe(123)
    }),
  )
})
