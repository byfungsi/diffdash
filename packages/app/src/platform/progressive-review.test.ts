import { ReviewKey, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import type { ProgressiveReviewApi } from "@diffdash/protocol/review-session"
import {
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
} from "@diffdash/protocol/review-session"
import { describe, expect, it } from "vitest"

import { createProgressiveReviewSessionGateway } from "./progressive-review"

const identity = ReviewSessionIdentity.make({
  projectId: ReviewProjectId.make("project"),
  reviewKey: ReviewKey.make("review"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
  processId: ReviewSessionProcessId.make("epoch"),
  sessionId: ReviewSessionId.make("session"),
  stateVersion: ReviewSessionStateVersion.make(1),
})

describe("createProgressiveReviewSessionGateway", () => {
  it("publishes the open state synchronously and closes the exact identity", async () => {
    const closed: string[] = []
    const state = ReadyReviewSession.make({ identity })
    const api: ProgressiveReviewApi = {
      openSession: async () => state,
      currentSession: async () => state,
      closeSession: async (request) => {
        closed.push(request.identity.sessionId)
        return state
      },
      inventory: async () => {
        throw new Error("not used")
      },
      readRange: async () => {
        throw new Error("not used")
      },
      waitForRange: async () => {
        throw new Error("not used")
      },
      resolveTarget: async () => {
        throw new Error("not used")
      },
      search: async () => undefined,
    }
    const gateway = createProgressiveReviewSessionGateway(api, 60_000)
    const connection = await gateway.openSession({
      projectId: identity.projectId,
      reviewKey: identity.reviewKey,
      snapshotId: identity.snapshotId,
    })
    const publications: string[] = []
    const release = connection.subscribe((publication) => {
      publications.push(publication._tag)
    })
    release()

    expect(publications).toEqual(["ready"])
    await gateway.closeSession({ identity })
    expect(closed).toEqual([identity.sessionId])
  })
})
