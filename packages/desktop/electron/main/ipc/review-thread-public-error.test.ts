import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import {
  ReviewThreadAnchorInvalidError,
  ReviewThreadRevisionChangedError,
} from "@diffdash/domain/review-thread"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { ReviewAgentProviderFailureError } from "@diffdash/core"
import { describe, expect, it } from "vitest"
import { toPublicReviewThreadError } from "./review-thread-public-error"

describe("toPublicReviewThreadError", () => {
  it("preserves the existing public code for a changed review revision", () => {
    const result = toPublicReviewThreadError(
      ReviewThreadRevisionChangedError.make({
        expectedBaseRevision: ReviewRevision.make("expected-base"),
        expectedHeadRevision: ReviewRevision.make("expected-head"),
        currentBaseRevision: ReviewRevision.make("current-base"),
        currentHeadRevision: ReviewRevision.make("current-head"),
      }),
      InvokeChannel.createReviewThread,
    )

    expect(result).toMatchObject({
      code: "REVIEW_CHANGED",
      message: "Review changed before the local thread was created.",
    })
  })

  it("preserves the existing public code for an invalid review anchor", () => {
    const result = toPublicReviewThreadError(
      ReviewThreadAnchorInvalidError.make({ reviewKey: ReviewKey.make("fixture#1") }),
      InvokeChannel.createReviewThread,
    )

    expect(result).toMatchObject({
      code: "INVALID_REVIEW_ANCHOR",
      message: "Review thread anchor does not exist in the expected review revision.",
    })
  })

  it("exposes typed authentication guidance without provider output", () => {
    const failure = AgentProviderFailure.make({
      version: 1,
      providerId: ReviewAgentProviderId.make("claude"),
      capability: "review-thread",
      category: "authentication",
      processKind: "exit",
      exitCode: 1,
      signal: null,
      httpStatus: 401,
      retryAfterSeconds: null,
      resetsAt: null,
    })
    const result = toPublicReviewThreadError(
      ReviewAgentProviderFailureError.make({
        failure,
        reason: "The local review agent could not complete this response.",
        cause: new Error("private provider stdout in /Users/example/private-repo"),
      }),
      InvokeChannel.runReviewThreadAgent,
    )

    expect(result).toMatchObject({
      code: "AgentProviderAuthenticationError",
      message: "Provider claude authentication failed or expired. Sign in again, then retry.",
      providerFailure: failure,
    })
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it("uses dedicated guidance when no automatic provider is available", () => {
    const failure = AgentProviderFailure.make({
      version: 1,
      providerId: ReviewAgentProviderId.make("unavailable"),
      capability: "review-thread",
      category: "configuration",
      processKind: null,
      exitCode: null,
      signal: null,
      httpStatus: null,
      retryAfterSeconds: null,
      resetsAt: null,
    })
    const result = toPublicReviewThreadError(
      ReviewAgentProviderFailureError.make({
        failure,
        reason: "The configured review agent is unavailable.",
        cause: new Error("No review agent provider is available"),
      }),
      InvokeChannel.runReviewThreadAgent,
    )

    expect(result).toMatchObject({
      code: "NoAgentProviderAvailableError",
      message: "No configured AI provider is currently available.",
    })
  })
})
