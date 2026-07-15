import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  makePullRequestReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { LineReviewAnchor, MarkdownBody, ReviewThreadId } from "@diffdash/domain/review-thread"
import { AppConfig } from "./app-config"
import { DatabaseService } from "./database"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore, ReviewThreadStoreError } from "./review-thread-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-thread-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, ReviewThreadStore.layer).pipe(
    Layer.provideMerge(DatabaseService.layer),
    Layer.provide(
      AppConfig.layer({
        databasePath,
        settingsPath: join(dirname(databasePath), "settings.json"),
        tempDir: tmpdir(),
      }),
    ),
  )

const reviewKey = makePullRequestReviewKey("github", "fungsi", "diffdash", 51)
const baseRevision = ReviewRevision.make("base-sha")
const headRevision = ReviewRevision.make("head-sha")
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-51"),
  filePath: "src/app.ts",
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-51"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-51"),
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "new",
})

const createRepo = Effect.gen(function* () {
  const repositories = yield* RepositoryStore
  return yield* repositories.upsertRepository({
    provider: "github",
    owner: "fungsi",
    name: "diffdash",
    remoteUrl: "https://github.com/fungsi/diffdash",
    localPath: null,
  })
})

describe("ReviewThreadStore", () => {
  it.scoped("FUN-67 AC: atomically creates a thread and initial Markdown message", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("## Question\n\nWhy is this needed?"),
        })

        expect(created.thread).toMatchObject({
          anchorStatus: "active",
          reviewKey,
        })
        expect(created.thread.originalAnchor).toBeInstanceOf(LineReviewAnchor)
        expect(created.messages).toHaveLength(1)
        expect(created.messages[0]).toMatchObject({
          author: "user",
          sequence: 1,
          status: "complete",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: allows only one thread for an exact review line", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const input = {
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Only one comment belongs here."),
        }
        yield* store.create(input)
        const duplicate = yield* Effect.either(store.create(input))
        const threads = yield* store.listForReview({ repoId: repo.id, reviewKey })

        expect(Either.isLeft(duplicate)).toBe(true)
        expect(threads).toHaveLength(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: creates one pending agent response after the initial line comment", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Initial question"),
        })

        yield* store.createPendingAgentMessage({
          threadId: created.thread.id,
          agentRunId: "run-1",
        })
        const details = yield* store.get(created.thread.id)

        expect(details.messages.map(({ author, sequence }) => ({ author, sequence }))).toEqual([
          { author: "user", sequence: 1 },
          { author: "agent", sequence: 2 },
        ])
        expect(details.messages[1]).toMatchObject({ bodyMarkdown: "", status: "pending" })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: persists a line-only anchor", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const file = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new`).files[0]
        const hunk = file?.hunks[0]
        if (file === undefined || hunk === undefined)
          throw new Error("Expected parsed diff fixture")
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: LineReviewAnchor.make({
            fileId: file.fileId,
            filePath: file.path,
            oldPath: file.oldPath,
            hunkId: hunk.id,
            hunkFingerprint: hunk.fingerprint,
            hunkHeader: hunk.header,
            side: "new",
            lineNumber: 1,
            lineContent: "new",
          }),
          bodyMarkdown: MarkdownBody.make("Anchor round trip"),
        })

        expect(created.thread.originalAnchor).toBeInstanceOf(LineReviewAnchor)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: appends a follow-up after the prior agent response", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Initial question"),
        })

        const blocked = yield* Effect.either(
          store.addUserMessage({
            threadId: created.thread.id,
            bodyMarkdown: MarkdownBody.make("Too soon"),
          }),
        )
        yield* store.createPendingAgentMessage({ threadId: created.thread.id, agentRunId: "run-1" })
        const pendingDetails = yield* store.get(created.thread.id)
        const pendingMessage = pendingDetails.messages[1]
        if (pendingMessage === undefined) throw new Error("Expected pending agent message")
        yield* store.completeAgentMessage({
          messageId: pendingMessage.id,
          threadId: created.thread.id,
          bodyMarkdown: MarkdownBody.make("Initial response"),
          status: "complete",
        })
        const updated = yield* store.addUserMessage({
          threadId: created.thread.id,
          bodyMarkdown: MarkdownBody.make("Follow-up question"),
        })

        expect(updated.messages.map(({ author, sequence }) => ({ author, sequence }))).toEqual([
          { author: "user", sequence: 1 },
          { author: "agent", sequence: 2 },
          { author: "user", sequence: 3 },
        ])
        expect(Either.isLeft(blocked)).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: scopes lists by review key and current head revision", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Scoped thread"),
        })

        const reviewThreads = yield* store.listForReview({ repoId: repo.id, reviewKey })
        const currentRevision = yield* store.listForRevision({
          repoId: repo.id,
          reviewKey,
          headRevision,
        })
        const otherRevision = yield* store.listForRevision({
          repoId: repo.id,
          reviewKey,
          headRevision: ReviewRevision.make("other-head"),
        })

        expect(reviewThreads).toHaveLength(1)
        expect(currentRevision).toHaveLength(1)
        expect(otherRevision).toHaveLength(0)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: rejects malformed persisted rows at the store boundary", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const database = yield* DatabaseService
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Malformed later"),
        })
        yield* database.run("UPDATE review_threads SET original_anchor_json = ? WHERE id = ?", [
          "not-json",
          created.thread.id,
        ])

        const result = yield* Effect.either(store.get(created.thread.id))
        const listResult = yield* Effect.either(store.listForReview({ repoId: repo.id, reviewKey }))

        expect(Either.isLeft(result)).toBe(true)
        if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ReviewThreadStoreError)
        expect(Either.isLeft(listResult)).toBe(true)
        if (Either.isLeft(listResult))
          expect(listResult.left.operation).toBe("listForReview.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-67 AC: reports missing thread IDs as typed store errors", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* ReviewThreadStore
        const result = yield* Effect.either(store.get(ReviewThreadId.make("missing")))

        expect(Either.isLeft(result)).toBe(true)
        if (Either.isLeft(result)) expect(result.left.operation).toBe("get")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.scoped("FUN-66 AC: atomically updates current mappings without changing originals", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Map atomically"),
        })
        const nextBase = ReviewRevision.make("next-base")
        const nextHead = ReviewRevision.make("next-head")
        const mapped = yield* store.updateCurrentMappings([
          {
            threadId: created.thread.id,
            currentBaseRevision: nextBase,
            currentHeadRevision: nextHead,
            currentAnchor: null,
            anchorStatus: "outdated",
          },
        ])

        expect(mapped[0]).toMatchObject({
          baseRevision,
          headRevision,
          originalAnchor: lineAnchor,
          currentBaseRevision: nextBase,
          currentHeadRevision: nextHead,
          currentAnchor: null,
          anchorStatus: "outdated",
        })

        const failed = yield* Effect.either(
          store.updateCurrentMappings([
            {
              threadId: created.thread.id,
              currentBaseRevision: ReviewRevision.make("rolled-back-base"),
              currentHeadRevision: ReviewRevision.make("rolled-back-head"),
              currentAnchor: lineAnchor,
              anchorStatus: "active",
            },
            {
              threadId: ReviewThreadId.make("missing"),
              currentBaseRevision: nextBase,
              currentHeadRevision: nextHead,
              currentAnchor: null,
              anchorStatus: "outdated",
            },
          ]),
        )
        expect(Either.isLeft(failed)).toBe(true)

        const afterRollback = yield* store.get(created.thread.id)
        expect(afterRollback.thread).toMatchObject({
          currentBaseRevision: nextBase,
          currentHeadRevision: nextHead,
          currentAnchor: null,
          anchorStatus: "outdated",
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
