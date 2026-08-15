import { describe, expect, it } from "@effect/vitest"
import { ReviewKey, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { Result, Schema } from "effect"

import {
  IndexingReviewSession,
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionState,
  ReviewSessionStateVersion,
  VerifyingReviewSession,
  reviewSessionCapabilities,
} from "./review-session"

const identity = ReviewSessionIdentity.make({
  projectId: ReviewProjectId.make("project-1"),
  reviewKey: ReviewKey.make("review-1"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
  processId: ReviewSessionProcessId.make("process-1"),
  sessionId: ReviewSessionId.make("session-1"),
  stateVersion: ReviewSessionStateVersion.make(3),
})

describe("progressive review session protocol", () => {
  it("roundtrips the full monotonic identity on every lifecycle state", () => {
    const state = IndexingReviewSession.make({ identity, completedUnits: 2, totalUnits: 10 })
    const encoded = Schema.encodeSync(ReviewSessionState)(state)
    const decoded = Schema.decodeUnknownSync(ReviewSessionState)(encoded)

    expect(decoded).toEqual(state)
    expect(decoded.identity).toEqual(identity)
  })

  it("rejects invalid state versions and malformed indexing progress", () => {
    const encodedIdentity = Schema.encodeSync(ReviewSessionIdentity)(identity)

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ReviewSessionState)({
          _tag: "ready",
          identity: { ...encodedIdentity, stateVersion: 0 },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ReviewSessionState)({
          _tag: "indexing",
          identity: encodedIdentity,
          completedUnits: -1,
          totalUnits: 10,
        }),
      ),
    ).toBe(true)
  })

  it("keeps committed reads available before mutations become ready", () => {
    const indexing = IndexingReviewSession.make({ identity, completedUnits: 1, totalUnits: 2 })
    const verifying = VerifyingReviewSession.make({ identity })
    const ready = ReadyReviewSession.make({ identity })

    expect(reviewSessionCapabilities(indexing)).toEqual({
      committedContent: "readable",
      search: "indexing",
      filter: "indexing",
      navigation: "indexing",
      mutations: "disabled",
    })
    expect(reviewSessionCapabilities(verifying).mutations).toBe("disabled")
    expect(reviewSessionCapabilities(ready).mutations).toBe("enabled")
  })
})
