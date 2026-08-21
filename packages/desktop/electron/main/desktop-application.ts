import { Effect, Predicate } from "effect"
import {
  app,
  BrowserWindow,
  type BrowserWindow as BrowserWindowType,
  dialog,
  shell,
} from "electron"
import { resolveApplicationIdentity, type ApplicationIdentity } from "./application-identity"
import type { ApplicationRuntime } from "./application-runtime"
import { disposeApplicationResources } from "./application-resources"
import { createApplicationUpdater } from "./application-updater"
import { hasRepositoryIdentityRepairCommand } from "./cli-navigation"
import { createCliReadiness } from "./cli-readiness"
import type {
  DesktopHostConfiguration,
  DesktopHostConfigurationError,
} from "./desktop-host-configuration"
import { createRendererSecurityPolicy } from "./electron-policy"
import type { RendererSecurityPolicy } from "./electron-policy"
import { installIpcControllers } from "./ipc/controllers"
import { createNavigation } from "./navigation"
import { createShutdown } from "./shutdown"
import { installSingleInstanceHandling } from "./single-instance"
import { logStartupStage } from "./startup-logging"
import { createMainWindow } from "./window"
import { revealAppWindow } from "./window-activation"

logStartupStage("main module loaded")

const revealWindow = (targetWindow: BrowserWindowType, configuration: DesktopHostConfiguration) => {
  revealAppWindow(targetWindow, {
    hidden: configuration.policies.hiddenWindow,
    platform: configuration.application.platform,
    focusApplication: () => app.focus({ steal: true }),
  })
}

let mainWindow: BrowserWindowType | null = null
let activeRendererSecurityPolicy: RendererSecurityPolicy | null = null
let activeHostConfiguration: DesktopHostConfiguration | null = null
const cliReadiness = createCliReadiness()
const getWindow = () => mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null

const configureApplicationIdentity = () => {
  const identity = resolveApplicationIdentity({
    appDataPath: app.getPath("appData"),
    explicitUserDataDirectory: app.commandLine.hasSwitch("user-data-dir"),
    packaged: app.isPackaged,
  })
  app.setAppUserModelId(identity.appUserModelId)
  app.setName(identity.appName)
  if (identity.userDataPath !== null) app.setPath("userData", identity.userDataPath)
  return identity
}

const createWindow = (
  configuration: DesktopHostConfiguration,
  rendererSecurityPolicy: RendererSecurityPolicy,
) => {
  cliReadiness.rendererLoading()
  mainWindow = createMainWindow({
    configuration,
    logStartupStage,
    navigationCommands: navigation.commands,
    onClosed: () => {
      mainWindow = null
    },
    onRendererLoaded: cliReadiness.rendererLoaded,
    onRendererLoading: cliReadiness.rendererLoading,
    rendererSecurityPolicy,
    revealWindow: (window) => revealWindow(window, configuration),
  })
  return mainWindow
}

const activateMainWindow = () => {
  const targetWindow = getWindow()
  if (targetWindow !== null && !targetWindow.isDestroyed()) {
    const configuration = activeHostConfiguration
    if (configuration === null) return null
    revealWindow(targetWindow, configuration)
    return targetWindow
  }
  if (activeRendererSecurityPolicy === null || activeHostConfiguration === null) return null
  return createWindow(activeHostConfiguration, activeRendererSecurityPolicy)
}

const navigation = createNavigation({ activateWindow: activateMainWindow })

const start = async (
  configuration: DesktopHostConfiguration,
  composition: DesktopApplicationComposition,
) => {
  activeHostConfiguration = configuration
  if (configuration.application.platform === "darwin") {
    app.setActivationPolicy(configuration.policies.hiddenWindow ? "accessory" : "regular")
  }

  await app.whenReady()
  logStartupStage("electron ready")
  if (configuration.application.platform === "darwin" && !configuration.policies.hiddenWindow) {
    const developmentIconPath = configuration.paths.developmentIconPath
    if (developmentIconPath !== null) app.dock?.setIcon(developmentIconPath)
    app.dock?.show()
  }

  const rendererSecurityPolicy = createRendererSecurityPolicy({
    isTrustedWebContents: (webContents) => webContents === mainWindow?.webContents,
    openExternal: (url) => shell.openExternal(url),
    rendererEntry: configuration.renderer,
  })
  const applicationRuntime = composition.createApplicationRuntime(configuration)
  const updater = createApplicationUpdater(configuration)
  const shutdown = createShutdown({
    dispose: () => disposeApplicationResources(updater, applicationRuntime),
    quit: () => app.quit(),
  })
  app.on("before-quit", shutdown.beforeQuit)
  await applicationRuntime.start()
  installIpcControllers(
    applicationRuntime,
    updater,
    navigation.commands,
    rendererSecurityPolicy,
    shutdown,
    configuration,
  )
  activeRendererSecurityPolicy = rendererSecurityPolicy
  const shouldRepairOnStartup = !hasRepositoryIdentityRepairCommand(navigation.commands.peek())
  activateMainWindow()
  if (shouldRepairOnStartup) {
    void applicationRuntime.core
      .repairRepositoryIdentities({})
      .then((result) => {
        console.info(
          `[repositories:repair] resolved=${result.resolvedCount} unresolved=${result.unresolvedCount} localAliases=${result.localAliasCount}`,
        )
        return undefined
      })
      .catch((error) => {
        const message = Predicate.isError(error) ? error.message : String(error)
        console.warn(`[repositories:repair] ${message}`)
      })
  }
  app.on("activate", () => {
    activateMainWindow()
  })
}

/** Required runtime wiring selected by the concrete production or E2E entrypoint. */
export interface DesktopApplicationComposition {
  readonly createApplicationRuntime: (configuration: DesktopHostConfiguration) => ApplicationRuntime
  readonly resolveHostConfiguration: (
    identity: ApplicationIdentity,
  ) => Effect.Effect<DesktopHostConfiguration, DesktopHostConfigurationError>
}

/** Starts Electron startup and top-level lifecycle handling. */
export const startDesktopApplication = (composition: DesktopApplicationComposition) => {
  const identity = configureApplicationIdentity()
  let configuration: DesktopHostConfiguration
  try {
    configuration = Effect.runSync(composition.resolveHostConfiguration(identity))
  } catch (error) {
    const message = Predicate.isError(error) ? error.message : String(error)
    console.error(`[startup:failed] ${message}`)
    app.quit()
    return
  }
  activeHostConfiguration = configuration
  const acquired = installSingleInstanceHandling({
    allowDevRestart: !configuration.application.packaged,
    allowMultipleInstances: configuration.policies.allowMultipleInstances,
    enqueue: navigation.enqueue,
    registerReadiness: cliReadiness.register,
    revealExistingWindow: activateMainWindow,
  })
  if (!acquired) {
    app.quit()
    return
  }

  void start(configuration, composition).catch((error) => {
    const message = Predicate.isError(error) ? error.message : String(error)
    console.error(`[startup:failed] ${message}`)
    if (app.isReady() && !activeHostConfiguration?.policies.hiddenWindow) {
      dialog.showErrorBox("DiffDash could not start", message)
    }
    app.quit()
  })
  app.on("window-all-closed", () => {
    if (activeHostConfiguration?.application.platform !== "darwin") app.quit()
  })
}
