import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"
import type { ProgressiveReviewApi } from "@diffdash/protocol/review-session"
import {
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
} from "@diffdash/protocol/review-session"
import { transportError } from "@diffdash/protocol/transport-error"
import { describe, expect, it } from "vitest"

import {
  createProgressiveReviewApi,
  createProgressiveReviewSessionGateway,
} from "./progressive-review"

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

describe("createProgressiveReviewApi", () => {
  it("restores every progressive preload operation and callback publication", async () => {
    const state = ReadyReviewSession.make({ identity })
    const file = {
      ordinal: 0,
      fileId: ReviewFileId.make("file"),
      path: RepositoryRelativePath.make("src/file.ts"),
      oldPath: null,
      additions: 1,
      deletions: 0,
      status: "modified",
      visibility: { _tag: "Visible" },
      patchHash: ReviewFilePatchHash.make("file-patch:test"),
      hunkCount: 1,
    } as const
    const publication = {
      _tag: "Provisional" as const,
      identity,
      lowerBoundMatches: 0,
      matches: [],
      previousCursor: null,
      nextCursor: null,
      wrapped: false as const,
    }
    const success = <Value>(value: Value) => Promise.resolve({ _tag: "Success" as const, value })
    const bridge: DiffDashBridgeApi["progressiveReviews"] = {
      openSession: async () => success(state),
      currentSession: async () => success(state),
      closeSession: async () => success(state),
      inventory: async () => success({ identity, files: [file], nextOffset: null }),
      readRange: async () => success({ identity, file, blocks: [], byteCount: 0, complete: true }),
      waitForRange: async () =>
        success({ identity, file, blocks: [], byteCount: 0, complete: true }),
      resolveTarget: async () =>
        success({ identity, file, blockOrdinal: 0, firstLine: 0, line: 1 }),
      search: async (_request, onPublication) => {
        onPublication(publication)
        return success(null)
      },
    }
    const api = createProgressiveReviewApi(bridge)
    const identityRequest = { identity }

    expect(
      await api.openSession({
        projectId: identity.projectId,
        reviewKey: identity.reviewKey,
        snapshotId: identity.snapshotId,
      }),
    ).toEqual(state)
    expect(await api.currentSession(identityRequest)).toEqual(state)
    expect(await api.closeSession(identityRequest)).toEqual(state)
    expect(await api.inventory({ ...identityRequest, offset: 0, limit: 10 })).toMatchObject({
      identity,
      files: [file],
    })
    expect(
      await api.readRange({ ...identityRequest, fileId: file.fileId, startLine: 0 }),
    ).toMatchObject({ identity, file, complete: true })
    expect(
      await api.waitForRange({ ...identityRequest, fileId: file.fileId, startLine: 0 }),
    ).toMatchObject({ identity, file, complete: true })
    expect(
      await api.resolveTarget({
        ...identityRequest,
        fileId: file.fileId,
        target: { _tag: "HunkLine", hunkId: null, line: 1 },
      }),
    ).toEqual({ identity, file, blockOrdinal: 0, firstLine: 0, line: 1 })
    const publications: unknown[] = []
    await api.search(
      {
        ...identityRequest,
        query: "needle",
        anchorFileId: null,
        direction: "next",
        cursor: null,
        limit: 20,
      },
      (value) => publications.push(value),
    )
    expect(publications).toEqual([publication])
  })

  it("rejects with the typed renderer failure from preload", async () => {
    const failure = transportError(
      "REVIEW_SESSION_INVALID",
      "The progressive review session is invalid.",
      "progressiveReviews:currentSession",
    )
    const unused = async () => Promise.resolve({ _tag: "Failure" as const, error: failure })
    const bridge: DiffDashBridgeApi["progressiveReviews"] = {
      openSession: unused,
      currentSession: unused,
      closeSession: unused,
      inventory: unused,
      readRange: unused,
      waitForRange: unused,
      resolveTarget: unused,
      search: unused,
    }
    const api = createProgressiveReviewApi(bridge)

    await expect(api.currentSession({ identity })).rejects.toEqual(failure)
  })
})
