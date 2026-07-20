import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  LineReviewAnchor,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import {
  lineAnchorIsInFile,
  lineReviewAnchor,
  reviewThreadAnnotations,
  sameReviewThreadLine,
} from "./thread-annotations"

const parsedFile = () => {
  const parsed = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-const value = "old"
+const value = "new"`)
  const file = parsed.files[0]
  if (file === undefined) throw new Error("Expected parsed diff file")
  return file
}

const details = (id: string, anchor: LineReviewAnchor, status: "active" | "outdated" = "active") =>
  ReviewThreadDetails.make({
    thread: ReviewThread.make({
      id: ReviewThreadId.make(id),
      repoId: "repo-1",
      reviewKey: ReviewKey.make("review-1"),
      prNumber: 1,
      baseRevision: ReviewRevision.make("base"),
      headRevision: ReviewRevision.make("head"),
      currentBaseRevision: ReviewRevision.make("base"),
      currentHeadRevision: ReviewRevision.make("head"),
      originalAnchor: anchor,
      currentAnchor: anchor,
      anchorStatus: status,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    }),
    messages: [],
  })

describe("review thread annotations", () => {
  it("matches only exact current diff content", () => {
    const file = parsedFile()
    const anchor = lineReviewAnchor(file, "additions", 1)
    if (anchor === null) throw new Error("Expected added-line anchor")
    const stale = LineReviewAnchor.make({ ...anchor, lineContent: "stale content" })

    expect(lineAnchorIsInFile(anchor, file)).toBe(true)
    expect(lineAnchorIsInFile(stale, file)).toBe(false)
    expect(sameReviewThreadLine(anchor, anchor)).toBe(true)
    expect(sameReviewThreadLine(anchor, stale)).toBe(false)
  })

  it("groups active threads on one exact line and excludes stale thread states", () => {
    const file = parsedFile()
    const anchor = lineReviewAnchor(file, "additions", 1)
    if (anchor === null) throw new Error("Expected added-line anchor")

    const annotations = reviewThreadAnnotations(
      file,
      [
        details("thread-1", anchor),
        details("thread-2", anchor),
        details("thread-3", anchor, "outdated"),
      ],
      anchor,
    )

    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.side).toBe("additions")
    expect(annotations[0]?.metadata.details.map(({ thread }) => thread.id)).toEqual([
      "thread-1",
      "thread-2",
    ])
    expect(annotations[0]?.metadata.expanded).toBe(true)
    expect(annotations[0]?.metadata.draftAnchor).toBeNull()
  })

  it("creates an empty draft annotation only for a matching expanded line", () => {
    const file = parsedFile()
    const anchor = lineReviewAnchor(file, "deletions", 1)
    if (anchor === null) throw new Error("Expected deleted-line anchor")

    expect(reviewThreadAnnotations(file, [], anchor)).toEqual([
      expect.objectContaining({
        lineNumber: 1,
        side: "deletions",
        metadata: expect.objectContaining({ details: [], draftAnchor: anchor, expanded: true }),
      }),
    ])
  })
})
