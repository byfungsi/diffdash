import { describe, expect, it } from "@effect/vitest"

import { parseUnifiedDiff } from "./diff-parser"

const sampleDiff = `diff --git a/src/app.tsx b/src/app.tsx
index 1111111..2222222 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,3 +1,4 @@
 import React from "react"
-const label = "Old"
+const label = "New"
+const enabled = true
 export { label }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const value = 1
+export const name = "new"
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const removed = true
-export const name = "deleted"
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 88%
rename from src/old-name.ts
rename to src/new-name.ts
index 5555555..6666666 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,1 +1,1 @@
-export const renamed = "old"
+export const renamed = "new"
diff --git a/assets/logo.png b/assets/logo.png
index 7777777..8888888 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

describe("parseUnifiedDiff", () => {
  it("extracts file metadata for modified files", () => {
    const parsed = parseUnifiedDiff(sampleDiff)
    const file = parsed.files.find((entry) => entry.path === "src/app.tsx")

    expect(file).toBeDefined()
    expect(file).toMatchObject({
      additions: 2,
      deletions: 1,
      oldPath: null,
      path: "src/app.tsx",
      reviewKey: "src/app.tsx",
      status: "modified",
      visibility: { _tag: "Visible" },
    })
    expect(file?.hunks[0]).toMatchObject({
      header: "@@ -1,3 +1,4 @@",
      newLines: 4,
      newStart: 1,
      oldLines: 3,
      oldStart: 1,
    })
  })

  it("handles added files", () => {
    const parsed = parseUnifiedDiff(sampleDiff)
    const file = parsed.files.find((entry) => entry.path === "src/new.ts")

    expect(file).toMatchObject({
      additions: 2,
      deletions: 0,
      oldPath: null,
      reviewKey: "src/new.ts",
      status: "added",
    })
  })

  it("handles deleted files", () => {
    const parsed = parseUnifiedDiff(sampleDiff)
    const file = parsed.files.find((entry) => entry.path === "src/deleted.ts")

    expect(file).toMatchObject({
      additions: 0,
      deletions: 2,
      oldPath: "src/deleted.ts",
      reviewKey: "src/deleted.ts->src/deleted.ts",
      status: "deleted",
    })
  })

  it("handles renamed files with stable review keys", () => {
    const parsed = parseUnifiedDiff(sampleDiff)
    const file = parsed.files.find((entry) => entry.path === "src/new-name.ts")

    expect(file).toMatchObject({
      additions: 1,
      deletions: 1,
      oldPath: "src/old-name.ts",
      reviewKey: "src/old-name.ts->src/new-name.ts",
      status: "renamed",
    })
  })

  it("handles binary files without hunks", () => {
    const parsed = parseUnifiedDiff(sampleDiff)
    const file = parsed.files.find((entry) => entry.path === "assets/logo.png")

    expect(file).toMatchObject({
      additions: 0,
      deletions: 0,
      hunks: [],
      path: "assets/logo.png",
      status: "binary",
      visibility: { _tag: "Hidden", reason: "binary" },
    })
  })

  it("classifies complete Git binary patches as binary", () => {
    const parsed = parseUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 3
KcmZQzU|?Vb000000
`)

    expect(parsed.files[0]).toMatchObject({
      hunks: [],
      path: "assets/logo.png",
      status: "binary",
      visibility: { _tag: "Hidden", reason: "binary" },
    })
  })

  it("derives default visibility while parsing each file", () => {
    const parsed =
      parseUnifiedDiff(`diff --git a/vendor/generated/pnpm-lock.yaml b/vendor/generated/pnpm-lock.yaml
--- a/vendor/generated/pnpm-lock.yaml
+++ b/vendor/generated/pnpm-lock.yaml
@@ -1 +1 @@
-old
+new
diff --git a/src/client.gen.ts b/src/client.gen.ts
--- a/src/client.gen.ts
+++ b/src/client.gen.ts
@@ -1 +1 @@
-old
+new`)

    expect(parsed.files.map(({ path, visibility }) => ({ path, visibility }))).toEqual([
      {
        path: "vendor/generated/pnpm-lock.yaml",
        visibility: { _tag: "Hidden", reason: "lockfile" },
      },
      { path: "src/client.gen.ts", visibility: { _tag: "Hidden", reason: "generated" } },
    ])
  })

  it("preserves multiple hunks and no-newline markers without counting markers as changes", () => {
    const parsed = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-first old
+first new
\\ No newline at end of file
@@ -20 +20 @@
-second old
+second new
\\ No newline at end of file`)
    const file = parsed.files[0]

    expect(file?.hunks).toHaveLength(2)
    expect(file).toMatchObject({ additions: 2, deletions: 2 })
    expect(file?.hunks.map(({ lines }) => lines.at(-1))).toEqual([
      "\\ No newline at end of file",
      "\\ No newline at end of file",
    ])
  })

  it("preserves mode-only patches as modified files without line hunks", () => {
    const parsed = parseUnifiedDiff(`diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755`)

    expect(parsed.files[0]).toMatchObject({
      additions: 0,
      deletions: 0,
      hunks: [],
      path: "scripts/run.sh",
      status: "modified",
    })
  })

  it("rejects files whose diff paths can escape the repository", () => {
    const parsed = parseUnifiedDiff(`diff --git a/../secret.ts b/../secret.ts
--- a/../secret.ts
+++ b/../secret.ts
@@ -1 +1 @@
-old
+new`)

    expect(parsed.files).toEqual([])
  })

  it("preserves /dev/null semantics while validating the repository path", () => {
    const addition = parseUnifiedDiff(`diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts`)
    const deletion = parseUnifiedDiff(`diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null`)

    expect(addition.files[0]).toMatchObject({ path: "src/new.ts", oldPath: null, status: "added" })
    expect(deletion.files[0]).toMatchObject({
      path: "src/old.ts",
      oldPath: "src/old.ts",
      status: "deleted",
    })
  })
})
