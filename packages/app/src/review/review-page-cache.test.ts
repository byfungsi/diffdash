import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { describe, expect, it } from "@effect/vitest"
import { ReviewPageCache } from "./review-page-cache"

const files = parseUnifiedDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+a
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-old
+b
diff --git a/c.ts b/c.ts
--- a/c.ts
+++ b/c.ts
@@ -1 +1 @@
-old
+c`).files

describe("ReviewPageCache", () => {
  it("evicts least-recent complete files under the explicit entry bound", () => {
    const cache = new ReviewPageCache({ maxBytes: 1_000_000, maxFiles: 2 })
    const first = files[0]
    const second = files[1]
    const third = files[2]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(third).toBeDefined()
    if (first === undefined || second === undefined || third === undefined) return

    cache.put([first, second])
    expect(cache.get(first.fileId)).toBe(first)
    cache.put([third])

    expect(cache.get(first.fileId)).toBe(first)
    expect(cache.get(second.fileId)).toBeNull()
    expect(cache.get(third.fileId)).toBe(third)
    expect(cache.stats().files).toBe(2)
  })
})
