import { app, BrowserWindow, type BrowserWindow as BrowserWindowType } from "electron"
import { createApplicationRuntime } from "./application-runtime"
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

const createWindow = () => {
  mainWindow = createMainWindow({
    logStartupStage,
    navigationCommands: navigation.commands,
    onClosed: () => {
      mainWindow = null
    },
    revealWindow,
  })
}

const start = async () => {
  app.setAppUserModelId("dev.diffdash.app")
  if (process.platform === "darwin") {
    app.setName("DiffDash")
    app.setActivationPolicy(isHiddenE2EWindow() ? "accessory" : "regular")
  }

  await app.whenReady()
  logStartupStage("electron ready")
  if (process.platform === "darwin" && !isHiddenE2EWindow()) {
    const developmentIconPath = applicationPaths().developmentIconPath
    if (developmentIconPath !== null) app.dock?.setIcon(developmentIconPath)
    app.dock?.show()
  }

  installIpcControllers(createApplicationRuntime(), navigation.commands)
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/** Starts Electron startup and top-level lifecycle handling. */
export const startDesktopApplication = () => {
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
