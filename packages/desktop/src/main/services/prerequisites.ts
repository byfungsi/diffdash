import { Context, Effect, Layer, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  DiffDashCliInstallResult,
  ProviderDiagnostic,
  SetupRequirement,
} from "@diffdash/protocol/prerequisites"
import type { AgentProviderStatus } from "@diffdash/protocol/agent-providers"
import { type ProcessRunner, ProcessService, processRequest } from "@diffdash/process"
import { findExecutableInPath } from "@diffdash/process/executable"
import { AppConfig } from "./app-config"
import { AgentProviders } from "./agent-providers"
import { GitProvider } from "./git-provider"

export { findExecutableInPath } from "@diffdash/process/executable"
/** A typed failure from installing the DiffDash CLI into PATH. */
class PrerequisiteInstallError extends Schema.TaggedError<PrerequisiteInstallError>()(
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
      const processes = yield* ProcessService
      const config = yield* AppConfig
      const gitProvider = yield* GitProvider
      const agentProviders = yield* AgentProviders
      const get = Effect.fn("Prerequisites.get")(function* () {
        yield* refreshAppImageCliLaunchers(config.diffDashCliPath, config.appImagePath)
        const [gitInstalled, providerDescriptors, providerDiagnostics, agentCatalog] =
          yield* Effect.all(
            [
              commandAvailable(processes, "git"),
              gitProvider.listProviders,
              gitProvider.diagnoseProviders,
              agentProviders.catalog,
            ],
            { concurrency: "unbounded" },
          )
        const installedCodingAgents = agentCatalog.providers
          .filter((provider) => provider.capabilities.some(({ status }) => status === "ready"))
          .map(({ id }) => id)
        const diffDashCliInPath = yield* findExecutableInPath("diffdash", {
          envPath: process.env.PATH ?? "",
        })
        const diffDashCli = Option.isSome(diffDashCliInPath)
          ? diffDashCliInPath
          : yield* findExecutableInPath("diffdash")

        return AppPrerequisites.make({
          checkedAt: new Date().toISOString(),
          codingAgentInstalled: installedCodingAgents.length > 0,
          diffDashCliInstalled: Option.isSome(diffDashCli),
          diffDashCliInPath: Option.isSome(diffDashCliInPath),
          diffDashCliPath: Option.getOrNull(diffDashCli),
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
          setupRequirements: [
            ...providerDescriptors.map((descriptor) => {
              const diagnostic = providerDiagnostics.find(
                (item) => item.providerId === descriptor.id,
              )
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
            ...agentCatalog.providers.map(agentSetupRequirement),
          ],
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

const commandAvailable = (processes: ProcessRunner, command: string) =>
  processes.run(processRequest(command, ["--version"], { timeoutMs: 5_000 })).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const agentSetupRequirement = (provider: AgentProviderStatus) => {
  const supported = provider.capabilities.filter(({ status }) => status !== "unsupported")
  const ready = supported.length > 0 && supported.every(({ status }) => status === "ready")
  const unavailable = supported.find(({ status }) => status !== "ready")
  const setupHint = provider.setup.find(
    (requirement) => requirement.installHint !== null,
  )?.installHint
  return SetupRequirement.make({
    key: `agent-provider:${provider.id}`,
    providerId: provider.id,
    title: `${provider.displayName} ready`,
    description: provider.description,
    detail: ready
      ? `${provider.displayName} is available.`
      : (unavailable?.reason ?? setupHint ?? `${provider.displayName} needs setup.`),
    ready,
    requiredForLocalUse: false,
    helpUrl: provider.homepage,
  })
}

const APPIMAGE_LAUNCHER_MARKER = "# Generated by the DiffDash AppImage CLI installer."

/** Replaces an executable through a private, exclusive, same-directory temporary file. */
export const replaceExecutableAtomically = (targetPath: string, content: string) => {
  const temporaryPath = join(dirname(targetPath), `.${randomUUID()}.${process.pid}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    writeFileSync(descriptor, content, { encoding: "utf8" })
    fchmodSync(descriptor, 0o755)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, targetPath)
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Continue cleanup after a failed close.
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The rename removed the temporary path, or cleanup is already best effort.
    }
  }
}

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
          if (isTransientAppImageCliPath(linkedPath)) {
            if (appImagePath.length === 0) unlinkSync(linkPath)
          } else throw linkExistsError(linkPath)
        } else if (
          appImagePath.length > 0 &&
          existing.isFile() &&
          readFileSync(linkPath, "utf8").includes(APPIMAGE_LAUNCHER_MARKER)
        ) {
          // Marker-owned launchers are replaced atomically below.
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
        replaceExecutableAtomically(
          linkPath,
          makeAppImageCliLauncher(readFileSync(sourcePath, "utf8"), appImagePath),
        )
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
const makeAppImageCliLauncher = (source: string, appImagePath: string) => {
  const body = source.replace(/^#![^\n]*\n/, "")
  return `#!/bin/sh\n${APPIMAGE_LAUNCHER_MARKER}\nDIFFDASH_APPIMAGE_PATH=${shellQuote(appImagePath)}\nexport DIFFDASH_APPIMAGE_PATH\n${body}`
}

/** Refreshes only marker-owned AppImage launchers after the desktop app updates. */
export const refreshAppImageCliLaunchers = Effect.fn("refreshAppImageCliLaunchers")(function* (
  sourcePath: string,
  appImagePath: string,
) {
  if (appImagePath.length === 0 || !existsSync(sourcePath) || !existsSync(appImagePath)) return

  const diffDashInPath = yield* findExecutableInPath("diffdash", {
    envPath: process.env.PATH ?? "",
  })
  yield* Effect.sync(() => {
    const candidates = new Set([
      Option.getOrNull(diffDashInPath),
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
        replaceExecutableAtomically(candidate, launcher)
      } catch {
        // Diagnostics must remain available when a marker-owned launcher is not writable.
      }
    }
  })
})

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
