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

    expect(new Set(invokeChannels).size).toBe(48)
    expect(new Set(eventChannels).size).toBe(3)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(51)
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
