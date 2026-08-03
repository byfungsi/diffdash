import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  app,
  BrowserWindow,
  type BrowserWindow as BrowserWindowType,
  dialog,
  shell,
} from "electron"
import { ReviewTurnStore } from "@diffdash/persistence/review-turn-store"
import { Effect } from "effect"
import { RepositoryLinker } from "../../src/main/services/repository-linker"
import { resolveApplicationIdentity } from "./application-identity"
import { createApplicationRuntime } from "./application-runtime"
import { hasRepositoryIdentityRepairCommand } from "./cli-navigation"
import { createRendererSecurityPolicy } from "./electron-policy"
import type { RendererSecurityPolicy } from "./electron-policy"
import { installIpcControllers } from "./ipc/controllers"
import { createNavigation } from "./navigation"
import { applicationPaths } from "./paths"
import { installSingleInstanceHandling } from "./single-instance"
import { logStartupStage } from "./startup-logging"
import { createMainWindow } from "./window"
import { isHiddenE2EWindow, revealAppWindow } from "./window-activation"

logStartupStage("main module loaded")

const revealWindow = (targetWindow: BrowserWindowType) => {
  revealAppWindow(targetWindow, {
    hidden: isHiddenE2EWindow(),
    platform: process.platform,
    focusApplication: () => app.focus({ steal: true }),
  })
}

let mainWindow: BrowserWindowType | null = null
let activeRendererSecurityPolicy: RendererSecurityPolicy | null = null
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
  return mainWindow
}

const activateMainWindow = () => {
  const targetWindow = getWindow()
  if (targetWindow !== null && !targetWindow.isDestroyed()) {
    revealWindow(targetWindow)
    return targetWindow
  }
  if (activeRendererSecurityPolicy === null) return null
  return createWindow(activeRendererSecurityPolicy)
}

const navigation = createNavigation({ activateWindow: activateMainWindow })

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
  activeRendererSecurityPolicy = rendererSecurityPolicy
  const shouldRepairOnStartup = !hasRepositoryIdentityRepairCommand(navigation.commands.peek())
  activateMainWindow()
  if (shouldRepairOnStartup) {
    void applicationRuntime
      .runPromise(
        Effect.flatMap(RepositoryLinker, (repositories) => repositories.repairIdentities()),
      )
      .then((result) => {
        console.info(
          `[repositories:repair] resolved=${result.resolvedCount} unresolved=${result.unresolvedCount} localAliases=${result.localAliasCount}`,
        )
        return undefined
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[repositories:repair] ${message}`)
      })
  }
  app.on("activate", () => {
    activateMainWindow()
  })
}

/** Starts Electron startup and top-level lifecycle handling. */
export const startDesktopApplication = () => {
  configureApplicationIdentity()
  const acquired = installSingleInstanceHandling({
    enqueue: navigation.enqueue,
    revealExistingWindow: activateMainWindow,
  })
  if (!acquired) {
    app.quit()
    return
  }

  void start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[startup:failed] ${message}`)
    if (app.isReady() && !isHiddenE2EWindow()) {
      dialog.showErrorBox("DiffDash could not start", message)
    }
    app.quit()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
