import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewFileId,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import type { ProgressiveReviewApi } from "@diffdash/protocol/review-session"
import {
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
} from "@diffdash/protocol/review-session"
import { describe, expect, it } from "vitest"

import { loadProgressivePierreRange } from "./progressive-pierre-range"
import type { PierreRangeIdentity } from "./pierre-loaded-range-adapter"

describe("loadProgressivePierreRange", () => {
  it("translates only the returned bounded blocks into a Pierre range", async () => {
    const identity: PierreRangeIdentity = {
      projectId: "project",
      processEpoch: "epoch",
      snapshotGeneration: "snapshot",
      sessionEpoch: "session",
      rangeKey: "file:0",
      requestId: "request",
      width: 900,
      mode: "unified",
    }
    const sessionIdentity = ReviewSessionIdentity.make({
      projectId: ReviewProjectId.make("project"),
      reviewKey: ReviewKey.make("review"),
      snapshotId: ReviewSnapshotId.make("snapshot:v1:00000000000000000000000000000001"),
      processId: ReviewSessionProcessId.make("epoch"),
      sessionId: ReviewSessionId.make("session"),
      stateVersion: ReviewSessionStateVersion.make(1),
    })
    const range = {
      identity: sessionIdentity,
      file: {
        ordinal: 0,
        fileId: ReviewFileId.make("file"),
        path: RepositoryRelativePath.make("src/file.ts"),
        oldPath: null,
        additions: 1,
        deletions: 0,
        status: "modified" as const,
        visibility: { _tag: "Visible" as const },
        patchHash: ReviewFilePatchHash.make("file-patch:test"),
        hunkCount: 1,
      },
      blocks: [
        {
          id: "block",
          hunkId: null,
          ordinal: 0,
          firstLine: 0,
          lineCount: 2,
          bytes: new TextEncoder().encode("@@ -0,0 +1 @@\n+value\n"),
        },
      ],
      byteCount: 24,
      complete: true,
    }
    const api: Pick<ProgressiveReviewApi, "readRange" | "waitForRange"> = {
      readRange: async () => range,
      waitForRange: async () => range,
    }
    const loaded = await loadProgressivePierreRange(
      api,
      identity,
      {
        identity: range.identity,
        fileId: ReviewFileId.make("file"),
        startLine: 0,
      },
      false,
      new AbortController().signal,
    )

    expect(loaded.identity).toBe(identity)
    expect(loaded.fileDiff.name).toBe("src/file.ts")
    expect(loaded.fileDiff.hunks).toHaveLength(1)
    expect(loaded.renderRange.totalLines).toBeGreaterThan(0)
  })
})
