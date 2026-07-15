import { describe, expect, it } from "@effect/vitest"
import { Either, Schema } from "effect"

import { EventChannel, InvokeChannel } from "./channels"
import { AddReviewThreadUserMessageRequest } from "./review-threads"
import { toTransportError, TransportError } from "./transport-error"

describe("protocol boundaries", () => {
  it("owns unique invoke and event channel names", () => {
    const invokeChannels = Object.values(InvokeChannel)
    const eventChannels = Object.values(EventChannel)

    expect(new Set(invokeChannels).size).toBe(49)
    expect(new Set(eventChannels).size).toBe(3)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(52)
  })

  it("rejects malformed review-thread requests", () => {
    const result = Schema.decodeUnknownEither(AddReviewThreadUserMessageRequest)({
      bodyMarkdown: "Follow up",
      threadId: "",
    })

    expect(Either.isLeft(result)).toBe(true)
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
})
