import { EventChannel } from "@diffdash/protocol/channels"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import type { BrowserWindow } from "electron"
import { sendProtocolEvent } from "./ipc/transport"
import { createNavigationCommandQueue } from "./navigation-command-queue"

/** Owns queued CLI navigation and renderer notification. */
export const createNavigation = ({
  activateWindow,
}: {
  readonly activateWindow: () => BrowserWindow | null
}) => {
  const commands = createNavigationCommandQueue()
  return {
    commands,
    enqueue: (command: CliNavigationCommand) => {
      commands.enqueue(command)
      const targetWindow = activateWindow()
      if (targetWindow === null || targetWindow.isDestroyed()) return
      if (targetWindow.webContents.isLoadingMainFrame()) return
      sendProtocolEvent(targetWindow.webContents, EventChannel.navigationCommandsAvailable, {})
    },
  }
}
