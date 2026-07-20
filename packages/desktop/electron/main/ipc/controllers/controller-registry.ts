import { InvokeChannel } from "@diffdash/protocol/channels"
import type { InvokeRequest, InvokeResponse } from "@diffdash/protocol/ipc"
import {
  encodeFailureEnvelopeWithinBudget,
  InvokeContract,
  invokeRequestSchema,
  invokeResponseSchema,
  successEnvelope,
} from "@diffdash/protocol/ipc"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import { TransportError, transportError } from "@diffdash/protocol/transport-error"
import { Schema } from "effect"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { ipcMain } from "electron"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { toPublicIpcError } from "../public-error"

type InvokeHandler = Parameters<typeof ipcMain.handle>[1]
type ControllerHandler<Channel extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  request: InvokeRequest<Channel>,
) => Promise<InvokeResponse<Channel>>

/** Response prepared transactionally and committed only after successful boundary encoding. */
interface TransactionalControllerResponse<Response> {
  readonly response: Response
  readonly commit: () => void
}

/** Collects handler implementations before domain controllers register them with Electron. */
export class IpcControllerRegistry {
  readonly #handlers = new Map<InvokeChannel, InvokeHandler>()
  readonly #ipc: Pick<IpcMain, "handle">
  readonly #expectedChannels: readonly InvokeChannel[]
  readonly #rendererSecurityPolicy: RendererSecurityPolicy
  #installed = false

  constructor(
    rendererSecurityPolicy: RendererSecurityPolicy,
    ipc: Pick<IpcMain, "handle"> = ipcMain,
    expectedChannels: readonly InvokeChannel[] = Object.values(InvokeChannel),
  ) {
    this.#rendererSecurityPolicy = rendererSecurityPolicy
    this.#ipc = ipc
    this.#expectedChannels = expectedChannels
  }

  readonly define = <Channel extends InvokeChannel>(
    channel: Channel,
    handler: ControllerHandler<Channel>,
  ) => {
    this.#define(channel, async (event, request) => ({
      response: await handler(event, request),
      commit: null,
    }))
  }

  /** Defines a handler whose state mutation occurs only after its response passes encoding. */
  readonly defineTransactional = <Channel extends InvokeChannel>(
    channel: Channel,
    handler: (
      event: IpcMainInvokeEvent,
      request: InvokeRequest<Channel>,
    ) => Promise<TransactionalControllerResponse<InvokeResponse<Channel>>>,
  ) => {
    this.#define(channel, handler)
  }

  readonly #define = <Channel extends InvokeChannel>(
    channel: Channel,
    handler: (
      event: IpcMainInvokeEvent,
      request: InvokeRequest<Channel>,
    ) => Promise<{
      readonly response: InvokeResponse<Channel>
      readonly commit: (() => void) | null
    }>,
  ) => {
    if (this.#handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`)
    this.#handlers.set(channel, async (event, rawRequest) => {
      const encodeFailure = (error: TransportError) =>
        encodeFailureEnvelopeWithinBudget(error, InvokeContract[channel].maxResponseBytes)
      if (!this.#rendererSecurityPolicy.isTrustedIpcSender(event)) {
        return encodeFailure(
          transportError(
            "FORBIDDEN_SENDER",
            "IPC request did not originate from DiffDash",
            channel,
          ),
        )
      }

      try {
        assertJsonPayloadWithinBudget(rawRequest, InvokeContract[channel].maxRequestBytes, channel)
      } catch (error) {
        return encodeFailure(
          error instanceof TransportError
            ? error
            : transportError("INVALID_REQUEST", `Invalid request for ${channel}`, channel),
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

      let prepared: {
        readonly response: InvokeResponse<Channel>
        readonly commit: (() => void) | null
      }
      try {
        prepared = await handler(event, request)
      } catch (error) {
        return encodeFailure(toPublicIpcError(error, channel))
      }

      try {
        const encoded = Schema.encodeUnknownSync(successEnvelope(invokeResponseSchema(channel)))({
          _tag: "Success",
          value: prepared.response,
        })
        assertJsonPayloadWithinBudget(encoded, InvokeContract[channel].maxResponseBytes, channel)
        prepared.commit?.()
        return encoded
      } catch (error) {
        if (error instanceof TransportError) return encodeFailure(error)
        return encodeFailure(
          transportError("INVALID_RESPONSE", `Invalid response for ${channel}`, channel),
        )
      }
    })
  }

  readonly install = () => {
    if (this.#installed) throw new Error("IPC controllers are already installed")

    const expected = new Set(this.#expectedChannels)
    const missing = this.#expectedChannels.filter((channel) => !this.#handlers.has(channel))
    const unexpected = [...this.#handlers.keys()].filter((channel) => !expected.has(channel))
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `IPC controllers do not match the protocol contract (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
      )
    }

    this.#installed = true
    for (const channel of this.#expectedChannels) {
      const handler = this.#handlers.get(channel)
      if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`)
      this.#ipc.handle(channel, handler)
    }
  }
}
