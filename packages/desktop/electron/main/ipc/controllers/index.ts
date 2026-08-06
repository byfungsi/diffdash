import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { app } from "electron"
import type { DesktopUpdater } from "../../../../src/main/services/app-updater"
import { disposeApplicationResources } from "../../application-resources"
import type { ApplicationRuntime } from "../../application-runtime"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { createShutdown } from "../../shutdown"
import { startUpdaterLifecycle } from "../../updater-lifecycle"
import { defineAnalyticsHandlers } from "./analytics"
import { IpcControllerRegistry } from "./controller-registry"
import { defineNavigationHandlers } from "./navigation"
import { defineProjectWorkspaceHandlers } from "./project-workspace"
import { defineRepositoryHandlers } from "./repositories"
import { defineReviewHandlers } from "./reviews"
import { defineSettingsHandlers } from "./settings"
import { defineThreadHandlers } from "./threads"
import { defineUpdateHandlers } from "./updates"
import { defineWalkthroughHandlers } from "./walkthroughs"

/** Defines the complete protocol handler set before one atomic registry installation. */
export const defineIpcHandlers = (
  runtime: ApplicationRuntime,
  updater: DesktopUpdater,
  handlers: IpcControllerRegistry,
  navigationCommands: {
    readonly peek: () => readonly CliNavigationCommand[]
    readonly acknowledge: (count: number) => void
  },
  rendererSecurityPolicy: RendererSecurityPolicy,
  shutdown: ReturnType<typeof createShutdown>,
) => {
  defineRepositoryHandlers(runtime, handlers)
  defineProjectWorkspaceHandlers(runtime, handlers)
  defineReviewHandlers(runtime, handlers)
  defineThreadHandlers(runtime, handlers)
  defineWalkthroughHandlers(runtime, handlers)
  defineSettingsHandlers(runtime, handlers)
  defineAnalyticsHandlers(runtime, handlers)
  defineUpdateHandlers(updater, handlers, shutdown)
  defineNavigationHandlers(runtime, handlers, navigationCommands, rendererSecurityPolicy)
}

/** Defines and installs all domain IPC controllers at the application boundary. */
export const installIpcControllers = (
  runtime: ApplicationRuntime,
  updater: DesktopUpdater,
  navigationCommands: {
    readonly peek: () => readonly CliNavigationCommand[]
    readonly acknowledge: (count: number) => void
  },
  rendererSecurityPolicy: RendererSecurityPolicy,
) => {
  const handlers = new IpcControllerRegistry(rendererSecurityPolicy)
  const shutdown = createShutdown({
    dispose: () => disposeApplicationResources(updater, runtime),
    quit: () => app.quit(),
  })
  app.on("before-quit", shutdown.beforeQuit)

  defineIpcHandlers(
    runtime,
    updater,
    handlers,
    navigationCommands,
    rendererSecurityPolicy,
    shutdown,
  )
  handlers.install()
  startUpdaterLifecycle(updater)
}
