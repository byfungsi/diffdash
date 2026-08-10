import type { AppUpdateState } from "@diffdash/protocol/app-update"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { Effect, Match } from "effect"
import type { DesktopUpdater } from "../../../../src/main/services/app-updater"
import { createShutdown } from "../../shutdown"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines updates IPC handler implementations. */
export const defineUpdateHandlers = (
  updater: DesktopUpdater,
  handlers: IpcControllerRegistry,
  shutdown: ReturnType<typeof createShutdown>,
): void => {
  handlers.define(InvokeChannel.updatesGetState, async (): Promise<AppUpdateState> => {
    return Effect.runPromise(updater.getState())
  })

  handlers.define(InvokeChannel.updatesCheck, async (): Promise<void> => {
    return Effect.runPromise(updater.check())
  })

  handlers.define(InvokeChannel.updatesDownload, async (): Promise<void> => {
    return Effect.runPromise(updater.download())
  })

  handlers.define(InvokeChannel.updatesRestartAndInstall, async (): Promise<void> => {
    const state = await Effect.runPromise(updater.getState())
    if (
      Match.valueTags(state, {
        unsupported: () => true,
        idle: () => true,
        checking: () => true,
        available: () => true,
        downloading: () => true,
        downloaded: () => false,
        error: () => true,
      })
    ) {
      await Effect.runPromise(updater.quitAndInstall())
      return
    }
    await shutdown.restartAndInstall(() => Effect.runPromise(updater.quitAndInstall()))
  })
}
