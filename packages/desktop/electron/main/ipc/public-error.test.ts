import { describe, expect, it } from "vitest"

import { toPublicIpcError } from "./public-error"

describe("toPublicIpcError", () => {
  it("projects source-safe Core RPC failures without importing Core error classes", () => {
    expect(
      toPublicIpcError(
        {
          _tag: "ReviewAgentOperationFailure",
          code: "REVIEW_AGENT_PROVIDER_FAILURE",
          safeMessage: "DiffDash could not complete this review-agent operation.",
          internalCause: "/Users/example/.config/provider-token",
        },
        "reviewThreads:runAgent",
      ),
    ).toMatchObject({
      _tag: "TransportError",
      code: "REVIEW_AGENT_PROVIDER_FAILURE",
      message: "DiffDash could not complete this review-agent operation.",
      operation: "reviewThreads:runAgent",
    })
  })

  it("does not disclose error-like values that lack a source-safe RPC message", () => {
    expect(
      toPublicIpcError(
        { code: "REVIEW_AGENT_PROVIDER_FAILURE", message: "secret provider output" },
        "reviewThreads:runAgent",
      ),
    ).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "DiffDash could not complete the request.",
    })
  })
})
