import { EventChannel } from "@diffdash/protocol/channels"
import { Predicate } from "effect"
import { app, BrowserWindow, dialog } from "electron"
import { electronErrorPageDataUrl } from "../error-page"
import {
  createDiffDashBrowserWindowOptions,
  createRendererNavigationHandlers,
} from "./electron-policy"
import type { RendererSecurityPolicy } from "./electron-policy"
import { sendProtocolEvent } from "./ipc/transport"
import type { createNavigationCommandQueue } from "./navigation-command-queue"
import type { DesktopHostConfiguration } from "./desktop-host-configuration"

type NavigationCommands = ReturnType<typeof createNavigationCommandQueue>

const serializeError = <A>(error: A) =>
  Predicate.isError(error)
    ? { message: error.message, name: error.name }
    : { message: String(error), name: "UnknownError" }

/** Creates and secures the main renderer window while preserving fallback behavior. */
export const createMainWindow = ({
  configuration,
  logStartupStage,
  navigationCommands,
  onClosed,
  onRendererLoaded,
  onRendererLoading,
  rendererSecurityPolicy,
  revealWindow,
}: {
  readonly configuration: DesktopHostConfiguration
  readonly logStartupStage: (stage: string) => void
  readonly navigationCommands: NavigationCommands
  readonly onClosed: () => void
  readonly onRendererLoaded: () => void
  readonly onRendererLoading: () => void
  readonly rendererSecurityPolicy: RendererSecurityPolicy
  readonly revealWindow: (window: BrowserWindow) => void
}) => {
  const window = new BrowserWindow(
    createDiffDashBrowserWindowOptions({
      iconPath: configuration.paths.developmentIconPath,
      preloadPath: configuration.paths.preloadPath,
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
    logStartupStage(configuration.policies.hiddenWindow ? "window ready (hidden)" : "window shown")
  }

  window.once("ready-to-show", showMainWindow)
  showFallbackTimer = setTimeout(showMainWindow, 2_000)
  showFallbackTimer.unref()

  const rendererUrl = rendererSecurityPolicy.rendererEntryUrl
  let loadingErrorPage = false
  let initialLoadCompleted = false
  const showElectronError = (message: string) => {
    if (window.isDestroyed() || loadingErrorPage) return
    loadingErrorPage = true
    void window
      .loadURL(electronErrorPageDataUrl(message, rendererUrl))
      .then(() => showMainWindow())
      .catch((fallbackError) => {
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
  window.webContents.on("did-start-loading", onRendererLoading)
  window.webContents.on("did-finish-load", () => {
    if (initialLoadCompleted && window.webContents.getURL() === rendererUrl) onRendererLoaded()
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
    onRendererLoading()
    console.error(`[renderer:gone] ${details.reason} ${details.exitCode}`)
    if (details.reason !== "clean-exit") {
      showElectronError(
        `The DiffDash renderer stopped unexpectedly (${details.reason}, exit ${details.exitCode}).`,
      )
    }
  })
  const rendererNavigation = createRendererNavigationHandlers(rendererSecurityPolicy)
  window.webContents.setWindowOpenHandler(({ url }) => rendererNavigation.handleWindowOpen(url))
  window.webContents.on("will-navigate", rendererNavigation.handleNavigation)
  window.webContents.on("will-redirect", rendererNavigation.handleNavigation)
  if (configuration.application.packaged) {
    window.webContents.on("devtools-opened", () => window.webContents.closeDevTools())
  }

  void window
    .loadURL(rendererUrl)
    .then(() => {
      logStartupStage("renderer loaded")
      showMainWindow()
      if (navigationCommands.hasPending()) {
        sendProtocolEvent(window.webContents, EventChannel.navigationCommandsAvailable, {})
      }
      initialLoadCompleted = true
      onRendererLoaded()
      return undefined
    })
    .catch((error) => {
      const message = serializeError(error).message
      console.error(`[renderer:load-error] ${message}`)
      showElectronError(message)
    })
  return window
}
