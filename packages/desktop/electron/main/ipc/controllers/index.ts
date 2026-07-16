import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { app } from "electron"
import type { ApplicationRuntime } from "../../application-runtime"
import { createShutdown } from "../../shutdown"
import { startUpdaterLifecycle } from "../../updater-lifecycle"
import { defineAnalyticsHandlers, installAnalyticsController } from "./analytics"
import { IpcControllerRegistry } from "./controller-registry"
import { defineNavigationHandlers, installNavigationController } from "./navigation"
import { defineRepositoryHandlers, installRepositoriesController } from "./repositories"
import { defineReviewHandlers, installReviewsController } from "./reviews"
import { defineSettingsHandlers, installSettingsController } from "./settings"
import { defineThreadHandlers, installThreadsController } from "./threads"
import { defineUpdateHandlers, installUpdatesController } from "./updates"
import { defineWalkthroughHandlers, installWalkthroughsController } from "./walkthroughs"

/** Defines and installs all domain IPC controllers at the application boundary. */
export const installIpcControllers = (
  runtime: ApplicationRuntime,
  navigationCommands: { readonly drain: () => readonly CliNavigationCommand[] },
) => {
  const handlers = new IpcControllerRegistry()
  const shutdown = createShutdown({ dispose: runtime.dispose, quit: () => app.quit() })
  app.on("before-quit", shutdown.beforeQuit)

  defineRepositoryHandlers(runtime, handlers)
  defineReviewHandlers(runtime, handlers)
  defineThreadHandlers(runtime, handlers)
  defineWalkthroughHandlers(runtime, handlers)
  defineSettingsHandlers(runtime, handlers)
  defineAnalyticsHandlers(runtime, handlers)
  defineUpdateHandlers(runtime, handlers, shutdown)
  defineNavigationHandlers(runtime, handlers, navigationCommands)

  installRepositoriesController(handlers)
  installReviewsController(handlers)
  installThreadsController(handlers)
  installWalkthroughsController(handlers)
  installSettingsController(handlers)
  installAnalyticsController(handlers)
  installUpdatesController(handlers)
  installNavigationController(handlers)
  handlers.assertComplete()
  startUpdaterLifecycle(runtime)
}
