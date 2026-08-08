import { EventChannel } from "@diffdash/protocol/channels"
import { BrowserWindow } from "electron"
import { Effect } from "effect"
import type { DesktopUpdater } from "../../src/main/services/app-updater"
import { sendProtocolEvent } from "./ipc/transport"

/** Starts desktop-owned update checks and publishes updater state to renderer windows. */
export const startUpdaterLifecycle = (updater: DesktopUpdater): void => {
  if (process.env.DIFFDASH_E2E_DISABLE_UPDATES === "1") return
  void Effect.runPromise(
    Effect.gen(function* () {
      yield* updater.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          sendProtocolEvent(window.webContents, EventChannel.updateStateChanged, state)
        }
      })
      yield* updater.startAutomaticChecks()
    }),
  )
}
