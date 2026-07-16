import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { EventChannel } from "@diffdash/protocol/channels"
import { app, BrowserWindow, dialog, shell } from "electron"
import { electronErrorPageDataUrl } from "../error-page"
import { createDiffDashBrowserWindowOptions, isInternalNavigationAllowed } from "./electron-policy"
import { openAllowedExternalUrl } from "./file-opening"
import type { createNavigationCommandQueue } from "./navigation-command-queue"
import { applicationPaths } from "./paths"

type NavigationCommands = ReturnType<typeof createNavigationCommandQueue>

const serializeError = (error: unknown) =>
  error instanceof Error
    ? { message: error.message, name: error.name }
    : { message: String(error), name: "UnknownError" }

/** Creates and secures the main renderer window while preserving fallback behavior. */
export const createMainWindow = ({
  logStartupStage,
  navigationCommands,
  onClosed,
  revealWindow,
}: {
  readonly logStartupStage: (stage: string) => void
  readonly navigationCommands: NavigationCommands
  readonly onClosed: () => void
  readonly revealWindow: (window: BrowserWindow) => void
}) => {
  const window = new BrowserWindow(
    createDiffDashBrowserWindowOptions({
      iconPath: applicationPaths().developmentIconPath,
      preloadPath: join(__dirname, "../preload/index.mjs"),
    }),
  )
  logStartupStage("window created")

  let isWindowShown = false
  let showFallbackTimer: NodeJS.Timeout | null = null
  const showMainWindow = () => {
    if (isWindowShown) return
    isWindowShown = true
    if (showFallbackTimer !== null) clearTimeout(showFallbackTimer)
    revealWindow(window)
    logStartupStage(
      process.env.DIFFDASH_E2E_HIDDEN === "1" ? "window ready (hidden)" : "window shown",
    )
  }

  window.once("ready-to-show", showMainWindow)
  showFallbackTimer = setTimeout(showMainWindow, 2_000)
  showFallbackTimer.unref()

  const rendererUrl =
    process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(join(__dirname, "../renderer/index.html")).toString()
  let loadingErrorPage = false
  const showElectronError = (message: string) => {
    if (window.isDestroyed() || loadingErrorPage) return
    loadingErrorPage = true
    void window
      .loadURL(electronErrorPageDataUrl(message, rendererUrl))
      .then(() => showMainWindow())
      .catch((fallbackError: unknown) => {
        showMainWindow()
        dialog.showErrorBox(
          "DiffDash encountered an error",
          `${message}\n\n${serializeError(fallbackError).message}`,
        )
        app.quit()
      })
      .finally(() => {
        loadingErrorPage = false
      })
  }

  window.on("closed", () => {
    if (showFallbackTimer !== null) clearTimeout(showFallbackTimer)
    onClosed()
  })
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      const message = `Renderer failed to load (${errorCode}): ${errorDescription}\n${url}`
      console.error(`[renderer:load-failed] ${errorCode} ${errorDescription} ${url}`)
      showElectronError(message)
    },
  )
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${details.reason} ${details.exitCode}`)
    if (details.reason !== "clean-exit") {
      showElectronError(
        `The DiffDash renderer stopped unexpectedly (${details.reason}, exit ${details.exitCode}).`,
      )
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl((targetUrl) => shell.openExternal(targetUrl), url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (isInternalNavigationAllowed(url, window.webContents.getURL())) return
    event.preventDefault()
    void openAllowedExternalUrl((targetUrl) => shell.openExternal(targetUrl), url)
  })
  if (app.isPackaged) {
    window.webContents.on("devtools-opened", () => window.webContents.closeDevTools())
  }

  const loadWindow = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(process.env.ELECTRON_RENDERER_URL)
    : window.loadFile(join(__dirname, "../renderer/index.html"))
  void loadWindow
    .then(() => {
      logStartupStage("renderer loaded")
      showMainWindow()
      if (navigationCommands.hasPending()) {
        window.webContents.send(EventChannel.navigationCommandsAvailable)
      }
      return undefined
    })
    .catch((error: unknown) => {
      const message = serializeError(error).message
      console.error(`[renderer:load-error] ${message}`)
      showElectronError(message)
    })
  return window
}
