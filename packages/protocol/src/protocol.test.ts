import { describe, expect, it } from "@effect/vitest"
import { Either, Schema } from "effect"

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
  isTransientTransportError,
  safeTransportErrorMessage,
  TransportError,
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
    const opening = Schema.decodeUnknownEither(InvokeContract[InvokeChannel.openProject].request)({
      localPath: "/workspace/diffdash",
      selectedRepository: {
        providerId: "github",
        namespace: "fungsi",
        name: "diffdash",
      },
    })
    const ambiguous = Schema.decodeUnknownEither(
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
    const forgotten = Schema.decodeUnknownEither(
      InvokeContract[InvokeChannel.forgetRepository].request,
    )({ projectId: "" })
    const workspace = Schema.decodeUnknownEither(
      InvokeContract[InvokeChannel.projectWorkspaceSave].request,
    )({
      input: { projectId: "", activeRibbon: "files", selectedReviewTarget: null },
    })

    expect(Either.isRight(opening)).toBe(true)
    expect(Either.isLeft(ambiguous)).toBe(true)
    expect(Either.isLeft(forgotten)).toBe(true)
    expect(Either.isLeft(workspace)).toBe(true)
  })

  it("rejects malformed review-thread requests", () => {
    const result = Schema.decodeUnknownEither(AddReviewThreadUserMessageRequest)({
      bodyMarkdown: "Follow up",
      threadId: "",
    })

    expect(Either.isLeft(result)).toBe(true)
  })

  it("requires canonical repository and revision identity on review-turn requests", () => {
    const result = Schema.decodeUnknownEither(RunReviewThreadAgentRequest)({
      threadId: "thread-10",
      target: {
        kind: "hosted",
        review: {
          repository: { providerId: "github", namespace: "fungsi", name: "diffdash" },
          number: 10,
        },
      },
    })

    expect(Either.isLeft(result)).toBe(true)
  })

  it("FUN-126 AC: rejects hosted requests without complete provider identity", () => {
    const search = Schema.decodeUnknownEither(HostedRepositorySearchRequest)({
      query: "diffdash",
      namespaces: ["fungsi"],
    })
    const review = Schema.decodeUnknownEither(HostedReviewRequest)({
      review: {
        repository: { namespace: "fungsi", name: "diffdash" },
        number: 126,
      },
    })

    expect(Either.isLeft(search)).toBe(true)
    expect(Either.isLeft(review)).toBe(true)
  })

  it("rejects incomplete viewed-file content identities", () => {
    const hosted = Schema.decodeUnknownEither(SetHostedViewedFileRequest)({
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
    const local = Schema.decodeUnknownEither(SetLocalViewedFileRequest)({
      target: { kind: "local", rootPath: "/repo", comparison: { _tag: "workingTree" } },
      sourceBranch: "feature/auth",
      reviewKey: "src/app.ts",
      patchHash: "",
      viewed: true,
    })

    expect(Either.isLeft(hosted)).toBe(true)
    expect(Either.isLeft(local)).toBe(true)
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

  it("classifies only typed IPC failures as transient", () => {
    expect(
      isTransientTransportError(transportError("IPC_FAILURE", "Temporarily unavailable")),
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
