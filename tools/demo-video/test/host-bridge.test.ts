import { InvokeChannel } from "@diffdash/protocol/channels"
import { bridgeResult, invokeResponseSchema } from "@diffdash/protocol/ipc"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { encodeDemoBridgeValue } from "../src/host/bridge"

describe("demo host bridge", () => {
  it("encodes void review mutations as null-backed success responses", () => {
    const encoded = {
      _tag: "Success" as const,
      value: encodeDemoBridgeValue("hostedReviews.submitDecision", undefined),
    }

    expect(encoded.value).toBeNull()
    expect(() =>
      Schema.decodeUnknownSync(
        bridgeResult(invokeResponseSchema(InvokeChannel.submitHostedReviewDecision)),
      )(encoded),
    ).not.toThrow()
    expect(() =>
      Schema.decodeUnknownSync(bridgeResult(invokeResponseSchema(InvokeChannel.mergeHostedReview)))(
        encoded,
      ),
    ).not.toThrow()
  })
})
