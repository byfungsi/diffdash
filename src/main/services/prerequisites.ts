import { Context, Effect, Layer, Schema } from "effect"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs"
import { delimiter, dirname, extname, join, resolve } from "node:path"

import {
  AppPrerequisites,
  type CodingAgentName,
  DiffDashCliInstallResult,
} from "../../shared/prerequisites"
import { AppConfig } from "./app-config"
import { CliService, defaultExecutablePath, type CliRunner } from "./cli"

/** A typed failure from installing the DiffDash CLI into PATH. */
export class PrerequisiteInstallError extends Schema.TaggedError<PrerequisiteInstallError>()(
  "PrerequisiteInstallError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.NullOr(Schema.Defect),
  },
) {}

/** Main-process service for setup prerequisite checks and install actions. */
export class Prerequisites extends Context.Tag("@diffdash/Prerequisites")<
  Prerequisites,
  {
    readonly get: Effect.Effect<AppPrerequisites>
    readonly installDiffDashCli: Effect.Effect<DiffDashCliInstallResult, PrerequisiteInstallError>
  }
>() {
  static readonly layer = Layer.effect(
    Prerequisites,
    Effect.gen(function* () {
      const cli = yield* CliService
      const config = yield* AppConfig
      const get = Effect.fn("Prerequisites.get")(function* () {
        const [ghInstalled, ghAuthenticated, installedCodingAgents] = yield* Effect.all(
          [commandAvailable(cli, "gh"), ghAuthenticatedCheck(cli), installedCodingAgentNames(cli)],
          { concurrency: "unbounded" },
        )
        const diffDashCliPath = resolveExecutableInPath("diffdash")

        return AppPrerequisites.make({
          checkedAt: new Date().toISOString(),
          codingAgentInstalled: installedCodingAgents.length > 0,
          diffDashCliInstalled: diffDashCliPath !== null,
          diffDashCliPath,
          ghAuthenticated,
          ghInstalled,
          installedCodingAgents,
        })
      })
      const install = Effect.fn("Prerequisites.installDiffDashCli")(function () {
        return installDiffDashCli(config.diffDashCliPath)
      })

      return Prerequisites.of({
        get: get(),
        installDiffDashCli: install(),
      })
    }),
  )
}

const CODING_AGENT_NAMES: readonly CodingAgentName[] = ["codex", "claude", "opencode"]

const commandAvailable = (cli: CliRunner, command: string) =>
  cli.run(command, ["--version"], { timeoutMs: 5_000 }).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const ghAuthenticatedCheck = (cli: CliRunner) =>
  cli.run("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs: 10_000 }).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const installedCodingAgentNames = (cli: CliRunner) =>
  Effect.all(
    CODING_AGENT_NAMES.map((agent) =>
      commandAvailable(cli, agent).pipe(Effect.map((installed) => (installed ? agent : null))),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((agents) => agents.filter(isNonNull)))

const installDiffDashCli = (sourcePath: string) =>
  Effect.try({
    try: () => {
      if (sourcePath.length === 0 || !existsSync(sourcePath)) {
        throw PrerequisiteInstallError.make({
          cause: null,
          message: "Could not find the bundled DiffDash CLI.",
          operation: "installDiffDashCli.source",
        })
      }

      const targetDirectory = firstWritablePathDirectory()
      if (targetDirectory === null) {
        throw PrerequisiteInstallError.make({
          cause: null,
          message: "Could not find or create a writable directory for the DiffDash CLI.",
          operation: "installDiffDashCli.targetDirectory",
        })
      }

      mkdirSync(targetDirectory, { recursive: true })
      chmodSync(sourcePath, 0o755)

      const linkPath = resolve(targetDirectory, "diffdash")
      if (existsSync(linkPath)) {
        const existing = lstatSync(linkPath)
        if (existing.isSymbolicLink()) {
          const linkedPath = resolve(dirname(linkPath), readlinkSync(linkPath))
          if (linkedPath === sourcePath) return DiffDashCliInstallResult.make({ path: linkPath })
        }

        throw PrerequisiteInstallError.make({
          cause: null,
          message: `${linkPath} already exists. Remove it or choose another PATH directory.`,
          operation: "installDiffDashCli.linkExists",
        })
      }

      symlinkSync(sourcePath, linkPath)
      return DiffDashCliInstallResult.make({ path: linkPath })
    },
    catch: (cause) => {
      if (cause instanceof PrerequisiteInstallError) return cause
      return PrerequisiteInstallError.make({
        cause,
        message: "Could not install the DiffDash CLI into PATH.",
        operation: "installDiffDashCli",
      })
    },
  })

/** Returns the absolute path to an executable in PATH, or null if it cannot be found. */
export const resolveExecutableInPath = (
  command: string,
  options: {
    readonly envPath?: string
    readonly pathExt?: string
    readonly platform?: NodeJS.Platform
  } = {},
) => {
  const envPath = options.envPath ?? defaultExecutablePath(process.env.PATH ?? "")
  const platform = options.platform ?? process.platform
  const extensions = executableExtensions(command, platform, options.pathExt ?? process.env.PATHEXT)

  for (const directory of envPath.split(delimiter).filter((entry) => entry.length > 0)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`)
      if (canExecuteFile(candidate)) return candidate
    }
  }

  return null
}

const firstWritablePathDirectory = () => {
  const pathDirectories = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
  const home = process.env.HOME ?? ""
  const preferredDirectories = [
    home.length > 0 ? join(home, ".local", "bin") : "",
    home.length > 0 ? join(home, "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const candidates = uniqueDirectories([...pathDirectories, ...preferredDirectories])

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate)
    if (canWriteDirectory(resolvedCandidate)) return resolvedCandidate
  }

  return null
}

const uniqueDirectories = (directories: readonly string[]) => {
  const seen = new Set<string>()
  return directories.filter((directory) => {
    if (directory.length === 0) return false
    const resolved = resolve(directory)
    if (seen.has(resolved)) return false
    seen.add(resolved)
    return true
  })
}

const executableExtensions = (
  command: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
) => {
  if (platform !== "win32" || extname(command).length > 0) return [""]

  const extensions = (pathExt ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((extension) => extension.length > 0)
  return ["", ...extensions]
}

const canExecuteFile = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const canWriteDirectory = (directory: string) => {
  try {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true })
    }
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const isNonNull = <A>(value: A | null): value is A => value !== null
