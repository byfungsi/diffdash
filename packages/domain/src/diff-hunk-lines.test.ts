import { describe, expect, it } from "@effect/vitest"

import { parseUnifiedDiff } from "./diff-parser"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "./diff-hunk-lines"

const parsedDiff = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,4 +20,4 @@
 repeated
-old value
+new value
 repeated
\\ No newline at end of file
-old tail
+new tail`)

const hunk = parsedDiff.files[0]?.hunks[0]
if (hunk === undefined) throw new Error("Expected parsed hunk fixture")

describe("diff hunk line projection", () => {
  it("projects context, additions, and deletions onto their exact coordinates", () => {
    expect(projectDiffHunkLines(hunk)).toEqual([
      {
        index: 0,
        patchLine: " repeated",
        content: "repeated",
        kind: "context",
        oldLineNumber: 10,
        newLineNumber: 20,
      },
      {
        index: 1,
        patchLine: "-old value",
        content: "old value",
        kind: "deletion",
        oldLineNumber: 11,
        newLineNumber: null,
      },
      {
        index: 2,
        patchLine: "+new value",
        content: "new value",
        kind: "addition",
        oldLineNumber: null,
        newLineNumber: 21,
      },
      {
        index: 3,
        patchLine: " repeated",
        content: "repeated",
        kind: "context",
        oldLineNumber: 12,
        newLineNumber: 22,
      },
      {
        index: 4,
        patchLine: "\\ No newline at end of file",
        content: "\\ No newline at end of file",
        kind: "metadata",
        oldLineNumber: null,
        newLineNumber: null,
      },
      {
        index: 5,
        patchLine: "-old tail",
        content: "old tail",
        kind: "deletion",
        oldLineNumber: 13,
        newLineNumber: null,
      },
      {
        index: 6,
        patchLine: "+new tail",
        content: "new tail",
        kind: "addition",
        oldLineNumber: null,
        newLineNumber: 23,
      },
    ])
  })

  it("uses side coordinates and content to disambiguate repeated text", () => {
    const lines = projectDiffHunkLines(hunk)

    expect(
      findProjectedDiffHunkLine(lines, {
        side: "new",
        lineNumber: 20,
        content: "repeated",
      })?.index,
    ).toBe(0)
    expect(
      findProjectedDiffHunkLine(lines, {
        side: "new",
        lineNumber: 22,
        content: "repeated",
      })?.index,
    ).toBe(3)
    expect(
      findProjectedDiffHunkLine(lines, {
        side: "new",
        lineNumber: 22,
        content: "different",
      }),
    ).toBeNull()
    expect(findProjectedDiffHunkLine(lines, { side: "old", lineNumber: 11 })?.kind).toBe("deletion")
  })

  it("supports alternate starts while retaining patch indexes for anchor remapping", () => {
    const lines = projectDiffHunkLines(hunk, { oldStart: 100, newStart: 200 })

    expect(lines[3]).toMatchObject({ index: 3, oldLineNumber: 102, newLineNumber: 202 })
    expect(lines[5]).toMatchObject({ index: 5, oldLineNumber: 103, newLineNumber: null })
    expect(lines[6]).toMatchObject({ index: 6, oldLineNumber: null, newLineNumber: 203 })
  })
})
