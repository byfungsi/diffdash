import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import type { DesktopUpdater } from "../../../../src/main/services/app-updater"
import type { ApplicationRuntime } from "../../application-runtime"
import type { DesktopHostConfiguration } from "../../desktop-host-configuration"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { createShutdown } from "../../shutdown"
import { electronUpdaterLifecycleHost, startUpdaterLifecycle } from "../../updater-lifecycle"
import { defineAnalyticsHandlers } from "./analytics"
import { defineAIHandlers } from "./ai"
import { defineCommentNoteHandlers } from "./comment-notes"
import { IpcControllerRegistry } from "./controller-registry"
import { defineNavigationHandlers } from "./navigation"
import { defineProjectWorkspaceHandlers } from "./project-workspace"
import { defineRepositoryHandlers } from "./repositories"
import { defineReviewHandlers } from "./reviews"
import { defineSettingsHandlers } from "./settings"
import { defineThreadHandlers } from "./threads"
import { defineUpdateHandlers } from "./updates"
import { defineWalkthroughHandlers } from "./walkthroughs"
import { installCodeWorkspaceFileStreamController } from "./code-workspace-file-stream"

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
  configuration: DesktopHostConfiguration,
) => {
  defineAIHandlers(runtime, handlers)
  defineCommentNoteHandlers(runtime, handlers)
  defineRepositoryHandlers(runtime, handlers)
  defineProjectWorkspaceHandlers(runtime, handlers)
  defineReviewHandlers(runtime, handlers)
  defineThreadHandlers(runtime, handlers)
  defineWalkthroughHandlers(runtime, handlers)
  defineSettingsHandlers(runtime, handlers, configuration)
  defineAnalyticsHandlers(runtime, handlers)
  defineUpdateHandlers(updater, handlers, shutdown)
  defineNavigationHandlers(
    runtime,
    handlers,
    navigationCommands,
    rendererSecurityPolicy,
    configuration,
  )
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
  shutdown: ReturnType<typeof createShutdown>,
  configuration: DesktopHostConfiguration,
) => {
  const handlers = new IpcControllerRegistry(rendererSecurityPolicy)
  defineIpcHandlers(
    runtime,
    updater,
    handlers,
    navigationCommands,
    rendererSecurityPolicy,
    shutdown,
    configuration,
  )
  handlers.install()
  installCodeWorkspaceFileStreamController(runtime, rendererSecurityPolicy)
  startUpdaterLifecycle(
    updater,
    electronUpdaterLifecycleHost,
    configuration.policies.updatesDisabled,
  )
}
