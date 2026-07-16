import { InvokeChannel } from "@diffdash/protocol/channels"
import { ipcMain } from "electron"

type InvokeHandler = Parameters<typeof ipcMain.handle>[1]

/** Collects handler implementations before domain controllers register them with Electron. */
export class IpcControllerRegistry {
  readonly #handlers = new Map<string, InvokeHandler>()
  readonly #installed = new Set<string>()

  readonly define = (channel: string, handler: InvokeHandler) => {
    if (this.#handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`)
    this.#handlers.set(channel, handler)
  }

  readonly install = (channels: readonly string[]) => {
    for (const channel of channels) {
      const handler = this.#handlers.get(channel)
      if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`)
      if (this.#installed.has(channel))
        throw new Error(`Duplicate IPC controller channel: ${channel}`)
      ipcMain.handle(channel, handler)
      this.#installed.add(channel)
    }
  }

  readonly assertComplete = () => {
    if (this.#installed.size !== Object.keys(InvokeChannel).length) {
      throw new Error("IPC controllers do not match the protocol contract")
    }
  }
}
