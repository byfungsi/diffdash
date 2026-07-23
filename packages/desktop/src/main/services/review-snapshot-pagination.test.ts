import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ChangedFile } from "@diffdash/domain/git-provider"
import { LocalReviewDetail, LocalReviewDiff } from "@diffdash/domain/local-review"
import { LocalReviewSnapshot } from "@diffdash/domain/review-context"
import {
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { jsonSafeUtf8ByteLength } from "@diffdash/protocol/payload-budget"
import {
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
  ReviewSnapshotSearchFileAnchor,
  ReviewSnapshotSearchRequest,
} from "@diffdash/protocol/review-snapshot"
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { paginateReviewSnapshot, searchReviewSnapshot } from "./review-snapshot-pagination"

const makeSnapshot = (rawDiff: string) => {
  const parsedDiff = parseUnifiedDiff(rawDiff)
  const reviewKey = ReviewKey.make("local:pagination")
  const baseRevision = ReviewRevision.make("base")
  const headRevision = ReviewRevision.make("head")
  const diff = LocalReviewDiff.make({
    rootPath: "/repo",
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: "pagination-diff",
    diff: rawDiff,
    fetchedAt: "2026-07-19T00:00:00.000Z",
  })
  return LocalReviewSnapshot.make({
    snapshotId: makeReviewSnapshotId({
      reviewKey,
      baseRevision,
      headRevision,
      diffIdentity: ReviewDiffIdentity.make(diff.diffHash),
    }),
    reviewKey,
    baseRevision,
    headRevision,
    detail: LocalReviewDetail.make({
      rootPath: diff.rootPath,
      repoName: "repo",
      branchName: "feature/pages",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      diffHash: diff.diffHash,
      title: "Pagination",
      files: parsedDiff.files.map((file) =>
        ChangedFile.make({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status,
        }),
      ),
      fetchedAt: diff.fetchedAt,
    }),
    diff,
    parsedDiff,
  })
}

const threeFileDiff = `diff --git a/src/first.ts b/src/first.ts
--- a/src/first.ts
+++ b/src/first.ts
@@ -1 +1 @@
-old
+first needle
diff --git a/src/second.ts b/src/second.ts
--- a/src/second.ts
+++ b/src/second.ts
@@ -1 +1 @@
-old
+second needle
diff --git a/src/unloaded.ts b/src/unloaded.ts
--- a/src/unloaded.ts
+++ b/src/unloaded.ts
@@ -1 +1,2 @@
-old
+UNLOADED SENTINEL
+unloaded sentinel again`

const manyFileDiff = Array.from(
  { length: 10 },
  (_, index) => `diff --git a/src/file-${index}.ts b/src/file-${index}.ts
--- a/src/file-${index}.ts
+++ b/src/file-${index}.ts
@@ -1 +1 @@
-old ${index}
+new ${index}`,
).join("\n")

describe("review snapshot pagination", () => {
  it("accepts the exact encoded boundary and returns a typed state one byte over", () => {
    const snapshot = makeSnapshot(threeFileDiff)
    const fileId = snapshot.parsedDiff.files[0]?.fileId
    expect(fileId).toBeDefined()
    if (fileId === undefined) return
    const request = ReviewSnapshotPageRequest.make({
      snapshotId: snapshot.snapshotId,
      cursor: null,
      fileIds: [fileId],
    })
    const unbounded = paginateReviewSnapshot(snapshot, request, 1_000_000)
    expect(unbounded["_tag"]).toBe("available")
    const exactBytes = jsonSafeUtf8ByteLength(
      Schema.encodeSync(ReviewSnapshotPageResponse)(unbounded),
    )

    expect(paginateReviewSnapshot(snapshot, request, exactBytes)["_tag"]).toBe("available")
    expect(paginateReviewSnapshot(snapshot, request, exactBytes - 1)["_tag"]).toBe("fileTooLarge")
  })

  it("returns complete files with a stable selection-bound cursor", () => {
    const snapshot = makeSnapshot(threeFileDiff)
    const fileIds = snapshot.parsedDiff.files.slice(0, 2).map((file) => file.fileId)
    const firstFileId = fileIds[0]
    expect(firstFileId).toBeDefined()
    if (firstFileId === undefined) return
    const firstOnly = paginateReviewSnapshot(
      snapshot,
      ReviewSnapshotPageRequest.make({
        snapshotId: snapshot.snapshotId,
        cursor: null,
        fileIds: [firstFileId],
      }),
      1_000_000,
    )
    const firstBytes = jsonSafeUtf8ByteLength(
      Schema.encodeSync(ReviewSnapshotPageResponse)(firstOnly),
    )
    const request = ReviewSnapshotPageRequest.make({
      snapshotId: snapshot.snapshotId,
      cursor: null,
      fileIds,
    })
    const page = paginateReviewSnapshot(snapshot, request, firstBytes + 128)
    const repeated = paginateReviewSnapshot(snapshot, request, firstBytes + 128)

    expect(page["_tag"]).toBe("available")
    if (page["_tag"] !== "available" || repeated["_tag"] !== "available") return
    expect(page.files).toHaveLength(1)
    expect(page.files[0]?.patch).toContain("first needle")
    expect(page.nextCursor).not.toBeNull()
    expect(repeated.nextCursor).toBe(page.nextCursor)
  })

  it("paginates an empty file selection across stable eight-file pages", () => {
    const snapshot = makeSnapshot(manyFileDiff)
    const request = ReviewSnapshotPageRequest.make({
      snapshotId: snapshot.snapshotId,
      cursor: null,
      fileIds: [],
    })
    const first = paginateReviewSnapshot(snapshot, request, 1_000_000)
    const repeated = paginateReviewSnapshot(snapshot, request, 1_000_000)

    expect(first["_tag"]).toBe("available")
    expect(repeated["_tag"]).toBe("available")
    if (first["_tag"] !== "available" || repeated["_tag"] !== "available") {
      throw new Error("Expected an available first page")
    }
    expect(first.files).toHaveLength(8)
    expect(first.nextCursor).toMatch(/^page:v1:8:[0-9a-f]{8}$/)
    expect(repeated.nextCursor).toBe(first.nextCursor)
    if (first.nextCursor === null) throw new Error("Expected a continuation cursor")

    const second = paginateReviewSnapshot(
      snapshot,
      ReviewSnapshotPageRequest.make({
        snapshotId: snapshot.snapshotId,
        cursor: first.nextCursor,
        fileIds: [],
      }),
      1_000_000,
    )
    expect(second["_tag"]).toBe("available")
    if (second["_tag"] !== "available") throw new Error("Expected an available second page")
    expect(second.files).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect([...first.files, ...second.files].map((file) => file.path)).toEqual(
      snapshot.parsedDiff.files.map((file) => file.path),
    )
  })

  it("searches unloaded files and paginates revision-keyed matches", () => {
    const snapshot = makeSnapshot(threeFileDiff)
    const firstFileId = snapshot.parsedDiff.files[0]?.fileId
    expect(firstFileId).toBeDefined()
    if (firstFileId === undefined) return
    const loadedPage = paginateReviewSnapshot(
      snapshot,
      ReviewSnapshotPageRequest.make({
        snapshotId: snapshot.snapshotId,
        cursor: null,
        fileIds: [firstFileId],
      }),
      1_000_000,
    )
    expect(loadedPage["_tag"]).toBe("available")

    const firstSearch = searchReviewSnapshot(
      snapshot,
      ReviewSnapshotSearchRequest.make({
        snapshotId: snapshot.snapshotId,
        query: "unloaded sentinel",
        cursor: null,
        limit: 1,
      }),
      256_000,
    )
    expect(firstSearch["_tag"]).toBe("available")
    if (firstSearch["_tag"] !== "available") return
    expect(firstSearch.totalMatches).toBe(2)
    expect(firstSearch.matches[0]?.filePath).toBe("src/unloaded.ts")
    expect(firstSearch.nextCursor).not.toBeNull()
    if (firstSearch.nextCursor === null) return

    const secondSearch = searchReviewSnapshot(
      snapshot,
      ReviewSnapshotSearchRequest.make({
        snapshotId: snapshot.snapshotId,
        query: "unloaded sentinel",
        cursor: firstSearch.nextCursor,
        limit: 1,
      }),
      256_000,
    )
    expect(secondSearch["_tag"]).toBe("available")
    if (secondSearch["_tag"] !== "available") throw new Error("Expected an available search page")
    expect(secondSearch.matches[0]?.filePath).toBe("src/unloaded.ts")
    expect(secondSearch.nextCursor).toBeNull()
  })

  it("rotates search results forward from a file viewport anchor", () => {
    const snapshot = makeSnapshot(threeFileDiff)
    const secondFile = snapshot.parsedDiff.files[1]
    expect(secondFile).toBeDefined()
    if (secondFile === undefined) return

    const fromSecondFile = searchReviewSnapshot(
      snapshot,
      ReviewSnapshotSearchRequest.make({
        snapshotId: snapshot.snapshotId,
        query: "needle",
        cursor: null,
        limit: 10,
        anchor: ReviewSnapshotSearchFileAnchor.make({ fileId: secondFile.fileId }),
      }),
      256_000,
    )
    expect(fromSecondFile["_tag"]).toBe("available")
    if (fromSecondFile["_tag"] !== "available") return
    expect(fromSecondFile.matches.map((match) => match.filePath)).toEqual([
      "src/second.ts",
      "src/first.ts",
    ])
  })
})
