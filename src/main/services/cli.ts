import { Context, Effect, Layer, Schema } from "effect"
import { spawn } from "node:child_process"

/** A typed failure from spawning or running a local CLI dependency. */
export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.String,
  cause: Schema.NullOr(Schema.Defect),
}) {}

/** Captured output from a completed CLI command. */
export interface CliResult {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | null
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Options controlling how a CLI command is spawned. */
export interface CliRunOptions {
  readonly cwd?: string
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly env?: Record<string, string>
}

/** Shared shape for services capable of running local CLI commands. */
export interface CliRunner {
  readonly run: (
    command: string,
    args: readonly string[],
    options?: CliRunOptions,
  ) => Effect.Effect<CliResult, CliError>
}

/** Main-process service for invoking whitelisted local CLI commands. */
export class CliService extends Context.Tag("@diffdash/CliService")<CliService, CliRunner>() {
  static readonly layer = Layer.succeed(
    CliService,
    CliService.of({
      run: Effect.fn("CliService.run")(function (command, args, options = {}) {
        return Effect.async<CliResult, CliError>((resume) => {
          const child = spawn(command, [...args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            shell: false,
          })

          let stdout = ""
          let stderr = ""
          let settled = false

          const timeout =
            options.timeoutMs === undefined
              ? undefined
              : setTimeout(() => {
                  if (settled) return
                  settled = true
                  child.kill("SIGTERM")
                  resume(
                    CliError.make({
                      command,
                      args: [...args],
                      cwd: options.cwd ?? null,
                      exitCode: null,
                      stdout,
                      stderr: `Command timed out after ${options.timeoutMs}ms`,
                      cause: null,
                    }),
                  )
                }, options.timeoutMs)

          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8")
          })

          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8")
          })

          child.on("error", (cause) => {
            if (settled) return
            settled = true
            if (timeout) clearTimeout(timeout)
            resume(
              CliError.make({
                command,
                args: [...args],
                cwd: options.cwd ?? null,
                exitCode: null,
                stdout,
                stderr,
                cause,
              }),
            )
          })

          child.on("close", (code) => {
            if (settled) return
            settled = true
            if (timeout) clearTimeout(timeout)
            const exitCode = code ?? 0
            const result: CliResult = {
              command,
              args,
              cwd: options.cwd ?? null,
              stdout,
              stderr,
              exitCode,
            }
            resume(
              exitCode === 0
                ? Effect.succeed(result)
                : CliError.make({
                    command,
                    args: [...args],
                    cwd: options.cwd ?? null,
                    exitCode,
                    stdout,
                    stderr,
                    cause: null,
                  }),
            )
          })

          if (options.stdin !== undefined) {
            child.stdin.write(options.stdin)
          }
          child.stdin.end()

          return Effect.sync(() => {
            if (timeout) clearTimeout(timeout)
            if (!child.killed) child.kill("SIGTERM")
          })
        })
      }),
    }),
  )
}
