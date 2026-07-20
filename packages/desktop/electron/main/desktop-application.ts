import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, type BrowserWindow as BrowserWindowType, shell } from "electron"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { Effect } from "effect"
import { resolveApplicationIdentity } from "./application-identity"
import { createApplicationRuntime } from "./application-runtime"
import { createRendererSecurityPolicy } from "./electron-policy"
import type { RendererSecurityPolicy } from "./electron-policy"
import { installIpcControllers } from "./ipc/controllers"
import { createNavigation } from "./navigation"
import { applicationPaths } from "./paths"
import { installSingleInstanceHandling } from "./single-instance"
import { logStartupStage } from "./startup-logging"
import { createMainWindow } from "./window"
import { revealAppWindow } from "./window-activation"

logStartupStage("main module loaded")

const isHiddenE2EWindow = () => process.env.DIFFDASH_E2E_HIDDEN === "1"
const revealWindow = (targetWindow: BrowserWindowType) => {
  revealAppWindow(targetWindow, {
    hidden: isHiddenE2EWindow(),
    platform: process.platform,
    focusApplication: () => app.focus({ steal: true }),
  })
}

let mainWindow: BrowserWindowType | null = null
const getWindow = () => mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null
const navigation = createNavigation({ getWindow, revealWindow })

const configureApplicationIdentity = () => {
  const identity = resolveApplicationIdentity({
    appDataPath: app.getPath("appData"),
    explicitUserDataDirectory: app.commandLine.hasSwitch("user-data-dir"),
    packaged: app.isPackaged,
  })
  app.setAppUserModelId(identity.appUserModelId)
  app.setName(identity.appName)
  if (identity.userDataPath !== null) app.setPath("userData", identity.userDataPath)
}

const createWindow = (rendererSecurityPolicy: RendererSecurityPolicy) => {
  mainWindow = createMainWindow({
    logStartupStage,
    navigationCommands: navigation.commands,
    onClosed: () => {
      mainWindow = null
    },
    rendererSecurityPolicy,
    revealWindow,
  })
}

const start = async () => {
  if (process.platform === "darwin") {
    app.setActivationPolicy(isHiddenE2EWindow() ? "accessory" : "regular")
  }

  await app.whenReady()
  logStartupStage("electron ready")
  if (process.platform === "darwin" && !isHiddenE2EWindow()) {
    const developmentIconPath = applicationPaths().developmentIconPath
    if (developmentIconPath !== null) app.dock?.setIcon(developmentIconPath)
    app.dock?.show()
  }

  const rendererSecurityPolicy = createRendererSecurityPolicy({
    developmentRendererUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    isPackaged: app.isPackaged,
    isTrustedWebContents: (webContents) => webContents === mainWindow?.webContents,
    openExternal: (url) => shell.openExternal(url),
    packagedRendererUrl: pathToFileURL(join(__dirname, "../renderer/index.html")).href,
  })
  const applicationRuntime = createApplicationRuntime()
  await applicationRuntime.runPromise(
    Effect.flatMap(ReviewTurnStore, (turns) => turns.recoverInterruptedTurns),
  )
  installIpcControllers(applicationRuntime, navigation.commands, rendererSecurityPolicy)
  createWindow(rendererSecurityPolicy)
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(rendererSecurityPolicy)
  })
}

/** Starts Electron startup and top-level lifecycle handling. */
export const startDesktopApplication = () => {
  configureApplicationIdentity()
  const acquired = installSingleInstanceHandling({
    enqueue: navigation.enqueue,
    revealExistingWindow: () => {
      const targetWindow = getWindow()
      if (targetWindow !== null && !targetWindow.isDestroyed()) revealWindow(targetWindow)
    },
  })
  if (!acquired) {
    app.quit()
    return
  }

  void start()
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
