import type { AppUpdateState } from "@diffdash/protocol/app-update"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { Effect } from "effect"
import { AppUpdater } from "../../../../src/main/services/app-updater"
import type { ApplicationRuntime } from "../../application-runtime"
import { createShutdown } from "../../shutdown"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines updates IPC handler implementations. */
export const defineUpdateHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
  shutdown: ReturnType<typeof createShutdown>,
) => {
  const run = runtime.runPromise

  handlers.define(InvokeChannel.updatesGetState, async (): Promise<AppUpdateState> => {
    const updater = await run(AppUpdater)
    return run(updater.state)
  })

  handlers.define(InvokeChannel.updatesCheck, async (): Promise<void> => {
    const updater = await run(AppUpdater)
    return run(updater.check)
  })

  handlers.define(InvokeChannel.updatesDownload, async (): Promise<void> => {
    const updater = await run(AppUpdater)
    return run(updater.download)
  })

  handlers.define(InvokeChannel.updatesRestartAndInstall, async (): Promise<void> => {
    const updater = await run(AppUpdater)
    await shutdown.restartAndInstall(() => Effect.runPromise(updater.quitAndInstall))
  })
}

/** Registers update handlers with Electron. */
export const installUpdatesController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.updatesGetState,
    InvokeChannel.updatesCheck,
    InvokeChannel.updatesDownload,
    InvokeChannel.updatesRestartAndInstall,
  ])
