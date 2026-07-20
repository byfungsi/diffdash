import { Repo } from "@diffdash/domain/repository"
import type { AppUpdateState } from "@diffdash/protocol/app-update"
import { AppUpdateFailed, AppUpdateIdle } from "@diffdash/protocol/app-update"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { OpenWorkingTreeCommand } from "@diffdash/protocol/cli-navigation"
import type { InvokeRequest } from "@diffdash/protocol/ipc"
import {
  encodeFailureEnvelopeWithinBudget,
  FailureEnvelope,
  InvokeContract,
  invokeResponseSchema,
  successEnvelope,
} from "@diffdash/protocol/ipc"
import { jsonSafeUtf8ByteLength } from "@diffdash/protocol/payload-budget"
import {
  TransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Schema } from "effect"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import { RepositoryLinkError } from "../src/main/services/repository-linker"
import type { ApplicationRuntime } from "./main/application-runtime"
import { createRendererSecurityPolicy } from "./main/electron-policy"
import { defineIpcHandlers } from "./main/ipc/controllers"
import { IpcControllerRegistry } from "./main/ipc/controllers/controller-registry"
import { sendProtocolEvent } from "./main/ipc/transport"
import { createShutdown } from "./main/shutdown"
import type { RendererIpc } from "./preload/transport"
import { createRendererTransport } from "./preload/transport"

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn<IpcMain["handle"]>() } }))

describe("IPC contract", () => {
  it("has one schema contract for every protocol-owned invoke channel", () => {
    expect(Object.keys(InvokeContract)).toEqual(Object.values(InvokeChannel))
  })

  it("defines and installs every application handler exactly once", () => {
    const host = hostIpc()
    const rendererSecurityPolicy = testRendererSecurityPolicy()
    const registry = new IpcControllerRegistry(rendererSecurityPolicy, host.api)
    const runtime: ApplicationRuntime = {
      dispose: async () => undefined,
      runPromise: async () => {
        throw new Error("Completeness test must not invoke handlers")
      },
    }
    const shutdown = createShutdown({ dispose: runtime.dispose, quit: vi.fn<() => void>() })

    defineIpcHandlers(
      runtime,
      registry,
      { peek: () => [], acknowledge: () => undefined },
      rendererSecurityPolicy,
      shutdown,
    )
    registry.install()

    expect([...host.installed.keys()]).toEqual(Object.values(InvokeChannel))
    expect(host.handle).toHaveBeenCalledTimes(Object.values(InvokeChannel).length)
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

  it("rejects oversized encoded renderer requests before invoking Electron", async () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)

    await expect(
      transport.invoke(InvokeChannel.appOpenExternalUrl, { url: "x".repeat(300_000) }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" })
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

  it("rejects oversized raw host responses before deep schema decoding", async () => {
    const transport = createRendererTransport(
      rendererIpc({ _tag: "Success", value: "x".repeat(2_100_000) }).api,
    )

    await expect(transport.invoke(InvokeChannel.updatesGetState, {})).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    })
  })

  it("does not expose arbitrary ipcRenderer rejection details", async () => {
    const ipc = rendererIpc()
    ipc.invoke.mockRejectedValueOnce(
      new Error("spawn failed in /Users/example/private-repository: raw stderr"),
    )
    const transport = createRendererTransport(ipc.api)

    await expect(transport.invoke(InvokeChannel.analyticsStart, {})).rejects.toMatchObject({
      code: "IPC_FAILURE",
      message: `${InvokeChannel.analyticsStart} failed: ${UNKNOWN_TRANSPORT_ERROR_MESSAGE}`,
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

  it("accepts a failure envelope at the exact preload response boundary and rejects one byte over", async () => {
    const budget = InvokeContract[InvokeChannel.analyticsStart].maxResponseBytes
    const baseError = TransportError.make({
      code: "EXPECTED_FAILURE",
      message: "Safe failure",
      operation: "",
    })
    const base = Schema.encodeSync(FailureEnvelope)({ _tag: "Failure", error: baseError })
    const operation = "x".repeat(budget - jsonSafeUtf8ByteLength(base))
    const exact = Schema.encodeSync(FailureEnvelope)({
      _tag: "Failure",
      error: TransportError.make({ code: "EXPECTED_FAILURE", message: "Safe failure", operation }),
    })
    expect(jsonSafeUtf8ByteLength(exact)).toBe(budget)

    await expect(
      createRendererTransport(rendererIpc(exact).api).invoke(InvokeChannel.analyticsStart, {}),
    ).rejects.toMatchObject({ code: "EXPECTED_FAILURE" })
    const oneByteOver = {
      ...exact,
      error: { ...exact.error, operation: `${operation}x` },
    }
    await expect(
      createRendererTransport(rendererIpc(oneByteOver).api).invoke(
        InvokeChannel.analyticsStart,
        {},
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" })
  })

  it("decodes events, ignores malformed payloads, and removes the exact listener", () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)
    const listener = vi.fn<(state: AppUpdateState) => void>()
    const cleanup = transport.subscribe(EventChannel.updateStateChanged, listener)
    const wrapped = ipc.listeners.get(EventChannel.updateStateChanged)

    expect(wrapped).toBeDefined()
    wrapped?.({}, { _tag: "idle", currentVersion: 3 })
    wrapped?.({}, { _tag: "failed", currentVersion: "0.3.1", message: "x".repeat(300_000) })
    wrapped?.({}, { _tag: "idle", currentVersion: "0.3.1" })
    cleanup()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(AppUpdateIdle.make({ currentVersion: "0.3.1" }))
    expect(ipc.removeListener).toHaveBeenCalledWith(EventChannel.updateStateChanged, wrapped)
  })

  it("returns a structured failure for malformed requests received by main", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsCapture,
    ])
    const controller = vi.fn<
      (
        event: IpcMainInvokeEvent,
        request: InvokeRequest<typeof InvokeChannel.analyticsCapture>,
      ) => Promise<void>
    >(async () => undefined)
    registry.define(InvokeChannel.analyticsCapture, controller)
    registry.install()

    const response = await host.handler?.(trustedEvent(), { event: { event: "unknown" } })
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("INVALID_REQUEST")
    expect(controller).not.toHaveBeenCalled()
  })

  it("rejects oversized raw main requests before invoking the controller", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.appOpenExternalUrl,
    ])
    const controller = vi.fn<
      (
        event: IpcMainInvokeEvent,
        request: InvokeRequest<typeof InvokeChannel.appOpenExternalUrl>,
      ) => Promise<void>
    >(async () => undefined)
    registry.define(InvokeChannel.appOpenExternalUrl, controller)
    registry.install()

    const response = await host.handler?.(trustedEvent(), { url: "x".repeat(300_000) })
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("PAYLOAD_TOO_LARGE")
    expect(controller).not.toHaveBeenCalled()
  })

  it("blocks subframes and untrusted origins before privileged behavior", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsStart,
    ])
    const controller = vi.fn<
      (
        event: IpcMainInvokeEvent,
        request: InvokeRequest<typeof InvokeChannel.analyticsStart>,
      ) => Promise<void>
    >(async () => undefined)
    registry.define(InvokeChannel.analyticsStart, controller)
    registry.install()

    const response = await host.handler?.(trustedEvent("https://attacker.example"), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("FORBIDDEN_SENDER")
    expect(controller).not.toHaveBeenCalled()
  })

  it("converts invalid controller results into structured response errors", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.updatesGetState,
    ])
    registry.define(InvokeChannel.updatesGetState, async () => {
      // SAFETY: The deliberate cast simulates a compromised or regressed privileged handler.
      return { _tag: "idle", currentVersion: 3 } as unknown as AppUpdateIdle
    })
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("INVALID_RESPONSE")
  })

  it("does not commit a navigation drain when response encoding rejects the batch", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.drainNavigationCommands,
    ])
    const commands = Array.from({ length: 33 }, (_, index) =>
      OpenWorkingTreeCommand.make({ localPath: `/repo-${index}` }),
    )
    const commit = vi.fn<() => void>()
    registry.defineTransactional(InvokeChannel.drainNavigationCommands, async () => ({
      response: commands,
      commit,
    }))
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("INVALID_RESPONSE")
    expect(commit).not.toHaveBeenCalled()
  })

  it("preserves typed recoverable controller failures", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsStart,
    ])
    registry.define(InvokeChannel.analyticsStart, async () => {
      throw transportError("EXPECTED_FAILURE", "Safe failure detail")
    })
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error).toMatchObject({
      code: "EXPECTED_FAILURE",
      message: "Safe failure detail",
      operation: InvokeChannel.analyticsStart,
    })
  })

  it("redacts unknown controller errors before encoding the failure envelope", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsStart,
    ])
    registry.define(InvokeChannel.analyticsStart, async () => {
      throw new Error("failed at /Users/example/private-repository with raw stderr")
    })
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
    })
  })

  it("returns a structured failure when an encoded controller response exceeds its budget", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.listRepositories,
    ])
    const repositories = Array.from({ length: 20 }, (_, index) =>
      Repo.make({
        id: `repo-${index}`,
        provider: "local",
        owner: "local",
        name: `repo-${index}`,
        remoteUrl: `file:///${"x".repeat(150_000)}`,
        localPath: `/repo-${index}`,
        isFavorite: false,
        lastOpenedAt: null,
        lastSyncedAt: null,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
      }),
    )
    registry.define(InvokeChannel.listRepositories, async () => repositories)
    registry.install()

    const response = await host.handler?.(trustedEvent(), { query: null })
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("PAYLOAD_TOO_LARGE")
  })

  it("rejects oversized encoded events before Electron send", () => {
    const send = vi.fn<(channel: string, payload: unknown) => void>()

    expect(() =>
      sendProtocolEvent(
        { send },
        EventChannel.updateStateChanged,
        AppUpdateFailed.make({ currentVersion: "0.3.1", message: "x".repeat(300_000) }),
      ),
    ).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }))
    expect(send).not.toHaveBeenCalled()
  })

  it("keeps bounded sanitized reasons from explicitly safe domain errors", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsStart,
    ])
    registry.define(InvokeChannel.analyticsStart, async () => {
      throw RepositoryLinkError.make({
        operation: "link",
        reason: `Checkout mismatch\n${"x".repeat(600)}`,
        cause: new Error(`private cause ${"secret".repeat(500_000)}`),
      })
    })
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error.code).toBe("RepositoryLinkError")
    expect(envelope.error.message).not.toContain("\n")
    expect(envelope.error.message).toHaveLength(500)
    expect(envelope.error.message).not.toContain("private cause")
  })

  it("replaces an oversized public failure diagnostic with the bounded fallback", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsStart,
    ])
    registry.define(InvokeChannel.analyticsStart, async () => {
      throw TransportError.make({
        code: "EXPECTED_FAILURE",
        message: "Safe failure detail",
        operation: "diagnostic".repeat(300_000),
      })
    })
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: "IPC response exceeded its byte limit.",
    })
    expect(envelope.error.operation).toBeUndefined()
    expect(jsonSafeUtf8ByteLength(response)).toBeLessThanOrEqual(
      InvokeContract[InvokeChannel.analyticsStart].maxResponseBytes,
    )
  })

  it("preserves an exact-boundary failure and falls back one byte below it", () => {
    const error = TransportError.make({
      code: "EXPECTED_FAILURE",
      message: "Safe failure detail",
      operation: "x".repeat(1_000),
    })
    const encoded = Schema.encodeSync(FailureEnvelope)({ _tag: "Failure", error })
    const exactBytes = jsonSafeUtf8ByteLength(encoded)

    expect(encodeFailureEnvelopeWithinBudget(error, exactBytes)).toEqual(encoded)
    const fallback = encodeFailureEnvelopeWithinBudget(error, exactBytes - 1)
    expect(Schema.decodeUnknownSync(FailureEnvelope)(fallback).error.code).toBe("PAYLOAD_TOO_LARGE")
    expect(jsonSafeUtf8ByteLength(fallback)).toBeLessThanOrEqual(exactBytes - 1)
  })

  it("rejects incomplete, duplicate, and repeated controller installation", () => {
    const incomplete = new IpcControllerRegistry(testRendererSecurityPolicy(), hostIpc().api, [
      InvokeChannel.analyticsStart,
      InvokeChannel.analyticsCapture,
    ])
    incomplete.define(InvokeChannel.analyticsStart, async () => undefined)
    expect(() => incomplete.install()).toThrow("missing: analytics:capture")

    const duplicate = new IpcControllerRegistry(testRendererSecurityPolicy(), hostIpc().api, [
      InvokeChannel.analyticsStart,
    ])
    duplicate.define(InvokeChannel.analyticsStart, async () => undefined)
    expect(() => duplicate.define(InvokeChannel.analyticsStart, async () => undefined)).toThrow(
      "Duplicate IPC handler",
    )
    duplicate.install()
    expect(() => duplicate.install()).toThrow("already installed")
  })

  it("encodes successful controller responses", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.updatesGetState,
    ])
    registry.define(InvokeChannel.updatesGetState, async () =>
      AppUpdateIdle.make({ currentVersion: "0.3.1" }),
    )
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(
      successEnvelope(invokeResponseSchema(InvokeChannel.updatesGetState)),
    )(response)

    expect(envelope.value).toEqual(AppUpdateIdle.make({ currentVersion: "0.3.1" }))
  })

  it("encodes successful void responses as JSON null", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsCapture,
    ])
    registry.define(InvokeChannel.analyticsCapture, async () => undefined)
    registry.install()

    const response = await host.handler?.(trustedEvent(), {
      event: { event: "review_opened", reviewType: "pull_request" },
    })
    const envelope = Schema.decodeUnknownSync(
      successEnvelope(invokeResponseSchema(InvokeChannel.analyticsCapture)),
    )(response)

    expect(response).toEqual({ _tag: "Success", value: null })
    expect(envelope.value).toBeUndefined()
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
  const installed = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const handle = vi.fn<Pick<IpcMain, "handle">["handle"]>(
    (_channel: string, registered: Parameters<IpcMain["handle"]>[1]) => {
      handler = registered
      installed.set(_channel, registered)
    },
  )
  const api = {
    handle,
  }
  return {
    api,
    handle,
    installed,
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

const testRendererSecurityPolicy = () =>
  createRendererSecurityPolicy({
    developmentRendererUrl: "http://localhost:5173",
    isPackaged: false,
    isTrustedWebContents: () => true,
    openExternal: async () => undefined,
    packagedRendererUrl: "file:///app/renderer/index.html",
  })
