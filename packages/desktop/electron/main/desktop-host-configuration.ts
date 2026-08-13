import { homedir } from "node:os"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { CoreConfiguration, CoreConfigurationError } from "@diffdash/core"
import { Effect } from "effect"
import { app } from "electron"
import type { ApplicationIdentity } from "./application-identity"
import { decodeCoreConfiguration } from "./core-configuration"
import { resolveApplicationPaths, type ApplicationPaths } from "./paths"

const optionalEnvironmentValue = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value

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
    readonly debugOnboarding: boolean
    readonly hiddenWindow: boolean
    readonly updatesDisabled: boolean
  }
  readonly paths: ApplicationPaths
  readonly renderer: {
    readonly developmentUrl: string | undefined
    readonly packagedUrl: string
  }
  readonly updater: {
    readonly appImagePath: string | null
  }
  readonly core: CoreConfiguration
}

/** Build-selected behavior that must be supplied by a concrete desktop entrypoint. */
export interface DesktopStartupConfiguration {
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
): Effect.Effect<DesktopHostConfiguration, CoreConfigurationError> => {
  const paths = resolveApplicationPaths({
    environment: source.environment,
    ...(source.homeDirectory === undefined ? {} : { homeDirectory: source.homeDirectory }),
    identity: source.identity,
    moduleDirectory: source.moduleDirectory,
    packaged: source.packaged,
    resourcesPath: source.resourcesPath,
    temporaryDirectory: source.temporaryDirectory,
    userDataDirectory: source.userDataDirectory,
  })
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

  return decodeCoreConfiguration(core).pipe(
    Effect.map((decodedCore) => ({
      identity: source.identity,
      application: core.application,
      policies: {
        allowMultipleInstances: source.environment.DIFFDASH_ALLOW_MULTIPLE_INSTANCES === "1",
        debugOnboarding: !source.packaged && source.environment.DEBUG_ONBOARD === "1",
        hiddenWindow: startup.hiddenWindow,
        updatesDisabled: startup.updatesDisabled,
      },
      paths,
      renderer: {
        developmentUrl: source.packaged ? undefined : source.environment.ELECTRON_RENDERER_URL,
        packagedUrl: pathToFileURL(paths.rendererHtmlPath).href,
      },
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
): Effect.Effect<DesktopHostConfiguration, CoreConfigurationError> =>
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
