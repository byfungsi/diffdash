import {
  ReviewFileId,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"

import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import { getCoreRpcMethodPolicy } from "./method-policy"
import {
  CoreReviewSessionId,
  CoreReviewSessionIdentity,
  CoreReviewSessionStateVersion,
  CoreResolvedReviewTarget,
  CoreReviewTargetRequest,
  OpenCoreReviewSessionRequest,
} from "./review-session"
import { CoreProgressiveReviewRpcs } from "./review-session-rpc"

describe("Core progressive review RPC declarations", () => {
  it("assigns every method one exhaustive bounded policy", () => {
    expect([...CoreProgressiveReviewRpcs.requests.keys()]).toEqual([
      "Reviews.openSession",
      "Reviews.currentSession",
      "Reviews.closeSession",
      "Reviews.inventory",
      "Ranges.read",
      "Ranges.wait",
      "Navigation.resolveTarget",
      "Search.scan",
    ])

    for (const rpc of CoreProgressiveReviewRpcs.requests.values()) {
      const annotation = getCoreRpcMethodPolicy(rpc)
      expect(Option.isSome(annotation), `${rpc._tag} must declare a method policy`).toBe(true)
      if (Option.isNone(annotation)) continue
      expect(annotation.value.requiredScope).toBe("review")
      expect(annotation.value.restartBehavior).toBe("failOnRestart")
      expect(annotation.value.maxRequestBytes).toBeLessThan(512 * 1_024)
      expect(annotation.value.maxResponseBytes).toBeLessThan(512 * 1_024)
    }
  })

  it("rejects malformed host and exact-session identities", () => {
    expect(
      Schema.is(OpenCoreReviewSessionRequest)({
        applicationInstanceId: "app",
        processEpoch: "epoch",
        requestId: "invalid",
        projectId: "project",
        reviewKey: "review",
        snapshotId: "snapshot",
      }),
    ).toBe(false)

    const identity = CoreReviewSessionIdentity.make({
      applicationInstanceId: ApplicationInstanceId.make("app"),
      processEpoch: CoreProcessEpoch.make("epoch"),
      projectId: ReviewProjectId.make("project"),
      reviewKey: ReviewKey.make("review"),
      snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
      sessionId: CoreReviewSessionId.make("session:h:request"),
      stateVersion: CoreReviewSessionStateVersion.make(1),
    })
    expect(Schema.is(CoreReviewSessionIdentity)(identity)).toBe(true)
    expect(Schema.is(CoreReviewSessionIdentity)({ ...identity, stateVersion: 0 })).toBe(false)
    expect(
      Schema.is(OpenCoreReviewSessionRequest)({
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId: HostRequestId.make("h:request"),
        projectId: identity.projectId,
        reviewKey: identity.reviewKey,
        snapshotId: identity.snapshotId,
      }),
    ).toBe(true)

    const requestIdentity = {
      applicationInstanceId: identity.applicationInstanceId,
      processEpoch: identity.processEpoch,
      requestId: HostRequestId.make("h:request"),
    }
    const fileId = ReviewFileId.make("file")
    const hunkId = ReviewHunkId.make("hunk")
    expect(
      Schema.is(CoreReviewTargetRequest)({
        ...requestIdentity,
        identity,
        fileId,
        target: { _tag: "HunkLine", hunkId, line: 4 },
      }),
    ).toBe(true)
    expect(
      Schema.is(CoreReviewTargetRequest)({
        ...requestIdentity,
        identity,
        fileId,
        target: { _tag: "SideLine", hunkId, side: "old", lineNumber: 40 },
      }),
    ).toBe(true)
    expect(
      Schema.is(CoreReviewTargetRequest)({
        ...requestIdentity,
        identity,
        fileId,
        hunkId,
        line: 4,
      }),
    ).toBe(false)
    const resolved = {
      identity,
      file: {
        ordinal: 9,
        fileId,
        path: "src/example.ts",
        oldPath: null,
        additions: 1,
        deletions: 1,
        status: "modified",
        visibility: { _tag: "Visible" },
        patchHash: `file-patch:v2:${"0".repeat(64)}`,
        hunkCount: 1,
      },
      blockOrdinal: 7,
      firstLine: 384,
      line: 401,
    }
    expect(Schema.decodeUnknownSync(CoreResolvedReviewTarget)(resolved).firstLine).toBe(384)
  })
})
