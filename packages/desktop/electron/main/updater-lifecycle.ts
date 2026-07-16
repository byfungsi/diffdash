import { EventChannel } from "@diffdash/protocol/channels"
import { BrowserWindow } from "electron"
import { Effect } from "effect"
import { AppUpdater } from "../../src/main/services/app-updater"
import type { ApplicationRuntime } from "./application-runtime"

/** Starts desktop-owned update checks and publishes updater state to renderer windows. */
export const startUpdaterLifecycle = (runtime: ApplicationRuntime) => {
  void runtime.runPromise(
    Effect.gen(function* () {
      const updater = yield* AppUpdater
      yield* updater.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(EventChannel.updateStateChanged, state)
        }
      })
      yield* updater.startAutomaticChecks
    }),
  )
}
