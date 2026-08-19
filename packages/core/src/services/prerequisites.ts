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
    readonly appImagePath: Option.Option<CoreAbsolutePath>
    readonly diffDashCliPath: CoreAbsolutePath
    readonly executableSearchPath: ExecutableSearchPath
    readonly executablePathExtensions: Option.Option<ExecutablePathExtensions>
    readonly homeDirectory: Option.Option<CoreAbsolutePath>
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
          const diffDashCliInPath = yield* findDiffDashExecutable(
            options.executableSearchPath,
            options.executablePathExtensions,
            options.platform,
          )
          const diffDashCli = Option.isSome(diffDashCliInPath)
            ? diffDashCliInPath
            : yield* Option.match(options.homeDirectory, {
                onNone: () => Effect.succeed(Option.none<ExecutablePath>()),
                onSome: (homeDirectory) =>
                  findDiffDashExecutable(
                    [join(homeDirectory, ".local", "bin"), join(homeDirectory, "bin")].join(
                      delimiter,
                    ),
                    options.executablePathExtensions,
                    options.platform,
                  ),
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
              const diagnostic = Option.fromNullishOr(
                providerDiagnostics.find((item) => item.providerId === descriptor.id),
              )
              return Option.toArray(
                Option.map(diagnostic, (value) =>
                  ProviderDiagnostic.make({ descriptor, diagnostic: value }),
                ),
              )
            }),
            setupRequirements: [
              ...providerDescriptors.map((descriptor) => {
                const diagnostic = Option.fromNullishOr(
                  providerDiagnostics.find((item) => item.providerId === descriptor.id),
                )
                const ready = Option.exists(
                  diagnostic,
                  (value) => value.available && value.authenticated,
                )
                return SetupRequirement.make({
                  key: SetupRequirementKey.make(`provider:${descriptor.id}`),
                  providerId: descriptor.id,
                  title: `${descriptor.displayName} ready`,
                  description: `Connect ${descriptor.displayName} to search ${descriptor.terminology.repositoryPlural} and review ${descriptor.terminology.reviewPlural}.`,
                  detail: ready
                    ? `${descriptor.displayName} is available and authenticated.`
                    : Option.match(diagnostic, {
                        onNone: () => `${descriptor.displayName} needs setup or authentication.`,
                        onSome: (value) =>
                          value.message ??
                          `${descriptor.displayName} needs setup or authentication.`,
                      }),
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

const findDiffDashExecutable = (
  envPath: ExecutableSearchPath | string,
  pathExt: Option.Option<ExecutablePathExtensions>,
  platform: NodeJS.Platform,
) =>
  Option.match(pathExt, {
    onNone: () => findExecutableInPath("diffdash", { envPath, platform }),
    onSome: (value) => findExecutableInPath("diffdash", { envPath, pathExt: value, platform }),
  })

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
  let detail = setupHint ?? `${provider.displayName} needs setup.`
  if (unavailable !== undefined && !AgentProviderCapabilityStatus.guards.Ready(unavailable)) {
    detail = unavailable.reason
  }
  if (ready) detail = `${provider.displayName} is available.`
  return SetupRequirement.make({
    key: SetupRequirementKey.make(`agent-provider:${provider.id}`),
    providerId: provider.id,
    title: `${provider.displayName} ready`,
    description: provider.description,
    detail,
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
    readonly appImagePath: Option.Option<CoreAbsolutePath>
    readonly executableSearchPath: ExecutableSearchPath
    readonly homeDirectory: Option.Option<CoreAbsolutePath>
  },
) =>
  Effect.gen(function* () {
    yield* fileSystem.exists(sourcePath).pipe(
      Effect.filterOrFail(
        (exists) => sourcePath.length > 0 && exists,
        () =>
          PrerequisiteInstallError.make({
            cause: null,
            message: "Could not find the bundled DiffDash CLI.",
            operation: "installDiffDashCli.source",
          }),
      ),
    )

    const targetDirectoryOption = yield* firstWritablePathDirectory(
      fileSystem,
      executableSearchPath,
      homeDirectory,
    )
    const targetDirectory = yield* Effect.fromOption(targetDirectoryOption).pipe(
      Effect.mapError(() =>
        PrerequisiteInstallError.make({
          cause: null,
          message: "Could not find or create a writable directory for the DiffDash CLI.",
          operation: "installDiffDashCli.targetDirectory",
        }),
      ),
    )

    yield* fileSystem.ensureDirectory(targetDirectory, { recursive: true })

    const linkPath = resolve(targetDirectory, "diffdash")
    const existing = yield* fileSystem.inspect(linkPath)
    if (existing !== null) {
      if (existing.type === "symbolic-link") {
        const linkedPath = resolve(dirname(linkPath), yield* fileSystem.readLink(linkPath))
        if (Option.isNone(appImagePath) && linkedPath === sourcePath) {
          return installResult(linkPath, targetDirectory, executableSearchPath)
        }
        if (isTransientAppImageCliPath(linkedPath)) {
          if (Option.isNone(appImagePath)) yield* fileSystem.remove(linkPath)
        } else return yield* linkExistsError(linkPath)
      } else if (
        Option.isSome(appImagePath) &&
        existing.type === "file" &&
        (yield* fileSystem.readText(linkPath)).includes(APPIMAGE_LAUNCHER_MARKER)
      ) {
        // Marker-owned launchers are replaced atomically below.
      } else {
        return yield* linkExistsError(linkPath)
      }
    }

    if (Option.isSome(appImagePath)) {
      yield* fileSystem.exists(appImagePath.value).pipe(
        Effect.filterOrFail(
          (exists) => exists,
          () =>
            PrerequisiteInstallError.make({
              cause: null,
              message: "Could not find the persistent DiffDash AppImage.",
              operation: "installDiffDashCli.appImage",
            }),
        ),
      )
      yield* fileSystem.replaceExecutableAtomically(
        ExecutablePath.make(linkPath),
        makeAppImageCliLauncher(yield* fileSystem.readText(sourcePath), appImagePath.value),
      )
    } else {
      yield* fileSystem.access(sourcePath, "executable")
      yield* fileSystem.symlink(sourcePath, linkPath)
    }
    return installResult(linkPath, targetDirectory, executableSearchPath)
  }).pipe(
    Effect.catchTag("ProcessFileSystemError", (cause) =>
      PrerequisiteInstallError.make({
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
  readonly appImagePath: Option.Option<CoreAbsolutePath>
  readonly executableSearchPath: ExecutableSearchPath
  readonly executablePathExtensions: Option.Option<ExecutablePathExtensions>
  readonly homeDirectory: Option.Option<CoreAbsolutePath>
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
    readonly appImagePath: Option.Option<CoreAbsolutePath>
    readonly executableSearchPath: ExecutableSearchPath
    readonly executablePathExtensions: Option.Option<ExecutablePathExtensions>
    readonly homeDirectory: Option.Option<CoreAbsolutePath>
    readonly platform: NodeJS.Platform
  },
) {
  if (
    Option.isNone(appImagePath) ||
    !(yield* fileSystem.exists(sourcePath)) ||
    !(yield* fileSystem.exists(appImagePath.value))
  )
    return

  const diffDashInPath = yield* findDiffDashExecutable(
    executableSearchPath,
    executablePathExtensions,
    platform,
  )
  const candidates = new Set([
    ...Option.toArray(diffDashInPath),
    ...Option.toArray(Option.map(homeDirectory, (home) => join(home, ".local", "bin", "diffdash"))),
    ...Option.toArray(Option.map(homeDirectory, (home) => join(home, "bin", "diffdash"))),
  ])
  const source = yield* fileSystem.readText(sourcePath)
  const launcher = makeAppImageCliLauncher(source, appImagePath.value)
  yield* Effect.forEach(
    candidates,
    (candidate) =>
      refreshLauncherCandidate(fileSystem, candidate, launcher).pipe(
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
  homeDirectory: Option.Option<CoreAbsolutePath>,
) {
  const pathDirectories = executableSearchPath.split(delimiter).filter((entry) => entry.length > 0)
  const preferredDirectories = [
    ...Option.toArray(Option.map(homeDirectory, (home) => join(home, ".local", "bin"))),
    ...Option.toArray(Option.map(homeDirectory, (home) => join(home, "bin"))),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const candidates = uniqueDirectories([...pathDirectories, ...preferredDirectories])

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate)
    if (yield* canWriteDirectory(fileSystem, resolvedCandidate))
      return Option.some(resolvedCandidate)
  }

  return Option.none<string>()
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
