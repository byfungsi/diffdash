import { EventChannel } from "@diffdash/protocol/channels"
import { BrowserWindow } from "electron"
import { Effect } from "effect"
import type { DesktopUpdater } from "../../src/main/services/app-updater"
import { sendProtocolEvent } from "./ipc/transport"

type RendererTarget = Parameters<typeof sendProtocolEvent>[0]

/** Electron host capability that discovers renderer targets for updater broadcasts. */
export interface UpdaterLifecycleHost {
  readonly getRendererTargets: () => ReadonlyArray<RendererTarget>
}

/** Production updater lifecycle host backed by Electron's current windows. */
export const electronUpdaterLifecycleHost: UpdaterLifecycleHost = {
  getRendererTargets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
}

/** Starts desktop-owned update checks and publishes updater state to renderer windows. */
export const startUpdaterLifecycle = (
  updater: DesktopUpdater,
  host: UpdaterLifecycleHost,
  disabled = false,
): void => {
  if (disabled) return
  void Effect.runPromise(
    Effect.gen(function* () {
      yield* updater.subscribe((state) => {
        for (const target of host.getRendererTargets()) {
          sendProtocolEvent(target, EventChannel.updateStateChanged, state)
        }
      })
      yield* updater.startAutomaticChecks()
    }),
  )
}
