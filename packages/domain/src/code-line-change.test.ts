import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { parseUnifiedDiff } from "./diff-parser"
import { codeLineChangesFromHunks } from "./code-line-change"

describe("codeLineChangesFromHunks", () => {
  it("projects additions, replacements, and deletion-only groups onto current lines", () => {
    const file = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,3 @@
 keep
+added one
+added two
 keep again
@@ -8,2 +9,2 @@
-old one
-old two
+new one
+new two
@@ -15,2 +16,0 @@
-removed one
-removed two
`).files[0]

    expect(codeLineChangesFromHunks(Option.getOrThrow(Option.fromNullishOr(file)).hunks)).toEqual([
      { kind: "added", startLine: 2, endLine: 3 },
      { kind: "modified", startLine: 9, endLine: 10 },
      { kind: "deleted", startLine: 16, endLine: 16 },
    ])
  })

  it("anchors a whole-file deletion to the first visible line", () => {
    const file = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
deleted file mode 100644
--- a/src/example.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`).files[0]

    expect(codeLineChangesFromHunks(Option.getOrThrow(Option.fromNullishOr(file)).hunks)).toEqual([
      { kind: "deleted", startLine: 1, endLine: 1 },
    ])
  })
})
