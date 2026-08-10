import { Context, Effect, Layer, Option, Schema } from "effect"
import { delimiter, dirname, join, resolve } from "node:path"

import {
  AppPrerequisites,
  CodingAgentName,
  DiffDashCliInstallResult,
  ProviderDiagnostic,
  SetupRequirement,
  SetupRequirementKey,
} from "@diffdash/protocol/prerequisites"
import {
  AgentProviderCapabilityStatus,
  type AgentProviderStatus,
} from "@diffdash/protocol/agent-providers"
import { type ProcessRunner, ProcessService, processRequest } from "@diffdash/process"
import { ExecutablePath, findExecutableInPath } from "@diffdash/process/executable"
import { ProcessFileSystem, type ProcessFileSystemOperations } from "@diffdash/process/file-system"
import { WebUrl } from "@diffdash/domain/web-url"
import type {
  CoreAbsolutePath,
  ExecutablePathExtensions,
  ExecutableSearchPath,
} from "../core-configuration"
import { AgentProviders } from "./agent-providers"
import { GitProvider } from "./git-provider"
import { CoreExpectedCause } from "../core-error-cause"

export { findExecutableInPath } from "@diffdash/process/executable"
export { replaceExecutableAtomically } from "@diffdash/process/file-system"

const PrerequisiteInstallOperation = Schema.Literals([
  "installDiffDashCli.source",
  "installDiffDashCli.targetDirectory",
  "installDiffDashCli.appImage",
  "installDiffDashCli",
  "installDiffDashCli.linkExists",
])

/** A typed failure from installing the DiffDash CLI into PATH. */
export class PrerequisiteInstallError extends Schema.TaggedError<PrerequisiteInstallError>()(
  "PrerequisiteInstallError",
  {
    operation: PrerequisiteInstallOperation,
    message: Schema.String,
    cause: Schema.NullOr(CoreExpectedCause),
  },
) {}

/** Main-process service for setup prerequisite checks and install actions. */
export class Prerequisites extends Context.Service<
  Prerequisites,
  {
    readonly get: Effect.Effect<AppPrerequisites>
    readonly installDiffDashCli: Effect.Effect<DiffDashCliInstallResult, PrerequisiteInstallError>
  }
>()("@diffdash/Prerequisites") {
  /** Creates prerequisite checks from host-decoded executable and home paths. */
  static layer(options: {
    readonly appImagePath: CoreAbsolutePath | null
    readonly diffDashCliPath: CoreAbsolutePath
    readonly executableSearchPath: ExecutableSearchPath
    readonly executablePathExtensions: ExecutablePathExtensions | null
    readonly homeDirectory: CoreAbsolutePath | null
    readonly platform: NodeJS.Platform
  }): Layer.Layer<
    Prerequisites,
    never,
    AgentProviders | GitProvider | ProcessService | ProcessFileSystem
  > {
    return Layer.effect(
      Prerequisites,
      Effect.gen(function* () {
        const processes = yield* ProcessService
        const fileSystem = yield* ProcessFileSystem
        const gitProvider = yield* GitProvider
        const agentProviders = yield* AgentProviders
        const get = Effect.fn("Prerequisites.get")(function* () {
          yield* refreshAppImageCliLaunchersWithFileSystem(fileSystem, {
            sourcePath: options.diffDashCliPath,
            appImagePath: options.appImagePath,
            executableSearchPath: options.executableSearchPath,
            executablePathExtensions: options.executablePathExtensions,
            homeDirectory: options.homeDirectory,
            platform: options.platform,
          }).pipe(Effect.catch(() => Effect.void))
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
            .filter((provider) =>
              Object.values(provider.capabilities).some(AgentProviderCapabilityStatus.guards.Ready),
            )
            .map(({ id }) => CodingAgentName.make(id))
          const diffDashCliInPath = yield* findExecutableInPath("diffdash", {
            envPath: options.executableSearchPath,
            ...(options.executablePathExtensions === null
              ? {}
              : { pathExt: options.executablePathExtensions }),
            platform: options.platform,
          })
          const userLocalSearchPath =
            options.homeDirectory === null
              ? ""
              : [
                  join(options.homeDirectory, ".local", "bin"),
                  join(options.homeDirectory, "bin"),
                ].join(delimiter)
          const diffDashCli = Option.isSome(diffDashCliInPath)
            ? diffDashCliInPath
            : yield* findExecutableInPath("diffdash", {
                envPath: userLocalSearchPath,
                ...(options.executablePathExtensions === null
                  ? {}
                  : { pathExt: options.executablePathExtensions }),
                platform: options.platform,
              })

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
              const diagnostic = providerDiagnostics.find(
                (item) => item.providerId === descriptor.id,
              )
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
                  key: SetupRequirementKey.make(`provider:${descriptor.id}`),
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
          return installDiffDashCli(fileSystem, {
            sourcePath: options.diffDashCliPath,
            appImagePath: options.appImagePath,
            executableSearchPath: options.executableSearchPath,
            homeDirectory: options.homeDirectory,
          })
        })

        return Prerequisites.of({
          get: get(),
          installDiffDashCli: install(),
        })
      }),
    )
  }
}

const commandAvailable = (processes: ProcessRunner, command: string) =>
  processes.run(processRequest(command, ["--version"], { timeoutMs: 5_000 })).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )

const agentSetupRequirement = (provider: AgentProviderStatus) => {
  const supported = Object.values(provider.capabilities).filter(
    (status) => !AgentProviderCapabilityStatus.guards.Unsupported(status),
  )
  const ready = supported.length > 0 && supported.every(AgentProviderCapabilityStatus.guards.Ready)
  const unavailable = supported.find(
    (status) => !AgentProviderCapabilityStatus.guards.Ready(status),
  )
  const setupHint = provider.setup.find(
    (requirement) => requirement.installHint !== null,
  )?.installHint
  return SetupRequirement.make({
    key: SetupRequirementKey.make(`agent-provider:${provider.id}`),
    providerId: provider.id,
    title: `${provider.displayName} ready`,
    description: provider.description,
    detail: ready
      ? `${provider.displayName} is available.`
      : unavailable !== undefined && !AgentProviderCapabilityStatus.guards.Ready(unavailable)
        ? unavailable.reason
        : (setupHint ?? `${provider.displayName} needs setup.`),
    ready,
    requiredForLocalUse: false,
    helpUrl: provider.homepage === null ? null : WebUrl.make(provider.homepage),
  })
}

const APPIMAGE_LAUNCHER_MARKER = "# Generated by the DiffDash AppImage CLI installer."

const installDiffDashCli = (
  fileSystem: ProcessFileSystemOperations,
  {
    sourcePath,
    appImagePath,
    executableSearchPath,
    homeDirectory,
  }: {
    readonly sourcePath: CoreAbsolutePath
    readonly appImagePath: CoreAbsolutePath | null
    readonly executableSearchPath: ExecutableSearchPath
    readonly homeDirectory: CoreAbsolutePath | null
  },
) =>
  Effect.gen(function* () {
    if (sourcePath.length === 0 || !(yield* fileSystem.exists(sourcePath))) {
      return yield* PrerequisiteInstallError.make({
        cause: null,
        message: "Could not find the bundled DiffDash CLI.",
        operation: "installDiffDashCli.source",
      })
    }

    const targetDirectory = yield* firstWritablePathDirectory(
      fileSystem,
      executableSearchPath,
      homeDirectory,
    )
    if (targetDirectory === null) {
      return yield* PrerequisiteInstallError.make({
        cause: null,
        message: "Could not find or create a writable directory for the DiffDash CLI.",
        operation: "installDiffDashCli.targetDirectory",
      })
    }

    yield* fileSystem.ensureDirectory(targetDirectory, { recursive: true })

    const linkPath = resolve(targetDirectory, "diffdash")
    const existing = yield* fileSystem.inspect(linkPath)
    if (existing !== null) {
      if (existing.type === "symbolic-link") {
        const linkedPath = resolve(dirname(linkPath), yield* fileSystem.readLink(linkPath))
        if (appImagePath === null && linkedPath === sourcePath) {
          return installResult(linkPath, targetDirectory, executableSearchPath)
        }
        if (isTransientAppImageCliPath(linkedPath)) {
          if (appImagePath === null) yield* fileSystem.remove(linkPath)
        } else return yield* linkExistsError(linkPath)
      } else if (
        appImagePath !== null &&
        existing.type === "file" &&
        (yield* fileSystem.readText(linkPath)).includes(APPIMAGE_LAUNCHER_MARKER)
      ) {
        // Marker-owned launchers are replaced atomically below.
      } else {
        return yield* linkExistsError(linkPath)
      }
    }

    if (appImagePath !== null) {
      if (!(yield* fileSystem.exists(appImagePath))) {
        return yield* PrerequisiteInstallError.make({
          cause: null,
          message: "Could not find the persistent DiffDash AppImage.",
          operation: "installDiffDashCli.appImage",
        })
      }
      yield* fileSystem.replaceExecutableAtomically(
        ExecutablePath.make(linkPath),
        makeAppImageCliLauncher(yield* fileSystem.readText(sourcePath), appImagePath),
      )
    } else {
      yield* fileSystem.access(sourcePath, "executable")
      yield* fileSystem.symlink(sourcePath, linkPath)
    }
    return installResult(linkPath, targetDirectory, executableSearchPath)
  }).pipe(
    Effect.catch((cause) =>
      Schema.is(PrerequisiteInstallError)(cause)
        ? Effect.fail(cause)
        : PrerequisiteInstallError.make({
            cause,
            message: "Could not install the DiffDash CLI.",
            operation: "installDiffDashCli",
          }),
    ),
  )

const installResult = (path: string, targetDirectory: string, executableSearchPath: string) =>
  DiffDashCliInstallResult.make({
    path: ExecutablePath.make(path),
    pathSetupCommand: pathContainsDirectory(executableSearchPath, targetDirectory)
      ? null
      : `export PATH=${shellQuote(targetDirectory)}:$PATH`,
  })

const linkExistsError = (linkPath: string) =>
  PrerequisiteInstallError.make({
    cause: null,
    message: `${linkPath} already exists. Remove it or choose another installation directory.`,
    operation: "installDiffDashCli.linkExists",
  })

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
export const refreshAppImageCliLaunchers = Effect.fn("refreshAppImageCliLaunchers")(function* ({
  sourcePath,
  appImagePath,
  executableSearchPath,
  executablePathExtensions,
  homeDirectory,
  platform,
}: {
  readonly sourcePath: CoreAbsolutePath
  readonly appImagePath: CoreAbsolutePath | null
  readonly executableSearchPath: ExecutableSearchPath
  readonly executablePathExtensions: ExecutablePathExtensions | null
  readonly homeDirectory: CoreAbsolutePath | null
  readonly platform: NodeJS.Platform
}) {
  const fileSystem = yield* ProcessFileSystem
  return yield* refreshAppImageCliLaunchersWithFileSystem(fileSystem, {
    sourcePath,
    appImagePath,
    executableSearchPath,
    executablePathExtensions,
    homeDirectory,
    platform,
  }).pipe(Effect.catch(() => Effect.void))
})

const refreshAppImageCliLaunchersWithFileSystem = Effect.fn(
  "refreshAppImageCliLaunchersWithFileSystem",
)(function* (
  fileSystem: ProcessFileSystemOperations,
  {
    sourcePath,
    appImagePath,
    executableSearchPath,
    executablePathExtensions,
    homeDirectory,
    platform,
  }: {
    readonly sourcePath: CoreAbsolutePath
    readonly appImagePath: CoreAbsolutePath | null
    readonly executableSearchPath: ExecutableSearchPath
    readonly executablePathExtensions: ExecutablePathExtensions | null
    readonly homeDirectory: CoreAbsolutePath | null
    readonly platform: NodeJS.Platform
  },
) {
  if (
    appImagePath === null ||
    !(yield* fileSystem.exists(sourcePath)) ||
    !(yield* fileSystem.exists(appImagePath))
  )
    return

  const diffDashInPath = yield* findExecutableInPath("diffdash", {
    envPath: executableSearchPath,
    ...(executablePathExtensions === null ? {} : { pathExt: executablePathExtensions }),
    platform,
  })
  const candidates = new Set([
    Option.getOrNull(diffDashInPath),
    homeDirectory === null ? null : join(homeDirectory, ".local", "bin", "diffdash"),
    homeDirectory === null ? null : join(homeDirectory, "bin", "diffdash"),
  ])
  const source = yield* fileSystem.readText(sourcePath)
  const launcher = makeAppImageCliLauncher(source, appImagePath)
  yield* Effect.forEach(
    candidates,
    (candidate) =>
      candidate === null
        ? Effect.void
        : refreshLauncherCandidate(fileSystem, candidate, launcher).pipe(
            Effect.catch(() => Effect.void),
          ),
    { discard: true },
  )
})

const refreshLauncherCandidate = (
  fileSystem: ProcessFileSystemOperations,
  candidate: string,
  launcher: string,
) =>
  Effect.gen(function* () {
    if (!(yield* fileSystem.exists(candidate))) return
    const existing = yield* fileSystem.inspect(candidate)
    if (existing?.type !== "file") return
    const current = yield* fileSystem.readText(candidate)
    if (!current.includes(APPIMAGE_LAUNCHER_MARKER) || current === launcher) return
    yield* fileSystem.replaceExecutableAtomically(ExecutablePath.make(candidate), launcher)
  })

const firstWritablePathDirectory = Effect.fn("firstWritablePathDirectory")(function* (
  fileSystem: ProcessFileSystemOperations,
  executableSearchPath: string,
  homeDirectory: string | null,
) {
  const pathDirectories = executableSearchPath.split(delimiter).filter((entry) => entry.length > 0)
  const preferredDirectories = [
    homeDirectory === null ? "" : join(homeDirectory, ".local", "bin"),
    homeDirectory === null ? "" : join(homeDirectory, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const candidates = uniqueDirectories([...pathDirectories, ...preferredDirectories])

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate)
    if (yield* canWriteDirectory(fileSystem, resolvedCandidate)) return resolvedCandidate
  }

  return null
})

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

const canWriteDirectory = (fileSystem: ProcessFileSystemOperations, directory: string) =>
  Effect.gen(function* () {
    if (!(yield* fileSystem.exists(directory))) {
      yield* fileSystem.ensureDirectory(directory, { recursive: true })
    }
    yield* fileSystem.access(directory, "writable")
    return true
  }).pipe(Effect.catch(() => Effect.succeed(false)))
