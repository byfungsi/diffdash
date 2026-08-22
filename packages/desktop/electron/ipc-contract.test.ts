import { AgentProviderId } from "@diffdash/domain/agent-provider"
import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent-provider-id"
import { WebUrl } from "@diffdash/domain/web-url"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { ReviewKey, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import { CoreReviewSessionFailure } from "@diffdash/core-rpc/review-session"
import { ListOpenCodeSessionsRequest } from "@diffdash/protocol/ai-connection"
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
import type { BridgeResult } from "@diffdash/protocol/ipc"
import { jsonSafeUtf8ByteLength } from "@diffdash/protocol/payload-budget"
import { WalkthroughStartBridgeResult } from "@diffdash/protocol/walkthrough-operation"
import {
  WalkthroughCancelBridgeResult,
  WalkthroughGetOperationBridgeFailure,
  WalkthroughGetOperationBridgeResult,
  WalkthroughGetStoredBridgeResult,
  WalkthroughOperationBridgeHint,
} from "@diffdash/protocol/walkthrough-operation-state"
import {
  TransportError,
  TransportErrorDiagnosticTrace,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "@diffdash/protocol/transport-error"
import { Effect, Schema } from "effect"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import { CoreMethod, CoreMethodChannel, RepositoryLinkError } from "@diffdash/core"
import type { DesktopUpdater } from "../src/main/services/app-updater"
import type { ApplicationRuntime } from "./main/application-runtime"
import { createRendererSecurityPolicy } from "./main/electron-policy"
import {
  makeDesktopHostConfiguration,
  productionDesktopStartupConfiguration,
  RendererEntry,
} from "./main/desktop-host-configuration"
import { defineIpcHandlers } from "./main/ipc/controllers"
import { IpcControllerRegistry } from "./main/ipc/controllers/controller-registry"
import { sendProtocolEvent } from "./main/ipc/transport"
import { createShutdown } from "./main/shutdown"
import type { RendererIpc } from "./preload/transport"
import { createRendererTransport } from "./preload/transport"

describe("IPC contract", () => {
  it("has one schema contract for every protocol-owned invoke channel", () => {
    expect(Object.keys(InvokeContract)).toEqual(Object.values(InvokeChannel))
  })

  it("maps every Core method to one unique protocol invoke channel", () => {
    expect(Object.keys(CoreMethodChannel)).toEqual(Object.values(CoreMethod))
    expect(new Set(Object.values(CoreMethodChannel)).size).toBe(Object.values(CoreMethod).length)
    expect(Object.values(CoreMethodChannel).every((channel) => channel in InvokeContract)).toBe(
      true,
    )
  })

  it("defines and installs every application handler exactly once", () => {
    const host = hostIpc()
    const rendererSecurityPolicy = testRendererSecurityPolicy()
    const registry = new IpcControllerRegistry(rendererSecurityPolicy, host.api)
    const runtime = testRuntime("Completeness test must not invoke handlers")
    const shutdown = createShutdown({ dispose: runtime.dispose, quit: vi.fn<() => void>() })

    defineIpcHandlers(
      runtime,
      testUpdater(),
      registry,
      { peek: () => [], acknowledge: () => undefined },
      rendererSecurityPolicy,
      shutdown,
      testHostConfiguration(),
    )
    registry.install()

    expect([...host.installed.keys()]).toEqual(Object.values(InvokeChannel))
    expect(host.handle).toHaveBeenCalledTimes(Object.values(InvokeChannel).length)
  })

  it("forwards durable walkthrough commands once and relays correlated hints", async () => {
    const host = hostIpc()
    const rendererSecurityPolicy = testRendererSecurityPolicy()
    const registry = new IpcControllerRegistry(rendererSecurityPolicy, host.api)
    const baseRuntime = testRuntime("Walkthrough operation test must not invoke other handlers")
    const accepted = Schema.decodeUnknownSync(WalkthroughStartBridgeResult)({
      _tag: "Success",
      value: {
        applicationInstanceId: "app-ipc",
        processEpoch: "epoch-ipc",
        requestId: "h:start-ipc",
        operationId: "operation-ipc",
        stateVersion: 1,
        created: true,
      },
    })
    const getError = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeFailure)({
      _tag: "WalkthroughPublicFailure",
      applicationInstanceId: "app-ipc",
      processEpoch: "epoch-ipc",
      requestId: "h:get-ipc",
      method: "Walkthroughs.getOperation",
      operationId: "operation-ipc",
      code: "WALKTHROUGH_OPERATION_NOT_FOUND",
      providerId: null,
      modelId: null,
      retryClass: "notRetryable",
      remediation: "none",
      safeMessage: "The walkthrough operation no longer exists.",
      attempts: [],
      diagnostic: null,
    })
    const getFailure = Schema.decodeUnknownSync(WalkthroughGetOperationBridgeResult)({
      _tag: "Failure",
      error: getError,
    })
    const cancelFailure = Schema.decodeUnknownSync(WalkthroughCancelBridgeResult)({
      _tag: "Failure",
      error: { ...getError, requestId: "h:cancel-ipc", method: "Walkthroughs.cancel" },
    })
    const stored = Schema.decodeUnknownSync(WalkthroughGetStoredBridgeResult)({
      _tag: "Success",
      value: { status: "notFound" },
    })
    const hint = Schema.decodeUnknownSync(WalkthroughOperationBridgeHint)({
      applicationInstanceId: "app-ipc",
      processEpoch: "epoch-ipc",
      sequence: 2,
      operationId: "operation-ipc",
      stateVersion: 3,
      kind: "operationTerminal",
    })
    const start = vi.fn<ApplicationRuntime["walkthroughOperations"]["start"]>(async () => accepted)
    const getOperation = vi.fn<ApplicationRuntime["walkthroughOperations"]["getOperation"]>(
      async () => getFailure,
    )
    const cancel = vi.fn<ApplicationRuntime["walkthroughOperations"]["cancel"]>(
      async () => cancelFailure,
    )
    const getStored = vi.fn<ApplicationRuntime["walkthroughOperations"]["getStored"]>(
      async () => stored,
    )
    const replayHints = vi.fn<ApplicationRuntime["walkthroughOperations"]["replayHints"]>(
      async () => [hint],
    )
    const runtime: ApplicationRuntime = {
      ...baseRuntime,
      walkthroughOperations: { start, getOperation, cancel, getStored, replayHints },
    }
    defineIpcHandlers(
      runtime,
      testUpdater(),
      registry,
      { peek: () => [], acknowledge: () => undefined },
      rendererSecurityPolicy,
      createShutdown({ dispose: runtime.dispose, quit: vi.fn<() => void>() }),
      testHostConfiguration(),
    )
    registry.install()
    const event = trustedEvent()
    const startRequest = {
      target: { kind: "local", rootPath: "/workspace/repo", comparison: { _tag: "workingTree" } },
      regenerate: false,
      idempotencyKey: "w:renderer-retained-key",
    } as const

    const startHandler = host.installed.get(InvokeChannel.startWalkthroughOperation)
    await expect(startHandler?.(event, startRequest)).resolves.toMatchObject({
      _tag: "Success",
      value: { _tag: "Success", value: { created: true, stateVersion: 1 } },
    })
    await startHandler?.(event, startRequest)
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      "w:renderer-retained-key",
      "w:renderer-retained-key",
    ])
    expect(getOperation).not.toHaveBeenCalled()

    await host.installed.get(InvokeChannel.getWalkthroughOperation)?.(event, {
      operationId: "operation-ipc",
    })
    await host.installed.get(InvokeChannel.cancelWalkthroughOperation)?.(event, {
      operationId: "operation-ipc",
    })
    await host.installed.get(InvokeChannel.getStoredWalkthrough)?.(event, {
      target: startRequest.target,
    })
    expect(getOperation).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(getStored).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(replayHints).toHaveBeenCalledTimes(5))
    expect(event.sender.send).toHaveBeenCalledWith(
      EventChannel.walkthroughOperationHint,
      expect.objectContaining({ operationId: "operation-ipc", stateVersion: 3 }),
    )
  })

  it("forwards E2E lifecycle diagnostics through dedicated desktop channels", async () => {
    const host = hostIpc()
    const rendererSecurityPolicy = testRendererSecurityPolicy()
    const registry = new IpcControllerRegistry(rendererSecurityPolicy, host.api)
    const baseRuntime = testRuntime("E2E lifecycle test must not invoke other handlers")
    const lifecycle = {
      acquisitions: {
        activeOperationIds: [],
        started: 1,
        completed: 0,
        superseded: 1,
        drained: 1,
        failed: 0,
        lastStartedOperationId: "core:prior",
        lastSupersededOperationId: "core:prior",
        lastDrainedOperationId: "core:prior",
      },
      sessions: {
        activeSessionId: "session:replacement",
        opened: 2,
        disposed: 1,
        lastDisposedSessionId: "session:prior",
      },
    } as const
    const runtime: ApplicationRuntime = {
      ...baseRuntime,
      core: {
        ...baseRuntime.core,
        e2eReviewLifecycleDiagnostics: async () => lifecycle,
        e2eHoldNextReviewAcquisition: async () => ({ armed: true }),
      },
    }
    const shutdown = createShutdown({ dispose: runtime.dispose, quit: vi.fn<() => void>() })
    defineIpcHandlers(
      runtime,
      testUpdater(),
      registry,
      { peek: () => [], acknowledge: () => undefined },
      rendererSecurityPolicy,
      shutdown,
      testHostConfiguration(),
    )
    registry.install()

    const diagnosticsHandler = host.installed.get(InvokeChannel.e2eReviewLifecycleDiagnostics)
    const holdHandler = host.installed.get(InvokeChannel.e2eHoldNextReviewAcquisition)
    if (diagnosticsHandler === undefined || holdHandler === undefined) {
      throw new Error("E2E lifecycle IPC handlers were not installed")
    }
    await expect(diagnosticsHandler(trustedEvent(), {})).resolves.toEqual({
      _tag: "Success",
      value: lifecycle,
    })
    await expect(holdHandler(trustedEvent(), {})).resolves.toEqual({
      _tag: "Success",
      value: { armed: true },
    })
  })

  it("exposes no unknown or prototype-named channels through the installed Electron router", () => {
    const host = hostIpc()
    const rendererSecurityPolicy = testRendererSecurityPolicy()
    const registry = new IpcControllerRegistry(rendererSecurityPolicy, host.api)
    const runtime = testRuntime("Unknown channel test must not invoke handlers")
    const shutdown = createShutdown({ dispose: runtime.dispose, quit: vi.fn<() => void>() })

    defineIpcHandlers(
      runtime,
      testUpdater(),
      registry,
      { peek: () => [], acknowledge: () => undefined },
      rendererSecurityPolicy,
      shutdown,
      testHostConfiguration(),
    )
    registry.install()

    for (const channel of [
      "repositories:deleteEverything",
      "updates:rawUpdater",
      "toString",
      "constructor",
      "__proto__",
    ]) {
      expect(host.installed.has(channel)).toBe(false)
    }
  })

  it("rejects malformed renderer requests before invoking Electron", async () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)
    // SAFETY: The deliberate cast injects an untrusted runtime value into the typed boundary.
    const malformed = { event: { event: "not-an-analytics-event" } } as unknown as InvokeRequest<
      typeof InvokeChannel.analyticsCapture
    >

    await expectTransportError(transport.invoke(InvokeChannel.analyticsCapture, malformed), {
      code: "INVALID_REQUEST",
    })
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it("normalizes class values cloned by contextBridge before encoding requests", async () => {
    const encodedSettings = Schema.encodeSync(AISettings)(DEFAULT_AI_SETTINGS)
    const ipc = rendererIpc({ _tag: "Success", value: encodedSettings })
    const transport = createRendererTransport(ipc.api)

    const result = await transport.invoke(InvokeChannel.settingsUpdate, {
      settings: structuredClone(DEFAULT_AI_SETTINGS),
    })

    expect(result._tag).toBe("Success")
    expect(ipc.invoke).toHaveBeenCalledWith(InvokeChannel.settingsUpdate, {
      settings: encodedSettings,
    })
  })

  it("normalizes a cloned OpenCode session request with an optional search", async () => {
    const ipc = rendererIpc({ _tag: "Success", value: [] })
    const transport = createRendererTransport(ipc.api)
    const request = ListOpenCodeSessionsRequest.make({
      projectId: ReviewProjectId.make("project"),
      search: null,
    })

    const result = await transport.invoke(
      InvokeChannel.aiListOpenCodeSessions,
      structuredClone(request),
    )

    expect(result).toMatchObject({ _tag: "Success" })
    expect(ipc.invoke).toHaveBeenCalledWith(InvokeChannel.aiListOpenCodeSessions, {
      projectId: "project",
      search: null,
    })
  })

  it("rejects oversized encoded renderer requests before invoking Electron", async () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)

    await expectTransportError(
      transport.invoke(InvokeChannel.appOpenExternalUrl, {
        url: WebUrl.make(`https://example.com/${"x".repeat(300_000)}`),
      }),
      { code: "PAYLOAD_TOO_LARGE" },
    )
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it("rejects malformed host responses", async () => {
    expect.hasAssertions()
    const ipc = rendererIpc({ _tag: "Success", value: { currentVersion: 42 } })
    const transport = createRendererTransport(ipc.api)

    await expectTransportError(transport.invoke(InvokeChannel.updatesGetState, {}), {
      _tag: "TransportError",
      code: "INVALID_RESPONSE",
    })
  })

  it("rejects oversized raw host responses before deep schema decoding", async () => {
    expect.hasAssertions()
    const transport = createRendererTransport(
      rendererIpc({ _tag: "Success", value: "x".repeat(2_100_000) }).api,
    )

    await expectTransportError(transport.invoke(InvokeChannel.updatesGetState, {}), {
      code: "PAYLOAD_TOO_LARGE",
    })
  })

  it("does not expose arbitrary ipcRenderer rejection details", async () => {
    expect.hasAssertions()
    const ipc = rendererIpc()
    ipc.invoke.mockRejectedValueOnce(
      new Error("spawn failed in /Users/example/private-repository: raw stderr"),
    )
    const transport = createRendererTransport(ipc.api)

    await expectTransportError(transport.invoke(InvokeChannel.analyticsStart, {}), {
      code: "IPC_FAILURE",
      message: `${InvokeChannel.analyticsStart} failed: ${UNKNOWN_TRANSPORT_ERROR_MESSAGE}`,
    })
  })

  it("preserves schema-decoded failure envelopes without reconstruction", async () => {
    const providerFailure = AgentProviderFailure.make({
      version: 1,
      providerId: ReviewAgentProviderId.make("claude"),
      capability: "walkthrough",
      category: "authentication",
      processKind: "exit",
      exitCode: 9,
      signal: null,
      httpStatus: null,
      retryAfterSeconds: null,
      resetsAt: null,
    })
    const diagnostic = TransportErrorDiagnosticTrace.make({
      provider: AgentProviderId.make("claude"),
      errorTag: "AgentProviderAuthenticationError",
      causeTag: "ProcessExitError",
      exitCode: 9,
      signal: null,
      reason: "Authentication or authorization failure reported.",
      stderr: "Provider diagnostics were redacted.",
      stackFrames: ["at runWalkthrough"],
    })
    const failure = Schema.encodeSync(FailureEnvelope)({
      _tag: "Failure",
      error: transportError(
        "AgentProviderAuthenticationError",
        "Authentication is required.",
        "Walkthroughs.start",
        diagnostic,
        providerFailure,
      ),
    })
    const transport = createRendererTransport(rendererIpc(failure).api)

    const result = await transport.invoke(InvokeChannel.selectLocalFolder, {})

    expect(result._tag === "Failure" ? result.error : null).not.toBeInstanceOf(Error)
    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        code: "AgentProviderAuthenticationError",
        message: "Authentication is required.",
        operation: "Walkthroughs.start",
        diagnostic,
        providerFailure,
      },
    })
  })

  it("accepts a failure envelope at the exact preload response boundary and rejects one byte over", async () => {
    const budget = InvokeContract[InvokeChannel.analyticsStart].maxResponseBytes
    const baseError = TransportError.make({
      code: "EXPECTED_FAILURE",
      message: "",
      operation: DiagnosticOperation.make("boundary"),
    })
    const base = Schema.encodeSync(FailureEnvelope)({ _tag: "Failure", error: baseError })
    const message = "x".repeat(budget - jsonSafeUtf8ByteLength(base))
    const exact = Schema.encodeSync(FailureEnvelope)({
      _tag: "Failure",
      error: TransportError.make({
        code: "EXPECTED_FAILURE",
        message,
        operation: DiagnosticOperation.make("boundary"),
      }),
    })
    expect(jsonSafeUtf8ByteLength(exact)).toBe(budget)

    await expectTransportError(
      createRendererTransport(rendererIpc(exact).api).invoke(InvokeChannel.analyticsStart, {}),
      { code: "EXPECTED_FAILURE" },
    )
    const oneByteOver = {
      ...exact,
      error: { ...exact.error, message: `${message}x` },
    }
    await expectTransportError(
      createRendererTransport(rendererIpc(oneByteOver).api).invoke(
        InvokeChannel.analyticsStart,
        {},
      ),
      { code: "PAYLOAD_TOO_LARGE" },
    )
  })

  it("decodes events, reports malformed and oversized payloads, and removes the exact listener", () => {
    const ipc = rendererIpc()
    const transport = createRendererTransport(ipc.api)
    const listener = vi.fn<(result: BridgeResult<AppUpdateState>) => void>()
    const cleanup = transport.subscribe(EventChannel.updateStateChanged, listener)
    const wrapped = ipc.listeners.get(EventChannel.updateStateChanged)

    expect(wrapped).toBeDefined()
    wrapped?.({}, { _tag: "idle", currentVersion: 3 })
    wrapped?.({}, { _tag: "failed", currentVersion: "0.3.1", message: "x".repeat(300_000) })
    wrapped?.({}, { _tag: "idle", currentVersion: "0.3.1" })
    cleanup()

    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      _tag: "Failure",
      error: { code: "INVALID_EVENT" },
    })
    expect(listener.mock.calls[1]?.[0]).toMatchObject({
      _tag: "Failure",
      error: { code: "PAYLOAD_TOO_LARGE" },
    })
    expect(listener.mock.calls[2]?.[0]).toEqual({
      _tag: "Success",
      value: AppUpdateIdle.make({ currentVersion: "0.3.1" }),
    })
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
      OpenWorkingTreeCommand.make({
        localPath: RepositoryCheckoutPath.make(`/repo-${index}`),
      }),
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

  it("maps typed progressive review failures to safe renderer diagnostics", async () => {
    const host = hostIpc()
    const rendererSecurityPolicy = testRendererSecurityPolicy()
    const registry = new IpcControllerRegistry(rendererSecurityPolicy, host.api)
    const baseRuntime = testRuntime("Progressive failure test must not invoke other handlers")
    const failure = CoreReviewSessionFailure.make({
      applicationInstanceId: ApplicationInstanceId.make("app"),
      processEpoch: CoreProcessEpoch.make("epoch"),
      requestId: HostRequestId.make("h:request"),
      method: "Reviews.openSession",
      code: "REVIEW_SNAPSHOT_NOT_FOUND",
      retryClass: "userAction",
      safeMessage: "The requested review snapshot no longer exists.",
    })
    const runtime: ApplicationRuntime = {
      ...baseRuntime,
      progressiveReviews: {
        ...baseRuntime.progressiveReviews,
        openSession: async () => Promise.reject(failure),
      },
    }
    const shutdown = createShutdown({ dispose: runtime.dispose, quit: vi.fn<() => void>() })
    defineIpcHandlers(
      runtime,
      testUpdater(),
      registry,
      { peek: () => [], acknowledge: () => undefined },
      rendererSecurityPolicy,
      shutdown,
      testHostConfiguration(),
    )
    registry.install()

    const response = await host.installed.get(InvokeChannel.openProgressiveReviewSession)?.(
      trustedEvent(),
      {
        projectId: ReviewProjectId.make("project"),
        reviewKey: ReviewKey.make("review"),
        snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
      },
    )
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error).toMatchObject({
      code: "REVIEW_SNAPSHOT_NOT_FOUND",
      message: "The requested review snapshot no longer exists.",
      operation: InvokeChannel.openProgressiveReviewSession,
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
        id: ReviewProjectId.make(`repo-${index}`),
        source: LocalRepositorySource.make(),
        checkout: LinkedCheckout.make({
          remoteUrl: `file:///${"x".repeat(150_000)}`,
          path: RepositoryCheckoutPath.make(`/repo-${index}`),
        }),
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
        { isDestroyed: () => false, send },
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
        operation: "persist",
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

  it("bounds an oversized public failure operation before encoding", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsStart,
    ])
    registry.define(InvokeChannel.analyticsStart, async () => {
      throw {
        _tag: "TransportError",
        code: "EXPECTED_FAILURE",
        message: "Safe failure detail",
        operation: "diagnostic".repeat(300_000),
      }
    })
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})
    const envelope = Schema.decodeUnknownSync(FailureEnvelope)(response)

    expect(envelope.error).toMatchObject({
      code: "EXPECTED_FAILURE",
      message: "Safe failure detail",
    })
    expect(envelope.error.operation).toHaveLength(200)
    expect(jsonSafeUtf8ByteLength(response)).toBeLessThanOrEqual(
      InvokeContract[InvokeChannel.analyticsStart].maxResponseBytes,
    )
  })

  it("preserves an exact-boundary failure and falls back one byte below it", () => {
    const error = TransportError.make({
      code: "EXPECTED_FAILURE",
      message: "x".repeat(1_000),
      operation: DiagnosticOperation.make("boundary"),
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

  it("normalizes class responses decoded by the external Core bundle", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.updatesGetState,
    ])
    registry.define(InvokeChannel.updatesGetState, async () =>
      structuredClone(AppUpdateIdle.make({ currentVersion: "0.3.1" })),
    )
    registry.install()

    const response = await host.handler?.(trustedEvent(), {})

    expect(response).toEqual({
      _tag: "Success",
      value: { _tag: "idle", currentVersion: "0.3.1" },
    })
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

  it("derives the invoke channel and forwards decoded input through defineCore", async () => {
    const host = hostIpc()
    const registry = new IpcControllerRegistry(testRendererSecurityPolicy(), host.api, [
      InvokeChannel.analyticsCapture,
    ])
    const execute = vi.fn<
      (input: InvokeRequest<typeof InvokeChannel.analyticsCapture>) => Promise<void>
    >(async (input: InvokeRequest<typeof InvokeChannel.analyticsCapture>): Promise<void> => {
      expect(input).toEqual({
        event: { event: "review_opened", reviewType: "pull_request" },
      })
    })
    registry.defineCore(CoreMethod.analyticsCapture, execute)
    registry.install()

    const response = await host.handler?.(trustedEvent(), {
      event: { event: "review_opened", reviewType: "pull_request" },
    })

    expect(host.installed.has(InvokeChannel.analyticsCapture)).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
    expect(response).toEqual({ _tag: "Success", value: null })
  })
})

const expectTransportError = async <Value>(
  promise: Promise<BridgeResult<Value>>,
  expected: object,
) => {
  const result = await promise
  expect(result).toMatchObject({ _tag: "Failure", error: expected })
}

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
      send: vi.fn<(channel: string, payload: object) => void>(),
    },
  }
  // SAFETY: This minimal Electron event fake supplies every property read by sender validation.
  return event as unknown as IpcMainInvokeEvent
}

const testRendererSecurityPolicy = () =>
  createRendererSecurityPolicy({
    isTrustedWebContents: () => true,
    openExternal: async () => undefined,
    rendererEntry: Schema.decodeUnknownSync(RendererEntry)({
      _tag: "DevelopmentRendererEntry",
      url: "http://localhost:5173",
    }),
  })

const testHostConfiguration = () =>
  Effect.runSync(
    makeDesktopHostConfiguration(
      {
        identity: {
          appName: "DiffDash Development",
          appUserModelId: "dev.diffdash.app.development",
          storageNamespace: "diffdash-development",
          userDataPath: "/tmp/diffdash-user-data",
        },
        version: "0.0.0",
        architecture: process.arch,
        platform: process.platform,
        packaged: false,
        resourcesPath: "/app/resources",
        temporaryDirectory: "/tmp",
        userDataDirectory: "/tmp/diffdash-user-data",
        environment: {},
        homeDirectory: "/home/test",
        moduleDirectory: "/app/out/main",
      },
      productionDesktopStartupConfiguration,
    ),
  )

const testUpdater = (): DesktopUpdater => ({
  getState: () => Effect.succeed(AppUpdateIdle.make({ currentVersion: "0.0.0" })),
  check: () => Effect.void,
  download: () => Effect.void,
  quitAndInstall: () => Effect.void,
  startAutomaticChecks: () => Effect.void,
  subscribe: () => Effect.succeed(() => undefined),
  dispose: () => Effect.void,
})

const testRuntime = (message: string): ApplicationRuntime => {
  const reject = async (): Promise<never> => {
    throw new Error(message)
  }
  return {
    start: async () => undefined,
    dispose: async () => undefined,
    core: {
      analyticsCapture: reject,
      analyticsStart: reject,
      agentProvidersGetCatalog: reject,
      appDiagnostics: reject,
      appInstallDiffDashCli: reject,
      appOpenLocalRepositoryFile: reject,
      appOpenRepositoryComparisonFile: reject,
      appOpenRepositoryFile: reject,
      appStateGet: reject,
      appStateUpdate: reject,
      e2eReviewLifecycleDiagnostics: reject,
      e2eHoldNextReviewAcquisition: reject,
      listProviders: reject,
      submitHostedReviewDecision: reject,
      getHostedReviewDecision: reject,
      listHostedReviews: reject,
      listAssignedHostedReviews: reject,
      listHostedRepositorySearchScopes: reject,
      searchHostedRepositories: reject,
      resolveLocalBranch: reject,
      resolveLastCommit: reject,
      resolveRepositoryComparison: reject,
      acquireHostedReviewSnapshot: reject,
      acquireLocalReviewSnapshot: reject,
      acquireRepositoryComparisonSnapshot: reject,
      favoriteRemoteRepository: reject,
      forgetRepository: reject,
      installRepository: reject,
      linkRepository: reject,
      openCodeWorkspace: reject,
      heartbeatCodeWorkspace: reject,
      releaseCodeWorkspace: reject,
      listCodeWorkspaceDirectory: reject,
      searchCodeWorkspace: reject,
      readCodeWorkspaceFile: reject,
      listRepositories: reject,
      openProject: reject,
      repairRepositoryIdentities: reject,
      resourceDiagnostics: reject,
      clearDisposableResources: reject,
      setRepositoryFavorite: reject,
      projectWorkspaceGet: reject,
      projectWorkspaceSave: reject,
      listOpenCodeSessions: reject,
      connectOpenCodeSession: reject,
      submitComment: reject,
      addReviewThreadUserMessage: reject,
      createReviewThread: reject,
      getReviewThread: reject,
      listReviewThreads: reject,
      runReviewThreadAgent: reject,
      settingsGet: reject,
      settingsUpdate: reject,
      listViewedFiles: reject,
      listLocalViewedFiles: reject,
      setViewedFile: reject,
      setLocalViewedFile: reject,
      listRepositoryComparisonViewedFiles: reject,
      setRepositoryComparisonViewedFile: reject,
    },
    walkthroughOperations: {
      start: reject,
      getOperation: reject,
      cancel: reject,
      getStored: reject,
      replayHints: reject,
    },
    progressiveReviews: {
      openSession: reject,
      currentSession: reject,
      closeSession: reject,
      inventory: reject,
      readRange: reject,
      waitForRange: reject,
      resolveTarget: reject,
      search: reject,
    },
  }
}
