import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { makePullRequestReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import { AppConfig } from "./app-config"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadAnchorMapper } from "./review-thread-anchor-mapper"
import { ReviewThreadStore } from "./review-thread-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-anchor-mapper-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  ReviewThreadAnchorMapper.layer.pipe(
    Layer.provideMerge(ReviewThreadStore.layer),
    Layer.provideMerge(RepositoryStore.layer),
    Layer.provideMerge(DatabaseService.layer),
    Layer.provide(
      AppConfig.layer({
        databasePath,
        settingsPath: join(dirname(databasePath), "settings.json"),
        tempDir: tmpdir(),
      }),
    ),
  )

const reviewKey = makePullRequestReviewKey("github", "fungsi", "diffdash", 66)
const originalBaseRevision = ReviewRevision.make("base-original")
const originalHeadRevision = ReviewRevision.make("head-original")
const currentBaseRevision = ReviewRevision.make("base-current")
const currentHeadRevision = ReviewRevision.make("head-current")

const originalDiff = parseUnifiedDiff(`diff --git a/src/retained.ts b/src/retained.ts
index 1111111..2222222 100644
--- a/src/retained.ts
+++ b/src/retained.ts
@@ -1 +1 @@
-export const retained = false
+export const retained = true
diff --git a/src/shifted.ts b/src/shifted.ts
index 1111111..2222222 100644
--- a/src/shifted.ts
+++ b/src/shifted.ts
@@ -10,2 +10,2 @@
 export const stable = true
-export const shifted = "old"
+export const shifted = "new"
diff --git a/src/changed.ts b/src/changed.ts
index 1111111..2222222 100644
--- a/src/changed.ts
+++ b/src/changed.ts
@@ -1 +1 @@
-export const changed = "old"
+export const changed = "first"
diff --git a/src/removed.ts b/src/removed.ts
index 1111111..2222222 100644
--- a/src/removed.ts
+++ b/src/removed.ts
@@ -1 +1 @@
-export const removed = false
+export const removed = true
diff --git a/src/ambiguous.ts b/src/ambiguous.ts
index 1111111..2222222 100644
--- a/src/ambiguous.ts
+++ b/src/ambiguous.ts
@@ -3 +3 @@
-export const duplicate = false
+export const duplicate = true
diff --git a/src/invalid.ts b/src/invalid.ts
index 1111111..2222222 100644
--- a/src/invalid.ts
+++ b/src/invalid.ts
@@ -5 +5 @@
-export const invalid = false
+export const invalid = true
diff --git a/src/old-name.ts b/src/old-name.ts
index 1111111..2222222 100644
--- a/src/old-name.ts
+++ b/src/old-name.ts
@@ -1 +1 @@
-export const renamed = false
+export const renamed = true`)

const currentDiff = parseUnifiedDiff(`diff --git a/src/retained.ts b/src/retained.ts
index 1111111..2222222 100644
--- a/src/retained.ts
+++ b/src/retained.ts
@@ -1 +1 @@
-export const retained = false
+export const retained = true
diff --git a/src/shifted.ts b/src/shifted.ts
index 1111111..2222222 100644
--- a/src/shifted.ts
+++ b/src/shifted.ts
@@ -20,2 +24,2 @@
 export const stable = true
-export const shifted = "old"
+export const shifted = "new"
diff --git a/src/changed.ts b/src/changed.ts
index 1111111..3333333 100644
--- a/src/changed.ts
+++ b/src/changed.ts
@@ -1 +1 @@
-export const changed = "old"
+export const changed = "second"
diff --git a/src/ambiguous.ts b/src/ambiguous.ts
index 1111111..2222222 100644
--- a/src/ambiguous.ts
+++ b/src/ambiguous.ts
@@ -30 +30 @@
-export const duplicate = false
+export const duplicate = true
@@ -40 +40 @@
-export const duplicate = false
+export const duplicate = true
diff --git a/src/invalid.ts b/src/invalid.ts
index 1111111..2222222 100644
--- a/src/invalid.ts
+++ b/src/invalid.ts
@@ -50 +50 @@
-export const invalid = false
+export const invalid = true
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
index 1111111..2222222 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1 +1 @@
-export const renamed = false
+export const renamed = true`)

const getHunk = (path: string) => {
  const file = originalDiff.files.find((candidate) => candidate.path === path)
  const hunk = file?.hunks[0]
  if (file === undefined || hunk === undefined) throw new Error(`Missing fixture hunk: ${path}`)
  return { file, hunk }
}

const makeLineAnchor = (path: string, lineNumber: number, lineContent: string) => {
  const { file, hunk } = getHunk(path)
  return LineReviewAnchor.make({
    fileId: file.fileId,
    filePath: file.path,
    oldPath: file.oldPath,
    hunkId: hunk.id,
    hunkFingerprint: hunk.fingerprint,
    hunkHeader: hunk.header,
    side: "new",
    lineNumber,
    lineContent,
  })
}

describe("ReviewThreadAnchorMapper", () => {
  it.scoped("FUN-66 AC: maps all anchor outcomes deterministically and idempotently", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repositories = yield* RepositoryStore
        const store = yield* ReviewThreadStore
        const mapper = yield* ReviewThreadAnchorMapper
        const repo = yield* repositories.upsertRepository({
          provider: "github",
          owner: "fungsi",
          name: "diffdash",
          remoteUrl: "https://github.com/fungsi/diffdash",
          localPath: null,
        })
        const anchors = [
          ["retained", makeLineAnchor("src/retained.ts", 1, "export const retained = true")],
          ["shifted-line", makeLineAnchor("src/shifted.ts", 11, 'export const shifted = "new"')],
          ["changed", makeLineAnchor("src/changed.ts", 1, 'export const changed = "first"')],
          ["removed", makeLineAnchor("src/removed.ts", 1, "export const removed = true")],
          [
            "ambiguous-line",
            makeLineAnchor("src/ambiguous.ts", 3, "export const duplicate = true"),
          ],
          ["invalid-line", makeLineAnchor("src/invalid.ts", 999, "not the anchored line")],
          ["renamed", makeLineAnchor("src/old-name.ts", 1, "export const renamed = true")],
        ] as const
        const ids = new Map<string, string>()
        for (const [name, anchor] of anchors) {
          const created = yield* store.create({
            repoId: repo.id,
            reviewKey,
            prNumber: 66,
            baseRevision: originalBaseRevision,
            headRevision: originalHeadRevision,
            anchor,
            bodyMarkdown: MarkdownBody.make(name),
          })
          ids.set(name, created.thread.id)
        }

        const first = yield* mapper.mapReview({
          repoId: repo.id,
          reviewKey,
          baseRevision: currentBaseRevision,
          headRevision: currentHeadRevision,
          parsedDiff: currentDiff,
        })
        const byName = new Map(
          first.map((thread) => [
            [...ids].find(([, id]) => id === thread.id)?.[0] ?? "missing",
            thread,
          ]),
        )

        expect(byName.get("retained")?.currentAnchor).toBeInstanceOf(LineReviewAnchor)
        expect(byName.get("retained")).toMatchObject({ anchorStatus: "active" })
        expect(byName.get("shifted-line")).toMatchObject({
          anchorStatus: "active",
          currentAnchor: { _tag: "line", lineNumber: 25 },
        })
        expect(byName.get("changed")).toMatchObject({
          anchorStatus: "unresolved_anchor",
          currentAnchor: null,
        })
        expect(byName.get("removed")).toMatchObject({
          anchorStatus: "outdated",
          currentAnchor: null,
        })
        expect(byName.get("ambiguous-line")).toMatchObject({
          anchorStatus: "unresolved_anchor",
          currentAnchor: null,
        })
        expect(byName.get("invalid-line")).toMatchObject({
          anchorStatus: "unresolved_anchor",
          currentAnchor: null,
        })
        expect(byName.get("renamed")).toMatchObject({
          anchorStatus: "active",
          currentAnchor: { _tag: "line", filePath: "src/new-name.ts", oldPath: "src/old-name.ts" },
        })
        expect(byName.get("changed")).toMatchObject({
          baseRevision: originalBaseRevision,
          headRevision: originalHeadRevision,
          currentBaseRevision,
          currentHeadRevision,
        })
        expect(byName.get("changed")?.originalAnchor).toEqual(
          makeLineAnchor("src/changed.ts", 1, 'export const changed = "first"'),
        )

        const second = yield* mapper.mapReview({
          repoId: repo.id,
          reviewKey,
          baseRevision: currentBaseRevision,
          headRevision: currentHeadRevision,
          parsedDiff: currentDiff,
        })
        expect(second).toEqual(first)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
