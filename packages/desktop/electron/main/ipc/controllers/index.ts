import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { app } from "electron"
import type { ApplicationRuntime } from "../../application-runtime"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { createShutdown } from "../../shutdown"
import { startUpdaterLifecycle } from "../../updater-lifecycle"
import { defineAnalyticsHandlers } from "./analytics"
import { IpcControllerRegistry } from "./controller-registry"
import { defineNavigationHandlers } from "./navigation"
import { defineRepositoryHandlers } from "./repositories"
import { defineReviewHandlers } from "./reviews"
import { defineSettingsHandlers } from "./settings"
import { defineThreadHandlers } from "./threads"
import { defineUpdateHandlers } from "./updates"
import { defineWalkthroughHandlers } from "./walkthroughs"

/** Defines the complete protocol handler set before one atomic registry installation. */
export const defineIpcHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
  navigationCommands: {
    readonly peek: () => readonly CliNavigationCommand[]
    readonly acknowledge: (count: number) => void
  },
  rendererSecurityPolicy: RendererSecurityPolicy,
  shutdown: ReturnType<typeof createShutdown>,
) => {
  defineRepositoryHandlers(runtime, handlers)
  defineReviewHandlers(runtime, handlers)
  defineThreadHandlers(runtime, handlers)
  defineWalkthroughHandlers(runtime, handlers)
  defineSettingsHandlers(runtime, handlers)
  defineAnalyticsHandlers(runtime, handlers)
  defineUpdateHandlers(runtime, handlers, shutdown)
  defineNavigationHandlers(runtime, handlers, navigationCommands, rendererSecurityPolicy)
}

/** Defines and installs all domain IPC controllers at the application boundary. */
export const installIpcControllers = (
  runtime: ApplicationRuntime,
  navigationCommands: {
    readonly peek: () => readonly CliNavigationCommand[]
    readonly acknowledge: (count: number) => void
  },
  rendererSecurityPolicy: RendererSecurityPolicy,
) => {
  const handlers = new IpcControllerRegistry(rendererSecurityPolicy)
  const shutdown = createShutdown({ dispose: runtime.dispose, quit: () => app.quit() })
  app.on("before-quit", shutdown.beforeQuit)

  defineIpcHandlers(runtime, handlers, navigationCommands, rendererSecurityPolicy, shutdown)
  handlers.install()
  startUpdaterLifecycle(runtime)
}
