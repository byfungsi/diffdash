import { homedir } from "node:os"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { CoreConfiguration, CoreConfigurationError } from "@diffdash/core"
import { Effect, Schema } from "effect"
import { app } from "electron"
import type { ApplicationIdentity } from "./application-identity"
import { decodeCoreConfiguration } from "./core-configuration"
import type { CoreHostMode } from "./core-host-selection"
import { resolveApplicationPaths, type ApplicationPaths } from "./paths"

const optionalEnvironmentValue = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value

const PackagedRendererUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          return new URL(value).protocol === "file:"
        } catch {
          return false
        }
      },
      { message: "Expected a file URL" },
    ),
  ),
  Schema.brand("PackagedRendererUrl"),
)

const DevelopmentRendererUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          const url = new URL(value)
          return url.protocol === "http:" || url.protocol === "https:"
        } catch {
          return false
        }
      },
      { message: "Expected an HTTP or HTTPS URL" },
    ),
  ),
  Schema.brand("DevelopmentRendererUrl"),
)

/** Packaged renderer document selected as the desktop renderer entry. */
export class PackagedRendererEntry extends Schema.TaggedClass<PackagedRendererEntry>()(
  "PackagedRendererEntry",
  { url: PackagedRendererUrl },
) {}

/** Development server selected as the desktop renderer entry. */
export class DevelopmentRendererEntry extends Schema.TaggedClass<DevelopmentRendererEntry>()(
  "DevelopmentRendererEntry",
  { url: DevelopmentRendererUrl },
) {}

/** Closed renderer entry state selected and decoded at the environment boundary. */
export const RendererEntry = Schema.Union([PackagedRendererEntry, DevelopmentRendererEntry])

/** Closed renderer entry state selected and decoded at the environment boundary. */
export type RendererEntry = typeof RendererEntry.Type

/** A recoverable failure while decoding Electron renderer configuration. */
export class RendererConfigurationError extends Schema.TaggedError<RendererConfigurationError>()(
  "RendererConfigurationError",
  {
    message: Schema.String,
  },
) {}

/** Complete expected failure union while constructing desktop host configuration. */
export type DesktopHostConfigurationError = CoreConfigurationError | RendererConfigurationError

/** Electron facts and policies captured once after application identity setup. */
export interface DesktopHostConfiguration {
  readonly identity: ApplicationIdentity
  readonly application: {
    readonly version: string
    readonly architecture: NodeJS.Architecture
    readonly platform: NodeJS.Platform
    readonly packaged: boolean
  }
  readonly policies: {
    readonly allowMultipleInstances: boolean
    readonly coreHostMode: CoreHostMode
    readonly debugOnboarding: boolean
    readonly hiddenWindow: boolean
    readonly updatesDisabled: boolean
  }
  readonly paths: ApplicationPaths
  readonly renderer: RendererEntry
  readonly updater: {
    readonly appImagePath: string | null
  }
  readonly core: CoreConfiguration
}

/** Build-selected behavior that must be supplied by a concrete desktop entrypoint. */
export interface DesktopStartupConfiguration {
  readonly coreHostMode: CoreHostMode
  readonly hiddenWindow: boolean
  readonly updatesDisabled: boolean
  readonly fixtures: {
    readonly agentProviderEnabled: boolean
    readonly agentProviderNeverCompletes: boolean
    readonly gitProvider: {
      readonly remoteUrl: string | undefined
      readonly baseRevision: string | null
      readonly headRevision: string | null
    } | null
  }
}

/** Production startup behavior, independent of all E2E environment switches. */
export const productionDesktopStartupConfiguration: DesktopStartupConfiguration = {
  coreHostMode: "auto",
  hiddenWindow: false,
  updatesDisabled: false,
  fixtures: {
    agentProviderEnabled: false,
    agentProviderNeverCompletes: false,
    gitProvider: null,
  },
}

/** Inputs read from Electron and Node while constructing the host snapshot. */
export interface DesktopHostConfigurationSource {
  readonly identity: ApplicationIdentity
  readonly version: string
  readonly architecture: NodeJS.Architecture
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly temporaryDirectory: string
  readonly userDataDirectory: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: string
  readonly moduleDirectory: string
}

/** Builds and validates the immutable desktop host snapshot from already-captured facts. */
export const makeDesktopHostConfiguration = (
  source: DesktopHostConfigurationSource,
  startup: DesktopStartupConfiguration,
): Effect.Effect<DesktopHostConfiguration, DesktopHostConfigurationError> => {
  const pathSource = {
    environment: source.environment,
    identity: source.identity,
    moduleDirectory: source.moduleDirectory,
    packaged: source.packaged,
    resourcesPath: source.resourcesPath,
    temporaryDirectory: source.temporaryDirectory,
    userDataDirectory: source.userDataDirectory,
  }
  const paths = resolveApplicationPaths(
    source.homeDirectory === undefined
      ? pathSource
      : { ...pathSource, homeDirectory: source.homeDirectory },
  )
  const core = {
    application: {
      version: source.version,
      architecture: source.architecture,
      platform: source.platform,
      packaged: source.packaged,
    },
    paths: {
      database: paths.databasePath,
      settings: paths.settingsPath,
      state: paths.statePath,
      temporaryDirectory: paths.agentWorkingDirectory,
      worktreePool: paths.worktreePoolPath,
      remoteWorktreePool: paths.remoteWorktreePoolPath,
      diffDashCli: paths.diffDashCliPath,
      appImage: optionalEnvironmentValue(source.environment.APPIMAGE),
    },
    analytics: {
      host: optionalEnvironmentValue(source.environment.VITE_POSTHOG_HOST),
      projectKey: optionalEnvironmentValue(source.environment.VITE_POSTHOG_KEY),
    },
    environment: {
      executableSearchPath: source.environment.PATH ?? "",
      executablePathExtensions: optionalEnvironmentValue(source.environment.PATHEXT),
      homeDirectory: optionalEnvironmentValue(source.environment.HOME),
    },
    fixtures: startup.fixtures,
  }
  const rendererInput =
    source.packaged || source.environment.ELECTRON_RENDERER_URL === undefined
      ? {
          _tag: "PackagedRendererEntry",
          url: pathToFileURL(paths.rendererHtmlPath).href,
        }
      : {
          _tag: "DevelopmentRendererEntry",
          url: source.environment.ELECTRON_RENDERER_URL,
        }

  return Effect.all({
    core: decodeCoreConfiguration(core),
    renderer: Schema.decodeUnknownEffect(RendererEntry)(rendererInput).pipe(
      Effect.mapError(() =>
        RendererConfigurationError.make({
          message: "DiffDash renderer configuration is invalid.",
        }),
      ),
    ),
  }).pipe(
    Effect.map(({ core: decodedCore, renderer }) => ({
      identity: source.identity,
      application: core.application,
      policies: {
        allowMultipleInstances: source.environment.DIFFDASH_ALLOW_MULTIPLE_INSTANCES === "1",
        coreHostMode: startup.coreHostMode,
        debugOnboarding: !source.packaged && source.environment.DEBUG_ONBOARD === "1",
        hiddenWindow: startup.hiddenWindow,
        updatesDisabled: startup.updatesDisabled,
      },
      paths,
      renderer,
      updater: {
        appImagePath: optionalEnvironmentValue(source.environment.APPIMAGE),
      },
      core: decodedCore,
    })),
  )
}

/** Reads Electron and Node globals once after `app.setPath` has established identity paths. */
export const resolveDesktopHostConfiguration = (
  identity: ApplicationIdentity,
  startup: DesktopStartupConfiguration,
): Effect.Effect<DesktopHostConfiguration, DesktopHostConfigurationError> =>
  makeDesktopHostConfiguration(
    {
      identity,
      version: app.getVersion(),
      architecture: process.arch,
      platform: process.platform,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      temporaryDirectory: app.getPath("temp"),
      userDataDirectory: app.getPath("userData"),
      environment: process.env,
      homeDirectory: homedir(),
      moduleDirectory: dirname(fileURLToPath(import.meta.url)),
    },
    startup,
  )
