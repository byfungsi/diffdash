import { InvokeChannel } from "@diffdash/protocol/channels"
import type { InvokeRequest, InvokeResponse } from "@diffdash/protocol/ipc"
import {
  FailureEnvelope,
  invokeRequestSchema,
  invokeResponseSchema,
  successEnvelope,
} from "@diffdash/protocol/ipc"
import { toTransportError, transportError } from "@diffdash/protocol/transport-error"
import { Schema } from "effect"
import { ipcMain } from "electron"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { isTrustedIpcSender } from "../transport"

type InvokeHandler = Parameters<typeof ipcMain.handle>[1]
type ControllerHandler<Channel extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  request: InvokeRequest<Channel>,
) => Promise<InvokeResponse<Channel>>

/** Collects handler implementations before domain controllers register them with Electron. */
export class IpcControllerRegistry {
  readonly #handlers = new Map<string, InvokeHandler>()
  readonly #installed = new Set<string>()
  readonly #ipc: Pick<IpcMain, "handle">

  constructor(ipc: Pick<IpcMain, "handle"> = ipcMain) {
    this.#ipc = ipc
  }

  readonly define = <Channel extends InvokeChannel>(
    channel: Channel,
    handler: ControllerHandler<Channel>,
  ) => {
    if (this.#handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`)
    this.#handlers.set(channel, async (event, rawRequest) => {
      if (!isTrustedIpcSender(event)) {
        return encodeFailure(
          transportError(
            "FORBIDDEN_SENDER",
            "IPC request did not originate from DiffDash",
            channel,
          ),
        )
      }

      let request: InvokeRequest<Channel>
      try {
        request = Schema.decodeUnknownSync(invokeRequestSchema(channel))(rawRequest)
      } catch {
        return encodeFailure(
          transportError("INVALID_REQUEST", `Invalid request for ${channel}`, channel),
        )
      }

      let response: InvokeResponse<Channel>
      try {
        response = await handler(event, request)
      } catch (error) {
        return encodeFailure(toTransportError(error, channel))
      }

      try {
        return Schema.encodeUnknownSync(successEnvelope(invokeResponseSchema(channel)))({
          _tag: "Success",
          value: response,
        })
      } catch {
        return encodeFailure(
          transportError("INVALID_RESPONSE", `Invalid response for ${channel}`, channel),
        )
      }
    })
  }

  readonly install = (channels: readonly string[]) => {
    for (const channel of channels) {
      const handler = this.#handlers.get(channel)
      if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`)
      if (this.#installed.has(channel))
        throw new Error(`Duplicate IPC controller channel: ${channel}`)
      this.#ipc.handle(channel, handler)
      this.#installed.add(channel)
    }
  }

  readonly assertComplete = () => {
    if (this.#installed.size !== Object.keys(InvokeChannel).length) {
      throw new Error("IPC controllers do not match the protocol contract")
    }
  }
}

const encodeFailure = (error: ReturnType<typeof transportError>) =>
  Schema.encodeSync(FailureEnvelope)({ _tag: "Failure", error })
