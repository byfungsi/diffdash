import { describe, expect, it } from "@effect/vitest"

import { parseUnifiedDiff } from "./diff-parser"
import { LineReviewAnchor, isReviewAnchorInParsedDiff } from "./review-thread"

const parsedDiff = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 const stable = true
-const value = "old"
+const value = "new"`)

const file = parsedDiff.files[0]
const hunk = file?.hunks[0]
if (file === undefined || hunk === undefined) throw new Error("Expected parsed review fixture")

describe("review thread anchors", () => {
  it("FUN-80 AC: validates old and new line sides independently", () => {
    const makeLine = (side: "old" | "new", lineContent: string) =>
      LineReviewAnchor.make({
        fileId: file.fileId,
        filePath: file.path,
        oldPath: file.oldPath,
        hunkId: hunk.id,
        hunkFingerprint: hunk.fingerprint,
        hunkHeader: hunk.header,
        side,
        lineNumber: 2,
        lineContent,
      })

    expect(isReviewAnchorInParsedDiff(makeLine("old", 'const value = "old"'), parsedDiff)).toBe(
      true,
    )
    expect(isReviewAnchorInParsedDiff(makeLine("new", 'const value = "new"'), parsedDiff)).toBe(
      true,
    )
    expect(isReviewAnchorInParsedDiff(makeLine("new", 'const value = "old"'), parsedDiff)).toBe(
      false,
    )
  })
})
