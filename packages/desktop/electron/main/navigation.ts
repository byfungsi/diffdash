import { EventChannel } from "@diffdash/protocol/channels"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import type { BrowserWindow } from "electron"
import { createNavigationCommandQueue } from "./navigation-command-queue"

/** Owns queued CLI navigation and renderer notification. */
export const createNavigation = ({
  getWindow,
  revealWindow,
}: {
  readonly getWindow: () => BrowserWindow | null
  readonly revealWindow: (window: BrowserWindow) => void
}) => {
  const commands = createNavigationCommandQueue()
  return {
    commands,
    enqueue: (command: CliNavigationCommand) => {
      commands.enqueue(command)
      const targetWindow = getWindow()
      if (targetWindow === null || targetWindow.isDestroyed()) return
      revealWindow(targetWindow)
      targetWindow.webContents.send(EventChannel.navigationCommandsAvailable)
    },
  }
}
