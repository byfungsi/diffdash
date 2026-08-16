import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { describe, expect, it } from "vitest"

import { ReviewPageCache } from "./review-page-cache"

const file = (path: string, content = "new") => {
  const parsed = parseUnifiedDiff(
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${content}\n`,
  ).files[0]
  if (parsed === undefined) throw new Error("Expected parsed fixture file")
  return parsed
}

describe("ReviewPageCache", () => {
  it("evicts least-recent files under its count bound", () => {
    const cache = new ReviewPageCache({ maxBytes: 1_000_000, maxFiles: 2 })
    const first = file("first.ts")
    const second = file("second.ts")
    const third = file("third.ts")

    expect(cache.put(first)).toBe(true)
    expect(cache.put(second)).toBe(true)
    expect(cache.get(first.fileId)).toBe(first)
    expect(cache.put(third)).toBe(true)

    expect(cache.get(second.fileId)).toBeNull()
    expect(cache.files().map(({ fileId }) => fileId)).toEqual([first.fileId, third.fileId])
  })

  it("refuses a file larger than its byte bound without retaining it", () => {
    const cache = new ReviewPageCache({ maxBytes: 128, maxFiles: 2 })
    const oversized = file("large.ts", "x".repeat(1_000))

    expect(cache.put(oversized)).toBe(false)
    expect(cache.stats()).toEqual({ bytes: 0, files: 0 })
  })
})
