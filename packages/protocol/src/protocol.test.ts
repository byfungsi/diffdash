import { describe, expect, it } from "@effect/vitest"
import { AgentProviderId } from "@diffdash/agent-provider"
import { Result, Schema } from "effect"

import { EventChannel, InvokeChannel } from "./channels"
import { HostedRepositorySearchRequest, HostedReviewRequest } from "./hosted-git"
import {
  EventContract,
  getEventContract,
  getInvokeContract,
  InvokeContract,
  MINIMUM_FAILURE_ENVELOPE_BYTES,
} from "./ipc"
import { AddReviewThreadUserMessageRequest, RunReviewThreadAgentRequest } from "./review-threads"
import {
  bridgeTransportError,
  decodeTransportError,
  hasBridgeTransportErrorEncoding,
  isTransientTransportError,
  safeTransportErrorMessage,
  TransportError,
  TransportErrorDiagnosticTrace,
  toTransportError,
  transportError,
  UNKNOWN_TRANSPORT_ERROR_MESSAGE,
} from "./transport-error"
import { SetHostedViewedFileRequest, SetLocalViewedFileRequest } from "./viewed-files"

describe("protocol boundaries", () => {
  it("owns unique invoke and event channel names", () => {
    const invokeChannels = Object.values(InvokeChannel)
    const eventChannels = Object.values(EventChannel)

    expect(new Set(invokeChannels).size).toBe(61)
    expect(new Set(eventChannels).size).toBe(3)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(64)
    expect(invokeChannels).not.toEqual(
      expect.arrayContaining([
        "repositories:addLocal",
        "hostedReviews:get",
        "hostedReviews:refresh",
        "hostedReviews:getDiff",
        "hostedReviews:getSnapshot",
        "localReviews:getDetail",
        "localReviews:getDiff",
        "localReviews:getSnapshot",
      ]),
    )
  })

  it("owns positive safe-integer byte budgets on every contract entry", () => {
    for (const contract of Object.values(InvokeContract)) {
      expect(Number.isSafeInteger(contract.maxRequestBytes)).toBe(true)
      expect(contract.maxRequestBytes).toBeGreaterThan(0)
      expect(Number.isSafeInteger(contract.maxResponseBytes)).toBe(true)
      expect(contract.maxResponseBytes).toBeGreaterThanOrEqual(MINIMUM_FAILURE_ENVELOPE_BYTES)
    }
    for (const contract of Object.values(EventContract)) {
      expect(Number.isSafeInteger(contract.maxPayloadBytes)).toBe(true)
      expect(contract.maxPayloadBytes).toBeGreaterThan(0)
    }
  })

  it("validates project opening and workspace identities at the IPC boundary", () => {
    const opening = Schema.decodeUnknownResult(InvokeContract[InvokeChannel.openProject].request)({
      localPath: "/workspace/diffdash",
      selectedRepository: {
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      },
    })
    const ambiguous = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.openProject].response,
    )({
      _tag: "remoteSelectionRequired",
      rootPath: "/workspace/diffdash",
      candidates: [
        {
          remoteName: "origin",
          repository: { providerId: "github", namespace: "fungsi", name: "diffdash" },
        },
      ],
    })
    const forgotten = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.forgetRepository].request,
    )({ projectId: "" })
    const workspace = Schema.decodeUnknownResult(
      InvokeContract[InvokeChannel.projectWorkspaceSave].request,
    )({
      input: { projectId: "", activeRibbon: "files", selectedReviewTarget: null },
    })

    expect(Result.isSuccess(opening)).toBe(true)
    expect(Result.isFailure(ambiguous)).toBe(true)
    expect(Result.isFailure(forgotten)).toBe(true)
    expect(Result.isFailure(workspace)).toBe(true)
  })

  it("rejects malformed review-thread requests", () => {
    const result = Schema.decodeUnknownResult(AddReviewThreadUserMessageRequest)({
      bodyMarkdown: "Follow up",
      threadId: "",
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("requires canonical repository and revision identity on review-turn requests", () => {
    const result = Schema.decodeUnknownResult(RunReviewThreadAgentRequest)({
      threadId: "thread-10",
      target: {
        kind: "hosted",
        review: {
          repository: { providerId: "github", namespace: "fungsi", name: "diffdash" },
          number: 10,
        },
      },
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("FUN-126 AC: rejects hosted requests without complete provider identity", () => {
    const search = Schema.decodeUnknownResult(HostedRepositorySearchRequest)({
      query: "diffdash",
      namespaces: ["fungsi"],
    })
    const review = Schema.decodeUnknownResult(HostedReviewRequest)({
      review: {
        repository: { namespace: "fungsi", name: "diffdash" },
        number: 126,
      },
    })

    expect(Result.isFailure(search)).toBe(true)
    expect(Result.isFailure(review)).toBe(true)
  })

  it("rejects incomplete viewed-file content identities", () => {
    const hosted = Schema.decodeUnknownResult(SetHostedViewedFileRequest)({
      review: {
        repository: {
          providerId: "github",
          namespace: "fungsi",
          name: "diffdash",
        },
        number: 51,
      },
      baseRefName: "",
      reviewKey: "src/app.ts",
      patchHash: "",
      viewed: true,
    })
    const local = Schema.decodeUnknownResult(SetLocalViewedFileRequest)({
      target: { kind: "local", rootPath: "/repo", comparison: { _tag: "workingTree" } },
      sourceBranch: "feature/auth",
      reviewKey: "src/app.ts",
      patchHash: "",
      viewed: true,
    })

    expect(Result.isFailure(hosted)).toBe(true)
    expect(Result.isFailure(local)).toBe(true)
  })

  it("serializes unknown failures without messages, stacks, or cause data", () => {
    const encoded = Schema.encodeSync(TransportError)(
      toTransportError(
        new Error("Could not load /Users/example/private-repo: secret stderr"),
        InvokeChannel.getReviewThread,
      ),
    )

    expect(encoded).toEqual({
      _tag: "TransportError",
      code: "INTERNAL_ERROR",
      message: UNKNOWN_TRANSPORT_ERROR_MESSAGE,
      operation: "reviewThreads:get",
    })
    expect(encoded).not.toHaveProperty("stack")
    expect(encoded).not.toHaveProperty("cause")
  })

  it("extracts only bounded protocol-owned error messages", () => {
    const explicit = transportError("SAFE", `Safe reason\n${"x".repeat(600)}`)

    expect(safeTransportErrorMessage(explicit)).not.toContain("\n")
    expect(safeTransportErrorMessage(explicit)).toHaveLength(500)
    expect(safeTransportErrorMessage(new Error("/private/path and stderr"))).toBe(
      UNKNOWN_TRANSPORT_ERROR_MESSAGE,
    )
  })

  it("preserves validated transport data through a standard Error bridge encoding", () => {
    const diagnostic = new TransportErrorDiagnosticTrace({
      provider: AgentProviderId.make("claude"),
      errorTag: "AgentProviderOperationError",
      causeTag: "ProcessExitError",
      exitCode: 1,
      signal: null,
      reason: "Authentication or authorization failure reported.",
      stderr: "Authentication or authorization failure reported.",
      stackFrames: ["at generateWalkthrough", "at runProvider"],
    })
    const bridgeError = bridgeTransportError(
      transportError(
        "AgentProviderExitError",
        "Provider claude exited before completing the walkthrough.",
        InvokeChannel.generateRepositoryComparisonWalkthrough,
        diagnostic,
      ),
    )
    const contextBridgeClone = {
      name: bridgeError.name,
      message: bridgeError.message,
      stack: bridgeError.stack,
    }

    expect(bridgeError).toBeInstanceOf(Error)
    expect(decodeTransportError(contextBridgeClone)).toMatchObject({
      code: "AgentProviderExitError",
      message: "Provider claude exited before completing the walkthrough.",
      operation: InvokeChannel.generateRepositoryComparisonWalkthrough,
      diagnostic,
    })
    expect(safeTransportErrorMessage(contextBridgeClone)).toBe(
      "Provider claude exited before completing the walkthrough.",
    )
  })

  it("rejects free-form diagnostic text and stack locations", () => {
    const unsafe = Schema.decodeUnknownResult(TransportErrorDiagnosticTrace)({
      provider: "claude",
      errorTag: "AgentProviderOperationError",
      causeTag: "ProcessExitError",
      exitCode: 1,
      signal: null,
      reason: "password=hunter2",
      stderr: "private prompt and diff content",
      stackFrames: ["at runProvider (/Users/example/private.ts:10:2)"],
    })

    expect(Result.isFailure(unsafe)).toBe(true)
  })

  it("rejects malformed bridge payloads instead of trusting error text", () => {
    const malformed = new Error(
      'Error invoking remote method: DIFFDASH_TRANSPORT_ERROR_V1:{"_tag":"TransportError","code":"SAFE"}',
    )

    expect(hasBridgeTransportErrorEncoding(malformed)).toBe(true)
    expect(decodeTransportError(malformed)).toBeNull()
    expect(safeTransportErrorMessage(malformed)).toBe(UNKNOWN_TRANSPORT_ERROR_MESSAGE)
  })

  it("classifies only typed IPC failures as transient", () => {
    expect(
      isTransientTransportError(transportError("IPC_FAILURE", "Temporarily unavailable")),
    ).toBe(true)
    expect(
      isTransientTransportError(
        bridgeTransportError(transportError("IPC_FAILURE", "Temporarily unavailable")),
      ),
    ).toBe(true)
    expect(
      isTransientTransportError(transportError("INVALID_RESPONSE", "Malformed response")),
    ).toBe(false)
    expect(isTransientTransportError({ code: "IPC_FAILURE" })).toBe(false)
  })

  it("rejects unknown invoke and event channels with typed errors", () => {
    expect(() => getInvokeContract("repositories:deleteEverything")).toThrowError(
      expect.objectContaining({ _tag: "TransportError", code: "UNKNOWN_CHANNEL" }),
    )
    expect(() => getEventContract("updates:rawUpdater")).toThrowError(
      expect.objectContaining({ _tag: "TransportError", code: "UNKNOWN_CHANNEL" }),
    )

    for (const prototypeKey of ["toString", "constructor", "__proto__"]) {
      expect(() => getInvokeContract(prototypeKey)).toThrowError(
        expect.objectContaining({ _tag: "TransportError", code: "UNKNOWN_CHANNEL" }),
      )
      expect(() => getEventContract(prototypeKey)).toThrowError(
        expect.objectContaining({ _tag: "TransportError", code: "UNKNOWN_CHANNEL" }),
      )
    }
  })
})
