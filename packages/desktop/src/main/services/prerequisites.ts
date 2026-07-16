import { Context, Effect, Layer, Schema } from "effect"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

import {
  AppPrerequisites,
  type CodingAgentName,
  DiffDashCliInstallResult,
  ProviderDiagnostic,
  SetupRequirement,
} from "@diffdash/protocol/prerequisites"
import { AppConfig } from "./app-config"
import { CliService, type CliRunner } from "@diffdash/process/cli"
import { resolveExecutableInPath } from "@diffdash/process/executable"
import { GitProvider } from "./git-provider"

export { resolveExecutableInPath } from "@diffdash/process/executable"
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
      const gitProvider = yield* GitProvider
      const get = Effect.fn("Prerequisites.get")(function* () {
        refreshAppImageCliLaunchers(config.diffDashCliPath, config.appImagePath)
        const [gitInstalled, providerDescriptors, providerDiagnostics, installedCodingAgents] =
          yield* Effect.all(
            [
              commandAvailable(cli, "git"),
              gitProvider.listProviders,
              gitProvider.diagnoseProviders,
              installedCodingAgentNames(cli),
            ],
            { concurrency: "unbounded" },
          )
        const diffDashCliInPath = resolveExecutableInPath("diffdash", {
          envPath: process.env.PATH ?? "",
        })
        const diffDashCliPath = diffDashCliInPath ?? resolveExecutableInPath("diffdash")

        return AppPrerequisites.make({
          checkedAt: new Date().toISOString(),
          codingAgentInstalled: installedCodingAgents.length > 0,
          diffDashCliInstalled: diffDashCliPath !== null,
          diffDashCliInPath: diffDashCliInPath !== null,
          diffDashCliPath,
          gitInstalled,
          ghAuthenticated: providerDiagnostics[0]?.authenticated ?? false,
          ghInstalled: providerDiagnostics[0]?.available ?? false,
          ghSearchRepositoriesAvailable:
            providerDescriptors[0]?.capabilities.repositorySearch ?? false,
          ghSupported: providerDiagnostics[0]?.available ?? false,
          ghVersion: null,
          installedCodingAgents,
          providerDiagnostics: providerDescriptors.flatMap((descriptor) => {
            const diagnostic = providerDiagnostics.find((item) => item.providerId === descriptor.id)
            return diagnostic === undefined
              ? []
              : [ProviderDiagnostic.make({ descriptor, diagnostic })]
          }),
          setupRequirements: providerDescriptors.map((descriptor) => {
            const diagnostic = providerDiagnostics.find((item) => item.providerId === descriptor.id)
            const ready = diagnostic?.available === true && diagnostic.authenticated
            return SetupRequirement.make({
              key: `provider:${descriptor.id}`,
              providerId: descriptor.id,
              title: `${descriptor.displayName} ready`,
              description: `Connect ${descriptor.displayName} to search ${descriptor.terminology.repositoryPlural} and review ${descriptor.terminology.reviewPlural}.`,
              detail: ready
                ? `${descriptor.displayName} is available and authenticated.`
                : (diagnostic?.message ??
                  `${descriptor.displayName} needs setup or authentication.`),
              ready,
              requiredForLocalUse: false,
              helpUrl: null,
            })
          }),
        })
      })
      const install = Effect.fn("Prerequisites.installDiffDashCli")(function () {
        return installDiffDashCli(config.diffDashCliPath, config.appImagePath)
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

const installedCodingAgentNames = (cli: CliRunner) =>
  Effect.all(
    CODING_AGENT_NAMES.map((agent) =>
      commandAvailable(cli, agent).pipe(Effect.map((installed) => (installed ? agent : null))),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((agents) => agents.filter(isNonNull)))

const APPIMAGE_LAUNCHER_MARKER = "# Generated by the DiffDash AppImage CLI installer."

const installDiffDashCli = (sourcePath: string, appImagePath: string) =>
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

      const linkPath = resolve(targetDirectory, "diffdash")
      const existing = lstatOrNull(linkPath)
      if (existing !== null) {
        if (existing.isSymbolicLink()) {
          const linkedPath = resolve(dirname(linkPath), readlinkSync(linkPath))
          if (appImagePath.length === 0 && linkedPath === sourcePath) {
            return installResult(linkPath, targetDirectory)
          }
          if (isTransientAppImageCliPath(linkedPath)) unlinkSync(linkPath)
          else throw linkExistsError(linkPath)
        } else if (
          appImagePath.length > 0 &&
          existing.isFile() &&
          readFileSync(linkPath, "utf8").includes(APPIMAGE_LAUNCHER_MARKER)
        ) {
          unlinkSync(linkPath)
        } else {
          throw linkExistsError(linkPath)
        }
      }

      if (appImagePath.length > 0) {
        if (!existsSync(appImagePath)) {
          throw PrerequisiteInstallError.make({
            cause: null,
            message: "Could not find the persistent DiffDash AppImage.",
            operation: "installDiffDashCli.appImage",
          })
        }
        const temporaryPath = `${linkPath}.${process.pid}.tmp`
        writeFileSync(
          temporaryPath,
          makeAppImageCliLauncher(readFileSync(sourcePath, "utf8"), appImagePath),
          { encoding: "utf8", mode: 0o755 },
        )
        chmodSync(temporaryPath, 0o755)
        renameSync(temporaryPath, linkPath)
      } else {
        accessSync(sourcePath, constants.X_OK)
        symlinkSync(sourcePath, linkPath)
      }
      return installResult(linkPath, targetDirectory)
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

const installResult = (path: string, targetDirectory: string) =>
  DiffDashCliInstallResult.make({
    path,
    pathSetupCommand: pathContainsDirectory(process.env.PATH ?? "", targetDirectory)
      ? null
      : `export PATH=${shellQuote(targetDirectory)}:$PATH`,
  })

const linkExistsError = (linkPath: string) =>
  PrerequisiteInstallError.make({
    cause: null,
    message: `${linkPath} already exists. Remove it or choose another PATH directory.`,
    operation: "installDiffDashCli.linkExists",
  })

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

const isTransientAppImageCliPath = (path: string) =>
  path.includes("/.mount_") && path.endsWith("/resources/bin/diffdash")

const pathContainsDirectory = (envPath: string, directory: string) =>
  envPath
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => resolve(entry) === resolve(directory))

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/** Creates a persistent CLI launcher from the helper bundled inside an AppImage mount. */
export const makeAppImageCliLauncher = (source: string, appImagePath: string) => {
  const body = source.replace(/^#![^\n]*\n/, "")
  return `#!/bin/sh\n${APPIMAGE_LAUNCHER_MARKER}\nDIFFDASH_APPIMAGE_PATH=${shellQuote(appImagePath)}\nexport DIFFDASH_APPIMAGE_PATH\n${body}`
}

/** Refreshes only marker-owned AppImage launchers after the desktop app updates. */
export const refreshAppImageCliLaunchers = (sourcePath: string, appImagePath: string) => {
  if (appImagePath.length === 0 || !existsSync(sourcePath) || !existsSync(appImagePath)) return

  const candidates = new Set([
    resolveExecutableInPath("diffdash", { envPath: process.env.PATH ?? "" }),
    join(homedir(), ".local", "bin", "diffdash"),
    join(homedir(), "bin", "diffdash"),
  ])
  const source = readFileSync(sourcePath, "utf8")
  const launcher = makeAppImageCliLauncher(source, appImagePath)
  for (const candidate of candidates) {
    if (candidate === null || !existsSync(candidate)) continue
    try {
      const existing = lstatSync(candidate)
      if (!existing.isFile()) continue
      const current = readFileSync(candidate, "utf8")
      if (!current.includes(APPIMAGE_LAUNCHER_MARKER) || current === launcher) continue
      const temporaryPath = `${candidate}.${process.pid}.tmp`
      writeFileSync(temporaryPath, launcher, { encoding: "utf8", mode: 0o755 })
      chmodSync(temporaryPath, 0o755)
      renameSync(temporaryPath, candidate)
    } catch {
      // Diagnostics must remain available when a marker-owned launcher is not writable.
    }
  }
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
