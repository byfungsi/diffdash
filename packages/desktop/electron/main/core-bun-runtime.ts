import { CORE_PROCESS_STARTUP_ENV } from "@diffdash/core-rpc/process-startup"
import { Effect, FileSystem, Schema } from "effect"
import { spawn } from "node:child_process"
import { delimiter, dirname, join } from "node:path"

import type { CoreHostTransportConfiguration } from "./core-host-bootstrap"
import {
  CoreProcessLaunchError,
  startCoreProcessManaged,
  type CoreProcessHandle,
  type CoreProcessSpawner,
} from "./core-process-launcher"

/** Bun executable candidate found without relying on an interactive shell. */
export interface BunRuntimeCandidate {
  readonly executablePath: string
  readonly source: "path" | "home" | "system"
}

/** Bun capability that failed qualification. */
export const BunQualificationCapability = Schema.Literals([
  "version",
  "architecture",
  "worker",
  "processCancellation",
  "filesystem",
  "socket",
  "effect",
  "sqlite",
  "artifact",
  "coreHealth",
])

/** Bun capability that failed qualification. */
export type BunQualificationCapability = typeof BunQualificationCapability.Type

/** Sanitized rejection of an external Bun candidate. */
export class BunRuntimeQualificationError extends Schema.TaggedError<BunRuntimeQualificationError>()(
  "BunRuntimeQualificationError",
  {
    capability: BunQualificationCapability,
    safeMessage: Schema.Literal("DiffDash could not qualify the external Bun runtime."),
  },
) {}

/** Sanitized failure returned by a concrete Bun qualification probe. */
export class BunRuntimeProbeError extends Schema.TaggedError<BunRuntimeProbeError>()(
  "BunRuntimeProbeError",
  {
    safeMessage: Schema.Literal("A Bun runtime probe failed."),
  },
) {}

/** Runtime facts returned by the inexpensive Bun executable probe. */
export interface BunRuntimeFacts {
  readonly version: string
  readonly architecture: NodeJS.Architecture
}

/** Qualification operations that prove every Bun capability required by Core. */
export interface BunRuntimeQualificationHooks {
  readonly runtimeFacts: (
    candidate: BunRuntimeCandidate,
  ) => Effect.Effect<BunRuntimeFacts, BunRuntimeProbeError>
  readonly worker: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
  readonly processCancellation: (
    candidate: BunRuntimeCandidate,
  ) => Effect.Effect<void, BunRuntimeProbeError>
  readonly filesystem: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
  readonly socket: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
  readonly effect: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
  readonly sqlite: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
  readonly artifact: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
  readonly coreHealth: (candidate: BunRuntimeCandidate) => Effect.Effect<void, BunRuntimeProbeError>
}

/** Inputs used to discover Bun from GUI-safe locations and the captured application PATH. */
export interface DiscoverBunRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly homeDirectory: string | null
  readonly platform: NodeJS.Platform
}

/** Inputs required by the hardened external Bun Core launcher. */
export interface StartCoreBunProcessOptions {
  readonly applicationCwd: string
  readonly bunExecutablePath: string
  readonly configuration: CoreHostTransportConfiguration
  readonly databasePath: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly statePath: string
  readonly listenTimeout?: number
}

/** Hardened Bun command and process options used for one Core launch. */
export interface BunCoreCommand {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
}

const BUN_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
] as const

const qualificationFailure = (capability: BunQualificationCapability) =>
  BunRuntimeQualificationError.make({
    capability,
    safeMessage: "DiffDash could not qualify the external Bun runtime.",
  })

const parseVersion = (value: string): ReadonlyArray<number> | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim())
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

const atLeastVersion = (actual: string, minimum: string): boolean => {
  const left = parseVersion(actual)
  const right = parseVersion(minimum)
  if (left === null || right === null) return false
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

/** Returns ordered, deduplicated Bun candidates including Finder-safe conventional locations. */
export const discoverBunRuntimeCandidates = (
  options: DiscoverBunRuntimeOptions,
): ReadonlyArray<BunRuntimeCandidate> => {
  const executableName = options.platform === "win32" ? "bun.exe" : "bun"
  const pathCandidates = (options.environment.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => ({
      executablePath: join(directory, executableName),
      source: "path" as const,
    }))
  const homeCandidates =
    options.homeDirectory === null
      ? []
      : [
          {
            executablePath: join(options.homeDirectory, ".bun", "bin", executableName),
            source: "home" as const,
          },
        ]
  const systemCandidates =
    options.platform === "darwin"
      ? ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
      : options.platform === "linux"
        ? ["/usr/local/bin/bun", "/usr/bin/bun"]
        : []
  const candidates = [
    ...pathCandidates,
    ...homeCandidates,
    ...systemCandidates.map((executablePath) => ({ executablePath, source: "system" as const })),
  ]
  const seen = new Set<string>()
  return candidates.filter(({ executablePath }) => {
    if (seen.has(executablePath)) return false
    seen.add(executablePath)
    return true
  })
}

/** Runs the complete Core Bun qualification matrix through caller-owned probes. */
export const qualifyBunRuntime = Effect.fn("qualifyBunRuntime")(function* (
  candidate: BunRuntimeCandidate,
  requirements: { readonly minimumVersion: string; readonly architecture: NodeJS.Architecture },
  hooks: BunRuntimeQualificationHooks,
) {
  const facts = yield* hooks
    .runtimeFacts(candidate)
    .pipe(Effect.mapError(() => qualificationFailure("version")))
  if (!atLeastVersion(facts.version, requirements.minimumVersion)) {
    return yield* qualificationFailure("version")
  }
  if (facts.architecture !== requirements.architecture) {
    return yield* qualificationFailure("architecture")
  }
  const probes = [
    ["worker", hooks.worker],
    ["processCancellation", hooks.processCancellation],
    ["filesystem", hooks.filesystem],
    ["socket", hooks.socket],
    ["effect", hooks.effect],
    ["sqlite", hooks.sqlite],
    ["artifact", hooks.artifact],
    ["coreHealth", hooks.coreHealth],
  ] as const
  for (const [capability, probe] of probes) {
    yield* probe(candidate).pipe(Effect.mapError(() => qualificationFailure(capability)))
  }
  return candidate
})

/** Builds the positive environment allowlist supplied to an external Bun Core. */
export const makeBunCoreEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  encodedStartupConfiguration: string,
): Readonly<Record<string, string>> => {
  const allowed: Record<string, string> = {
    [CORE_PROCESS_STARTUP_ENV]: encodedStartupConfiguration,
  }
  for (const name of BUN_ENVIRONMENT_ALLOWLIST) {
    const value = environment[name]
    if (value !== undefined) allowed[name] = value
  }
  return allowed
}

/** Builds a Bun command that disables environment files and dependency installation. */
export const makeBunCoreCommand = (options: {
  readonly applicationCwd: string
  readonly configPath: string
  readonly encodedStartupConfiguration: string
  readonly entrypointPath: string
  readonly environment: Readonly<Record<string, string | undefined>>
}): BunCoreCommand => ({
  args: [
    `--cwd=${options.applicationCwd}`,
    `--config=${options.configPath}`,
    "--no-env-file",
    "--no-install",
    options.entrypointPath,
  ],
  cwd: options.applicationCwd,
  environment: makeBunCoreEnvironment(options.environment, options.encodedStartupConfiguration),
})

/** Launches Core with Bun using an owned empty config, application cwd, and isolated environment. */
export const startCoreBunProcess = Effect.fn("startCoreBunProcess")(function* (
  options: StartCoreBunProcessOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const configPath = join(dirname(options.configuration.socketPath), "bunfig.toml")
  yield* fileSystem.writeFileString(configPath, "").pipe(
    Effect.andThen(fileSystem.chmod(configPath, 0o600)),
    Effect.mapError(() =>
      CoreProcessLaunchError.make({
        reason: "spawn-failed",
        safeMessage: "DiffDash could not launch its private Core process.",
      }),
    ),
  )

  const spawner: CoreProcessSpawner = {
    spawn: ({ entrypointPath, encodedStartupConfiguration }) => {
      const command = makeBunCoreCommand({
        applicationCwd: options.applicationCwd,
        configPath,
        encodedStartupConfiguration,
        entrypointPath,
        environment: options.environment,
      })
      const child = spawn(options.bunExecutablePath, command.args, {
        cwd: command.cwd,
        env: command.environment,
        stdio: "ignore",
      })
      const exited = new Promise<number>((resolve) =>
        child.once("exit", (code) => resolve(code ?? -1)),
      )
      return {
        awaitExit: Effect.promise(() => exited),
        kill: () => child.kill(),
      } satisfies CoreProcessHandle
    },
  }

  if (options.listenTimeout === undefined) {
    return yield* startCoreProcessManaged({
      configuration: options.configuration,
      databasePath: options.databasePath,
      statePath: options.statePath,
      spawner,
    })
  }
  return yield* startCoreProcessManaged({
    configuration: options.configuration,
    databasePath: options.databasePath,
    statePath: options.statePath,
    spawner,
    listenTimeout: options.listenTimeout,
  })
})
