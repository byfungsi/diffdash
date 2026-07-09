import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AppConfig } from "./app-config"
import { CliError, CliService, type CliResult } from "./cli"
import { Prerequisites, resolveExecutableInPath } from "./prerequisites"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-prerequisites-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const withPath = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.PATH
      process.env.PATH = path
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.PATH
        } else {
          process.env.PATH = previous
        }
      }),
  )

const makeLayer = (
  directory: string,
  options: {
    readonly availableCommands: ReadonlySet<string>
    readonly diffDashCliPath?: string
    readonly ghAuthenticated?: boolean
  },
) =>
  Prerequisites.layer.pipe(
    Layer.provideMerge(fakeCliLayer(options.availableCommands, options.ghAuthenticated ?? true)),
    Layer.provide(
      AppConfig.layer({
        databasePath: join(directory, "test.sqlite"),
        ...(options.diffDashCliPath === undefined
          ? {}
          : { diffDashCliPath: options.diffDashCliPath }),
        settingsPath: join(directory, "settings.json"),
        tempDir: directory,
      }),
    ),
  )

describe("Prerequisites", () => {
  it.scoped("detects GitHub auth, coding agents, and diffdash in PATH", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fakeBin = join(directory, "bin")
      const diffDashPath = join(fakeBin, "diffdash")
      yield* Effect.sync(() => {
        mkdirSync(fakeBin, { recursive: true })
        writeFileSync(diffDashPath, "#!/bin/sh\n", "utf8")
        chmodSync(diffDashPath, 0o755)
      })
      yield* withPath(fakeBin)

      const status = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.get
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(["gh", "claude"]),
          }),
        ),
      )

      expect(status.ghInstalled).toBe(true)
      expect(status.ghAuthenticated).toBe(true)
      expect(status.codingAgentInstalled).toBe(true)
      expect(status.installedCodingAgents).toEqual(["claude"])
      expect(status.diffDashCliInstalled).toBe(true)
      expect(status.diffDashCliPath).toBe(diffDashPath)
    }),
  )

  it.scoped("installs the bundled diffdash CLI into the first writable PATH directory", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fakeBin = join(directory, "bin")
      const sourcePath = join(directory, "source-diffdash")
      yield* Effect.sync(() => {
        writeFileSync(sourcePath, "#!/bin/sh\n", "utf8")
        chmodSync(sourcePath, 0o755)
      })
      yield* withPath(fakeBin)

      const result = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.installDiffDashCli
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(),
            diffDashCliPath: sourcePath,
          }),
        ),
      )

      expect(result.path).toBe(join(fakeBin, "diffdash"))
      expect(readlinkSync(result.path)).toBe(sourcePath)
    }),
  )

  it.scoped("resolves an executable in a supplied PATH", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const executablePath = join(directory, "diffdash")
      yield* Effect.sync(() => {
        writeFileSync(executablePath, "#!/bin/sh\n", "utf8")
        chmodSync(executablePath, 0o755)
      })

      expect(resolveExecutableInPath("diffdash", { envPath: directory })).toBe(executablePath)
    }),
  )
})

const fakeCliLayer = (availableCommands: ReadonlySet<string>, ghAuthenticated: boolean) =>
  Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return availableCommands.has("gh") && ghAuthenticated
            ? Effect.succeed(cliResult(command, args))
            : Effect.fail(cliError(command, args))
        }

        return availableCommands.has(command)
          ? Effect.succeed(cliResult(command, args))
          : Effect.fail(cliError(command, args))
      },
    }),
  )

const cliResult = (command: string, args: readonly string[]): CliResult => ({
  args,
  command,
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout: `${command} ok`,
})

const cliError = (command: string, args: readonly string[]) =>
  CliError.make({
    args: [...args],
    cause: null,
    command,
    cwd: null,
    exitCode: 1,
    stderr: `${command} missing`,
    stdout: "",
  })
