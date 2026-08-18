import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { LocalReviewDetail, workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { LocalReviewSnapshotManifest } from "@diffdash/domain/review-context"
import {
  ReviewDiffIdentity,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import type { ProgressiveReviewApi } from "@diffdash/protocol/review-session"
import {
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
} from "@diffdash/protocol/review-session"
import { AtomRegistry } from "effect/unstable/reactivity"
import { describe, expect, it, vi } from "vitest"
import { ProgressiveReviewContentSession } from "./progressive-review-content-session"
import type { ReviewSessionGateway } from "./progressive-review-session"

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-export const value = 1
+export const value = 2
`

describe("ProgressiveReviewContentSession", () => {
  it("assembles and retains complete files for the active review", async () => {
    const parsedFile = parseUnifiedDiff(patch).files[0]
    expect(parsedFile).toBeDefined()
    if (parsedFile === undefined) return

    const rootPath = RepositoryCheckoutPath.make("/workspace/diffdash")
    const target = workingTreeReviewTarget(rootPath)
    const manifest = LocalReviewSnapshotManifest.make({
      projectId: ReviewProjectId.make("local:diffdash"),
      snapshotId: ReviewSnapshotId.make("snapshot:v1:11111111111111111111111111111111"),
      reviewKey: ReviewKey.make("local:/workspace/diffdash"),
      baseRevision: ReviewRevision.make("base"),
      headRevision: ReviewRevision.make("head"),
      fileCount: 1,
      detail: LocalReviewDetail.make({
        rootPath,
        repoName: "diffdash",
        branchName: RepositoryComparisonRef.make("feature"),
        comparison: target.comparison,
        baseSha: ReviewRevision.make("base"),
        headSha: ReviewRevision.make("head"),
        diffHash: ReviewDiffIdentity.make("diff"),
        title: "Local changes",
        files: [],
        fetchedAt: "2026-08-18T00:00:00Z",
      }),
    })
    const identity = ReviewSessionIdentity.make({
      projectId: manifest.projectId,
      reviewKey: manifest.reviewKey,
      snapshotId: manifest.snapshotId,
      processId: ReviewSessionProcessId.make("process"),
      sessionId: ReviewSessionId.make("session"),
      stateVersion: ReviewSessionStateVersion.make(1),
    })
    const file = {
      ordinal: 0,
      fileId: parsedFile.fileId,
      path: parsedFile.path,
      oldPath: parsedFile.oldPath,
      additions: parsedFile.additions,
      deletions: parsedFile.deletions,
      status: parsedFile.status,
      visibility: parsedFile.visibility,
      patchHash: parsedFile.patchHash,
      hunkCount: parsedFile.hunks.length,
    } as const
    const lines = patch.split("\n")
    const firstBytes = new TextEncoder().encode(`${lines.slice(0, 6).join("\n")}\n`)
    const finalBytes = new TextEncoder().encode(lines.slice(6).join("\n"))
    const waitForRange = vi.fn<ProgressiveReviewApi["waitForRange"]>(async (request) => {
      const firstRange = request.startLine === 0
      const bytes = firstRange ? firstBytes : finalBytes
      return {
        identity,
        file,
        blocks: [
          {
            id: firstRange ? "block-1" : "block-2",
            hunkId: null,
            ordinal: firstRange ? 0 : 1,
            firstLine: request.startLine,
            lineCount: firstRange ? 6 : 2,
            bytes,
          },
        ],
        byteCount: bytes.byteLength,
        complete: !firstRange,
      }
    })
    const api: ProgressiveReviewApi = {
      openSession: async () => ReadyReviewSession.make({ identity }),
      currentSession: async () => ReadyReviewSession.make({ identity }),
      closeSession: async () => ReadyReviewSession.make({ identity }),
      inventory: async () => ({ identity, files: [file], nextOffset: null }),
      readRange: waitForRange,
      waitForRange,
      resolveTarget: async () => {
        throw new Error("not used")
      },
      search: async () => undefined,
    }
    const gateway: ReviewSessionGateway = {
      openSession: async () => ({
        subscribe: (listener) => {
          listener(ReadyReviewSession.make({ identity }))
          return () => undefined
        },
      }),
      closeSession: async () => undefined,
    }
    const session = new ProgressiveReviewContentSession(
      AtomRegistry.make(),
      manifest,
      api,
      gateway,
      () => undefined,
    )
    session.mount()
    await vi.waitFor(() => expect(session.getProjection().inventory).toHaveLength(1))

    await session.loadFiles([file.fileId])
    await session.loadFiles([file.fileId])

    expect(session.getFile(file.fileId)?.patch).toBe(parsedFile.patch)
    expect(session.getProjection().files.map((entry) => entry.fileId)).toEqual([file.fileId])
    expect(waitForRange.mock.calls.map(([request]) => request.startLine)).toEqual([0, 6])
    session.dispose()
  })
})
