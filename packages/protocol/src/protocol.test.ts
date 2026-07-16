import { describe, expect, it } from "@effect/vitest"
import { Either, Schema } from "effect"

import { EventChannel, InvokeChannel } from "./channels"
import { AddReviewThreadUserMessageRequest } from "./review-threads"
import { toTransportError, TransportError } from "./transport-error"
import { HostedReviewRequest, HostedRepositorySearchRequest } from "./hosted-git"
import { getEventContract, getInvokeContract } from "./ipc"

describe("protocol boundaries", () => {
  it("owns unique invoke and event channel names", () => {
    const invokeChannels = Object.values(InvokeChannel)
    const eventChannels = Object.values(EventChannel)

    expect(new Set(invokeChannels).size).toBe(51)
    expect(new Set(eventChannels).size).toBe(3)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(54)
  })

  it("rejects malformed review-thread requests", () => {
    const result = Schema.decodeUnknownEither(AddReviewThreadUserMessageRequest)({
      bodyMarkdown: "Follow up",
      threadId: "",
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

  it("serializes failures without stack or cause data", () => {
    const encoded = Schema.encodeSync(TransportError)(
      toTransportError(new Error("Could not load review"), InvokeChannel.getReviewThread),
    )

    expect(encoded).toEqual({
      _tag: "TransportError",
      code: "INTERNAL_ERROR",
      message: "Could not load review",
      operation: "reviewThreads:get",
    })
    expect(encoded).not.toHaveProperty("stack")
    expect(encoded).not.toHaveProperty("cause")
  })

  it("rejects unknown invoke and event channels with typed errors", () => {
    expect(() => getInvokeContract("repositories:deleteEverything")).toThrowError(
      expect.objectContaining({ _tag: "TransportError", code: "UNKNOWN_CHANNEL" }),
    )
    expect(() => getEventContract("updates:rawUpdater")).toThrowError(
      expect.objectContaining({ _tag: "TransportError", code: "UNKNOWN_CHANNEL" }),
    )
  })
})
