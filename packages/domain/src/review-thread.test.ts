import { describe, expect, it } from "@effect/vitest"

import { parseUnifiedDiff } from "./diff-parser"
import {
  LineReviewAnchor,
  isReviewAnchorInParsedDiff,
  normalizeMarkdownLineBreaks,
} from "./review-thread"

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

describe("review thread Markdown", () => {
  it("normalizes escaped Markdown structure without changing an isolated newline escape", () => {
    expect(
      normalizeMarkdownLineBreaks(
        "Configuration changed.\\n- Read packages/core/src/configuration.ts:4\\n- Trace createCoreLayer.\\n\\nThen verify settings.",
      ),
    ).toBe(`Configuration changed.
- Read packages/core/src/configuration.ts:4
- Trace createCoreLayer.

Then verify settings.`)
    expect(normalizeMarkdownLineBreaks("Use `\\n` as the newline escape.")).toBe(
      "Use `\\n` as the newline escape.",
    )
    expect(normalizeMarkdownLineBreaks("First sentence.\\nSecond sentence.")).toBe(
      "First sentence.\nSecond sentence.",
    )
  })

  it("preserves escaped newlines in inline and fenced code", () => {
    expect(normalizeMarkdownLineBreaks("Use ``value\\nafter``.\\nContinue.")).toBe(
      "Use ``value\\nafter``.\nContinue.",
    )
    expect(
      normalizeMarkdownLineBreaks('Example.\\n```ts\\nconst value = "\\n"\\n```\\nContinue.'),
    ).toBe(`Example.
\`\`\`ts
const value = "\\n"
\`\`\`
Continue.`)
    expect(normalizeMarkdownLineBreaks("Before.\\r\\n- After.")).toBe("Before.\n- After.")
    const validFence = `Example.
\`\`\`ts
const value = "\\n"
\`\`\`
Continue.`
    expect(normalizeMarkdownLineBreaks(validFence)).toBe(validFence)
    expect(normalizeMarkdownLineBreaks(normalizeMarkdownLineBreaks(validFence))).toBe(validFence)
    const longerClosingFence = `\`\`\`ts
const value = "\\n"
\`\`\`\``
    expect(normalizeMarkdownLineBreaks(longerClosingFence)).toBe(longerClosingFence)
  })
})
