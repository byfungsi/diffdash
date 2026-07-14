import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AppConfig } from "./app-config"
import { CliError, CliService, type CliResult } from "./cli"
import { parseGitHubCliVersion, Prerequisites, resolveExecutableInPath } from "./prerequisites"

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

const withHome = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.HOME
      process.env.HOME = path
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = previous
        }
      }),
  )

const makeLayer = (
  directory: string,
  options: {
    readonly availableCommands: ReadonlySet<string>
    readonly diffDashCliPath?: string
    readonly ghAuthenticated?: boolean
    readonly ghSearchRepositoriesAvailable?: boolean
    readonly ghVersion?: string
  },
) =>
  Prerequisites.layer.pipe(
    Layer.provideMerge(fakeCliLayer(options)),
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
  it.scoped("detects Git, GitHub auth, coding agents, and diffdash in PATH", () =>
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
            availableCommands: new Set(["git", "gh", "claude"]),
          }),
        ),
      )

      expect(status.gitInstalled).toBe(true)
      expect(status.ghInstalled).toBe(true)
      expect(status.ghVersion).toBe("2.76.1")
      expect(status.ghSearchRepositoriesAvailable).toBe(true)
      expect(status.ghSupported).toBe(true)
      expect(status.ghAuthenticated).toBe(true)
      expect(status.codingAgentInstalled).toBe(true)
      expect(status.installedCodingAgents).toEqual(["claude"])
      expect(status.diffDashCliInstalled).toBe(true)
      expect(status.diffDashCliPath).toBe(diffDashPath)
    }),
  )

  it.scoped("marks GitHub CLI versions below 2.7.0 as unsupported", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const status = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.get
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(["gh"]),
            ghVersion: "1.14.0",
          }),
        ),
      )

      expect(status.ghInstalled).toBe(true)
      expect(status.ghVersion).toBe("1.14.0")
      expect(status.ghSearchRepositoriesAvailable).toBe(true)
      expect(status.ghSupported).toBe(false)
    }),
  )

  it.scoped("requires the gh search repos capability even when auth succeeds", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const status = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.get
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(["gh"]),
            ghSearchRepositoriesAvailable: false,
          }),
        ),
      )

      expect(status.ghAuthenticated).toBe(true)
      expect(status.ghVersion).toBe("2.76.1")
      expect(status.ghSearchRepositoriesAvailable).toBe(false)
      expect(status.ghSupported).toBe(false)
    }),
  )

  it("parses standard and v-prefixed GitHub CLI versions", () => {
    expect(parseGitHubCliVersion("gh version 2.7.0 (2022-02-10)")).toBe("2.7.0")
    expect(parseGitHubCliVersion("gh version v2.76.1\nhttps://github.com/cli/cli")).toBe("2.76.1")
    expect(parseGitHubCliVersion("gh development build")).toBeNull()
  })

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

  it.scoped("falls back to a user-local bin directory when PATH has no writable directory", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const home = join(directory, "home")
      const sourcePath = join(directory, "source-diffdash")
      yield* Effect.sync(() => {
        mkdirSync(home, { recursive: true })
        writeFileSync(sourcePath, "#!/bin/sh\n", "utf8")
        chmodSync(sourcePath, 0o755)
      })
      yield* withPath("")
      yield* withHome(home)

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

      expect(result.path).toBe(join(home, ".local", "bin", "diffdash"))
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

const fakeCliLayer = (options: {
  readonly availableCommands: ReadonlySet<string>
  readonly ghAuthenticated?: boolean
  readonly ghSearchRepositoriesAvailable?: boolean
  readonly ghVersion?: string
}) =>
  Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return options.availableCommands.has("gh") && (options.ghAuthenticated ?? true)
            ? Effect.succeed(cliResult(command, args))
            : Effect.fail(cliError(command, args))
        }

        if (command === "gh" && args[0] === "--version") {
          return options.availableCommands.has("gh")
            ? Effect.succeed(
                cliResult(command, args, `gh version ${options.ghVersion ?? "2.76.1"}`),
              )
            : Effect.fail(cliError(command, args))
        }

        if (command === "gh" && args[0] === "search") {
          return options.availableCommands.has("gh") &&
            (options.ghSearchRepositoriesAvailable ?? true)
            ? Effect.succeed(cliResult(command, args))
            : Effect.fail(cliError(command, args))
        }

        return options.availableCommands.has(command)
          ? Effect.succeed(cliResult(command, args))
          : Effect.fail(cliError(command, args))
      },
    }),
  )

const cliResult = (
  command: string,
  args: readonly string[],
  stdout = `${command} ok`,
): CliResult => ({
  args,
  command,
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout,
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
