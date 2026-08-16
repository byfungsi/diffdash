import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  HostRequestId,
  type HostRequestContext,
} from "@diffdash/core-rpc/identity"
import {
  CoreReviewSessionFailure,
  CoreReviewSessionId,
  CoreReviewSessionState,
  CoreReviewSessionStateVersion,
  type CoreReviewSearchPublication,
  type CoreReviewSessionIdentity,
} from "@diffdash/core-rpc/review-session"
import {
  ReviewSessionId,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
  type ReviewSessionIdentity,
} from "@diffdash/protocol/review-session"
import { describe, expect, it, vi } from "vitest"

import {
  createProgressiveReviewApiGateway,
  type ProgressiveReviewNativeClient,
} from "./progressive-review-api-gateway"

const context: HostRequestContext = {
  applicationInstanceId: ApplicationInstanceId.make("app"),
  processEpoch: CoreProcessEpoch.make("epoch"),
  requestId: HostRequestId.make("h:request"),
}
const nativeIdentity: CoreReviewSessionIdentity = {
  applicationInstanceId: context.applicationInstanceId,
  processEpoch: context.processEpoch,
  projectId: ReviewProjectId.make("project"),
  reviewKey: ReviewKey.make("review"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
  sessionId: CoreReviewSessionId.make("session"),
  stateVersion: CoreReviewSessionStateVersion.make(1),
}
const browserIdentity: ReviewSessionIdentity = {
  projectId: nativeIdentity.projectId,
  reviewKey: nativeIdentity.reviewKey,
  snapshotId: nativeIdentity.snapshotId,
  processId: ReviewSessionProcessId.make(context.processEpoch),
  sessionId: ReviewSessionId.make(nativeIdentity.sessionId),
  stateVersion: ReviewSessionStateVersion.make(nativeIdentity.stateVersion),
}
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
const ready = CoreReviewSessionState.cases.Ready.make({ identity: nativeIdentity })

const makeClient = (overrides: Partial<ProgressiveReviewNativeClient> = {}) =>
  ({
    openSession: async () => ready,
    currentSession: async () => ready,
    closeSession: async () => ready,
    inventory: async () => ({ identity: nativeIdentity, files: [file], nextOffset: null }),
    readRange: async () => ({
      identity: nativeIdentity,
      file,
      blocks: [],
      byteCount: 0,
      complete: true,
    }),
    waitForRange: async () => ({
      identity: nativeIdentity,
      file,
      blocks: [],
      byteCount: 0,
      complete: true,
    }),
    resolveTarget: async () => ({ identity: nativeIdentity, file, blockOrdinal: 2, line: 4 }),
    search: () => emptyPublications(),
    ...overrides,
  }) satisfies ProgressiveReviewNativeClient

describe("createProgressiveReviewApiGateway", () => {
  it("maps open, current, close, inventory, ranges, wait, and target operations", async () => {
    const openSession = vi.fn<ProgressiveReviewNativeClient["openSession"]>(
      makeClient().openSession,
    )
    const currentSession = vi.fn<ProgressiveReviewNativeClient["currentSession"]>(
      makeClient().currentSession,
    )
    const closeSession = vi.fn<ProgressiveReviewNativeClient["closeSession"]>(
      makeClient().closeSession,
    )
    const inventory = vi.fn<ProgressiveReviewNativeClient["inventory"]>(makeClient().inventory)
    const readRange = vi.fn<ProgressiveReviewNativeClient["readRange"]>(makeClient().readRange)
    const waitForRange = vi.fn<ProgressiveReviewNativeClient["waitForRange"]>(
      makeClient().waitForRange,
    )
    const resolveTarget = vi.fn<ProgressiveReviewNativeClient["resolveTarget"]>(
      makeClient().resolveTarget,
    )
    const api = createProgressiveReviewApiGateway(
      makeClient({
        openSession,
        currentSession,
        closeSession,
        inventory,
        readRange,
        waitForRange,
        resolveTarget,
      }),
      () => context,
    )

    expect(
      await api.openSession({
        projectId: browserIdentity.projectId,
        reviewKey: browserIdentity.reviewKey,
        snapshotId: browserIdentity.snapshotId,
      }),
    ).toEqual({ _tag: "ready", identity: browserIdentity })
    expect(await api.currentSession({ identity: browserIdentity })).toEqual({
      _tag: "ready",
      identity: browserIdentity,
    })
    expect(await api.closeSession({ identity: browserIdentity })).toEqual({
      _tag: "ready",
      identity: browserIdentity,
    })
    expect(await api.inventory({ identity: browserIdentity, offset: 0, limit: 10 })).toEqual({
      identity: browserIdentity,
      files: [file],
      nextOffset: null,
    })
    expect(
      await api.readRange({ identity: browserIdentity, fileId: file.fileId, startLine: 0 }),
    ).toMatchObject({ identity: browserIdentity, file, complete: true })
    expect(
      await api.waitForRange({ identity: browserIdentity, fileId: file.fileId, startLine: 1 }),
    ).toMatchObject({ identity: browserIdentity, file, complete: true })
    expect(
      await api.resolveTarget({
        identity: browserIdentity,
        fileId: file.fileId,
        hunkId: null,
        line: 4,
      }),
    ).toEqual({ identity: browserIdentity, file, blockOrdinal: 2, line: 4 })

    expect(openSession).toHaveBeenCalledWith({
      ...context,
      projectId: browserIdentity.projectId,
      reviewKey: browserIdentity.reviewKey,
      snapshotId: browserIdentity.snapshotId,
    })
    for (const operation of [currentSession, closeSession]) {
      expect(operation).toHaveBeenCalledWith({ ...context, identity: nativeIdentity })
    }
    expect(inventory).toHaveBeenCalledWith({
      ...context,
      identity: nativeIdentity,
      offset: 0,
      limit: 10,
    })
    expect(readRange).toHaveBeenCalledWith({
      ...context,
      identity: nativeIdentity,
      fileId: file.fileId,
      startLine: 0,
    })
    expect(waitForRange).toHaveBeenCalledWith({
      ...context,
      identity: nativeIdentity,
      fileId: file.fileId,
      startLine: 1,
    })
    expect(resolveTarget).toHaveBeenCalledWith({
      ...context,
      identity: nativeIdentity,
      fileId: file.fileId,
      hunkId: null,
      line: 4,
    })
  })

  it("maps search publications and cancels native iteration when the callback stops consumption", async () => {
    let finalized = false
    const publication: CoreReviewSearchPublication = {
      _tag: "Provisional",
      identity: nativeIdentity,
      lowerBoundMatches: 0,
      matches: [],
      previousCursor: null,
      nextCursor: null,
      wrapped: false,
    }
    const search = vi.fn<ProgressiveReviewNativeClient["search"]>(() => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield publication
          yield publication
        } finally {
          finalized = true
        }
      },
    }))
    const api = createProgressiveReviewApiGateway(makeClient({ search }), () => context)
    const received: unknown[] = []

    await expect(
      api.search(
        {
          identity: browserIdentity,
          query: "needle",
          anchorFileId: null,
          direction: "next",
          cursor: null,
          limit: 20,
        },
        (value) => {
          received.push(value)
          throw new Error("stop")
        },
      ),
    ).rejects.toThrow("stop")

    expect(received).toEqual([{ ...publication, identity: browserIdentity }])
    expect(finalized).toBe(true)
    expect(search).toHaveBeenCalledWith({
      ...context,
      identity: nativeIdentity,
      query: "needle",
      anchorFileId: null,
      direction: "next",
      cursor: null,
      limit: 20,
    })
  })

  it("preserves typed native failures for the IPC error adapter", async () => {
    const failure = CoreReviewSessionFailure.make({
      ...context,
      method: "Reviews.openSession",
      code: "REVIEW_SNAPSHOT_NOT_FOUND",
      retryClass: "userAction",
      safeMessage: "The requested review snapshot no longer exists.",
    })
    const api = createProgressiveReviewApiGateway(
      makeClient({ openSession: async () => Promise.reject(failure) }),
      () => context,
    )

    await expect(
      api.openSession({
        projectId: browserIdentity.projectId,
        reviewKey: browserIdentity.reviewKey,
        snapshotId: browserIdentity.snapshotId,
      }),
    ).rejects.toBe(failure)
  })
})

async function* emptyPublications(): AsyncIterable<CoreReviewSearchPublication> {}
