import { AppUpdateIdle } from "@diffdash/protocol/app-update"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  FailureEnvelope,
  InvokeContract,
  successEnvelope,
  invokeResponseSchema,
} from "@diffdash/protocol/ipc"
import type { InvokeRequest } from "@diffdash/protocol/ipc"
import { TransportError, transportError } from "@diffdash/protocol/transport-error"
import { Schema } from "effect"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { IpcControllerRegistry } from "./main/ipc/controllers/controller-registry"
import { createRendererTransport } from "./preload/transport"
import type { RendererIpc } from "./preload/transport"

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn<IpcMain["handle"]>() } }))

describe("IPC contract", () => {
  beforeEach(() => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
  })

  it("has one schema contract for every protocol-owned invoke channel", () => {
    expect(Object.keys(InvokeContract)).toEqual(Object.values(InvokeChannel))
  })

  it("rejects malformed renderer requests before invoking Electron", async () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)
    // SAFETY: The deliberate cast injects an untrusted runtime value into the typed boundary.
    const malformed = { event: { event: "not-an-analytics-event" } } as unknown as InvokeRequest<
      typeof InvokeChannel.analyticsCapture
    >

    await expect(transport.invoke(InvokeChannel.analyticsCapture, malformed)).rejects.toMatchObject(
      {
        _tag: "TransportError",
        code: "INVALID_REQUEST",
      },
    )
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it("rejects malformed host responses", async () => {
    const ipc = rendererIpc({ _tag: "Success", value: { currentVersion: 42 } })
    const transport = createRendererTransport(ipc.api)

    await expect(transport.invoke(InvokeChannel.updatesGetState, {})).rejects.toMatchObject({
      _tag: "TransportError",
      code: "INVALID_RESPONSE",
    })
  })

  it("reconstructs structured recoverable errors from failure envelopes", async () => {
    const failure = Schema.encodeSync(FailureEnvelope)({
      _tag: "Failure",
      error: transportError("RepositoryLinkError", "Checkout does not match", "repositories:link"),
    })
    const transport = createRendererTransport(rendererIpc(failure).api)

    const error = await transport
      .invoke(InvokeChannel.selectLocalFolder, {})
      .catch((cause) => cause)

    expect(error).toBeInstanceOf(TransportError)
    expect(error).toMatchObject({
      code: "RepositoryLinkError",
      message: "repositories:selectLocalFolder failed: Checkout does not match",
      operation: "repositories:link",
    })
  })

  it("decodes events, ignores malformed payloads, and removes the exact listener", () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)
    const listener = vi.fn<(state: AppUpdateState) => void>()
    const cleanup = transport.subscribe(EventChannel.updateStateChanged, listener)
    const wrapped = ipc.listeners.get(EventChannel.updateStateChanged)

    expect(wrapped).toBeDefined()
    wrapped?.({}, { _tag: "idle", currentVersion: 3 })
    wrapped?.({}, { _tag: "idle", currentVersion: "0.3.1" })
    cleanup()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(AppUpdateIdle.make({ currentVersion: "0.3.1" }))
    expect(ipc.removeListener).toHaveBeenCalledWith(EventChannel.updateStateChanged, wrapped)
  })

  it("returns a structured failure for malformed requests received by main", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(host.api)
    const controller = vi.fn<
      (
        event: IpcMainInvokeEvent,
        request: InvokeRequest<typeof InvokeChannel.analyticsCapture>,
      ) => Promise<void>
    >(async () => undefined)
    registry.define(InvokeChannel.analyticsCapture, controller)
    registry.install([InvokeChannel.analyticsCapture])

    const response = await host.handler?.(trustedEvent(), { event: { event: "unknown" } })
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("INVALID_REQUEST")
    expect(controller).not.toHaveBeenCalled()
  })

  it("blocks subframes and untrusted origins before privileged behavior", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(host.api)
    const controller = vi.fn<
      (
        event: IpcMainInvokeEvent,
        request: InvokeRequest<typeof InvokeChannel.analyticsStart>,
      ) => Promise<void>
    >(async () => undefined)
    registry.define(InvokeChannel.analyticsStart, controller)
    registry.install([InvokeChannel.analyticsStart])

    const response = await host.handler?.(trustedEvent("https://attacker.example"), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("FORBIDDEN_SENDER")
    expect(controller).not.toHaveBeenCalled()
  })

  it("converts invalid controller results into structured response errors", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(host.api)
    registry.define(InvokeChannel.updatesGetState, async () => {
      // SAFETY: The deliberate cast simulates a compromised or regressed privileged handler.
      return { _tag: "idle", currentVersion: 3 } as unknown as AppUpdateIdle
    })
    registry.install([InvokeChannel.updatesGetState])

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("INVALID_RESPONSE")
  })

  it("preserves typed recoverable controller failures", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(host.api)
    registry.define(InvokeChannel.analyticsStart, async () => {
      throw transportError("EXPECTED_FAILURE", "Safe failure detail")
    })
    registry.install([InvokeChannel.analyticsStart])

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error).toMatchObject({
      code: "EXPECTED_FAILURE",
      message: "Safe failure detail",
      operation: InvokeChannel.analyticsStart,
    })
  })

  it("encodes successful controller responses", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(host.api)
    registry.define(InvokeChannel.updatesGetState, async () =>
      AppUpdateIdle.make({ currentVersion: "0.3.1" }),
    )
    registry.install([InvokeChannel.updatesGetState])

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(
      successEnvelope(invokeResponseSchema(InvokeChannel.updatesGetState)),
    )(response)

    expect(envelope.value).toEqual(AppUpdateIdle.make({ currentVersion: "0.3.1" }))
  })
})

const rendererIpc = (response: unknown = undefined) => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>(
    async () => response,
  )
  const removeListener = vi.fn<
    (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  >((channel: string, listener: (event: unknown, payload: unknown) => void) => {
    if (listeners.get(channel) === listener) listeners.delete(channel)
  })
  const api: RendererIpc = {
    invoke,
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener,
  }
  return { api, invoke, listeners, removeListener }
}

const hostIpc = () => {
  let handler: Parameters<IpcMain["handle"]>[1] | undefined
  const api = {
    handle: (_channel: string, installed: Parameters<IpcMain["handle"]>[1]) => {
      handler = installed
    },
  }
  return {
    api,
    get handler() {
      return handler
    },
  }
}

const trustedEvent = (url = "http://localhost:5173/") => {
  const frame = { url }
  const event = {
    senderFrame: frame,
    sender: {
      mainFrame: frame,
      isDestroyed: () => false,
      getURL: () => url,
    },
  }
  // SAFETY: This minimal Electron event fake supplies every property read by sender validation.
  return event as unknown as IpcMainInvokeEvent
}
