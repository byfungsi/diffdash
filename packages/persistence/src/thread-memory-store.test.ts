import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ThreadMemorySummaryAlgorithm } from "@diffdash/domain/agent-run"
import {
  makePullRequestReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore } from "./review-thread-store"
import { ThreadMemoryStore } from "./thread-memory-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-thread-memory-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, ReviewThreadStore.layer, ThreadMemoryStore.layer).pipe(
    Layer.provideMerge(DatabaseService.layer(databasePath)),
  )

const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-76"),
  filePath: "src/thread-memory.ts",
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-76"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-76"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "const memory = true",
})

const createThread = Effect.gen(function* () {
  const repositories = yield* RepositoryStore
  const threads = yield* ReviewThreadStore
  const repo = yield* repositories.upsertRepository({
    provider: "github",
    owner: "fungsi",
    name: "diffdash",
    remoteUrl: "https://github.com/fungsi/diffdash",
    localPath: null,
  })
  return yield* threads.create({
    repoId: repo.id,
    reviewKey: makePullRequestReviewKey("github", "fungsi", "diffdash", 76),
    prNumber: 76,
    baseRevision: ReviewRevision.make("base-sha"),
    headRevision: ReviewRevision.make("head-sha"),
    anchor: lineAnchor,
    bodyMarkdown: MarkdownBody.make("Initial question"),
  })
})

describe("ThreadMemoryStore", () => {
  it.scoped("FUN-76 AC: persists metadata and refuses stale watermark replacement", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const created = yield* createThread
        const store = yield* ThreadMemoryStore
        const algorithm = ThreadMemorySummaryAlgorithm.make("deterministic-transcript")
        const current = yield* store.upsert({
          threadId: created.thread.id,
          summary: "Current summary",
          summarizedThroughSequence: 8,
          summaryAlgorithm: algorithm,
          summaryVersion: 1,
          importantArtifactIds: [],
        })
        const staleResult = yield* store.upsert({
          threadId: created.thread.id,
          summary: "Stale summary",
          summarizedThroughSequence: 6,
          summaryAlgorithm: ThreadMemorySummaryAlgorithm.make("old-algorithm"),
          summaryVersion: 2,
          importantArtifactIds: [],
        })

        expect(current).toMatchObject({
          summary: "Current summary",
          summarizedThroughSequence: 8,
          summaryAlgorithm: algorithm,
          summaryVersion: 1,
        })
        expect(staleResult).toEqual(current)
        expect(yield* store.get(created.thread.id)).toEqual(current)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
