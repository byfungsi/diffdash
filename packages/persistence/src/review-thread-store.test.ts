import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentPromptVersion } from "@diffdash/domain/agent-run"
import { CommentSubjectMismatchError } from "@diffdash/domain/comment"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  makeReviewKey,
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  CurrentReviewAnchor,
  HostedReviewTarget,
  LineReviewAnchor,
  MarkdownBody,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { makeDatabase } from "./database"
import * as DatabaseNode from "./database-node"
import { RepositoryStore } from "./repository-store"
import { ReviewThreadStore, ReviewThreadStoreError } from "./review-thread-store"
import { ReviewTurnStore } from "./review-turn-store"
import { ReviewLifecycleRowDecodeError } from "./review-turn-row"
import { hostedTestRepositoryInput } from "./test-support/repository"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-thread-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const makeLayer = (databasePath: string) =>
  Layer.mergeAll(RepositoryStore.layer, ReviewThreadStore.layer, ReviewTurnStore.layer).pipe(
    Layer.provideMerge(DatabaseNode.layer(databasePath)),
  )

const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 51)
const reviewKey = makeReviewKey(review)
const baseRevision = ReviewRevision.make("base-sha")
const headRevision = ReviewRevision.make("head-sha")
const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-51"),
  filePath: RepositoryRelativePath.make("src/app.ts"),
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
  return yield* repositories.upsertRepository(hostedTestRepositoryInput())
})

describe("ReviewThreadStore", () => {
  it.effect("FUN-67 AC: atomically creates a thread and initial Markdown message", () =>
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
          currentAnchor: { _tag: "Active", anchor: lineAnchor },
          reviewKey,
        })
        expect(created.thread.originalAnchor).toBeInstanceOf(LineReviewAnchor)
        expect(created.messages).toHaveLength(1)
        expect(created.messages[0]).toMatchObject({
          _tag: "User",
          sequence: 1,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: allows only one thread for an exact review line", () =>
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
        const duplicate = yield* Effect.result(store.create(input))
        const threads = yield* store.listForReview({ repoId: repo.id, reviewKey })

        expect(Result.isFailure(duplicate)).toBe(true)
        expect(threads).toHaveLength(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("decodes legacy carried_forward rows deterministically", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Legacy carried anchor"),
        })

        yield* database.run(
          "UPDATE review_threads SET anchor_status = 'carried_forward' WHERE id = ?",
          [created.thread.id],
        )
        expect((yield* store.get(created.thread.id)).thread.currentAnchor).toMatchObject({
          _tag: "Active",
          anchor: lineAnchor,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects impossible legacy message lifecycle rows with a typed decode cause", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Impossible legacy message"),
        })
        yield* database.run(
          "UPDATE review_thread_messages SET status = 'pending' WHERE thread_id = ?",
          [created.thread.id],
        )

        const result = yield* Effect.result(store.get(created.thread.id))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ReviewThreadStoreError)
          expect(result.failure.cause).toBeInstanceOf(ReviewLifecycleRowDecodeError)
          if (!(result.failure.cause instanceof ReviewLifecycleRowDecodeError)) {
            throw new Error("Expected lifecycle row decode error")
          }
          expect(result.failure.cause.reason).toContain(
            "User messages must be complete and cannot own runs or failures.",
          )
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: persists a line-only anchor", () =>
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

  it.effect("FUN-67 AC: appends a follow-up after the prior agent response", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const turns = yield* ReviewTurnStore
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Initial question"),
        })

        const blocked = yield* Effect.result(
          store.addUserMessage({
            threadId: created.thread.id,
            bodyMarkdown: MarkdownBody.make("Too soon"),
          }),
        )
        const targetInput = {
          threadId: created.thread.id,
          target: HostedReviewTarget.make({ kind: "hosted", review }),
          repoId: repo.id,
          reviewKey,
          baseRevision,
          headRevision,
        }
        const mapping = yield* turns.validateTarget(targetInput)
        const begun = yield* turns.beginTurn({
          ...targetInput,
          mapping,
          provider: ReviewAgentProviderId.make("opencode"),
          model: "test-model",
          promptVersion: AgentPromptVersion.make("review-thread-v3"),
        })
        yield* turns.completeTurn({
          threadId: created.thread.id,
          runId: begun.run.id,
          messageId: begun.pendingMessage.id,
          bodyMarkdown: MarkdownBody.make("Initial response"),
          artifacts: [],
          providerRunId: null,
          usage: null,
          memoryUpdate: null,
        })
        const mismatched = yield* Effect.result(
          store.addUserMessageForSubject({
            threadId: created.thread.id,
            repoId: repo.id,
            reviewKey,
            currentBaseRevision: baseRevision,
            currentHeadRevision: headRevision,
            currentAnchor: LineReviewAnchor.make({ ...lineAnchor, lineNumber: 2 }),
            bodyMarkdown: MarkdownBody.make("Wrong-line follow-up"),
          }),
        )
        const afterMismatch = yield* store.get(created.thread.id)
        const updated = yield* store.addUserMessageForSubject({
          threadId: created.thread.id,
          repoId: repo.id,
          reviewKey,
          currentBaseRevision: baseRevision,
          currentHeadRevision: headRevision,
          currentAnchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Follow-up question"),
        })

        expect(updated.messages.map(({ _tag, sequence }) => ({ _tag, sequence }))).toEqual([
          { _tag: "User", sequence: 1 },
          { _tag: "Completed", sequence: 2 },
          { _tag: "User", sequence: 3 },
        ])
        expect(Result.isFailure(blocked)).toBe(true)
        expect(Result.isFailure(mismatched)).toBe(true)
        if (Result.isFailure(mismatched)) {
          expect(mismatched.failure).toBeInstanceOf(CommentSubjectMismatchError)
        }
        expect(afterMismatch.messages).toHaveLength(2)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: scopes lists by review key and current head revision", () =>
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

  it.effect("FUN-67 AC: rejects malformed persisted rows at the store boundary", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
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

        const result = yield* Effect.result(store.get(created.thread.id))
        const listResult = yield* Effect.result(store.listForReview({ repoId: repo.id, reviewKey }))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ReviewThreadStoreError)
        expect(Result.isFailure(listResult)).toBe(true)
        if (Result.isFailure(listResult))
          expect(listResult.failure.operation).toBe("listForReview.decode")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects corrupt ignored columns and message rows", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const created = yield* store.create({
          repoId: repo.id,
          reviewKey,
          prNumber: 51,
          baseRevision,
          headRevision,
          anchor: lineAnchor,
          bodyMarkdown: MarkdownBody.make("Corrupt persisted columns"),
        })

        yield* database.run("UPDATE review_threads SET closed_at = x'01' WHERE id = ?", [
          created.thread.id,
        ])
        const corruptThread = yield* Effect.result(store.get(created.thread.id))
        expect(Result.isFailure(corruptThread)).toBe(true)
        if (Result.isFailure(corruptThread)) {
          expect(corruptThread.failure).toBeInstanceOf(ReviewThreadStoreError)
          expect(corruptThread.failure.operation).toBe("get")
        }

        yield* database.run("UPDATE review_threads SET closed_at = NULL WHERE id = ?", [
          created.thread.id,
        ])
        yield* database.run(
          "UPDATE review_thread_messages SET sequence = 1.5 WHERE thread_id = ?",
          [created.thread.id],
        )
        const corruptMessage = yield* Effect.result(store.get(created.thread.id))
        expect(Result.isFailure(corruptMessage)).toBe(true)
        if (Result.isFailure(corruptMessage)) {
          expect(corruptMessage.failure).toBeInstanceOf(ReviewThreadStoreError)
          expect(corruptMessage.failure.operation).toBe("get")
        }
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-67 AC: reports missing thread IDs as typed store errors", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const store = yield* ReviewThreadStore
        const result = yield* Effect.result(store.get(ReviewThreadId.make("missing")))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.operation).toBe("get")
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("FUN-66 AC: atomically updates current mappings without changing originals", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath

      yield* Effect.gen(function* () {
        const repo = yield* createRepo
        const store = yield* ReviewThreadStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
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
            currentAnchor: CurrentReviewAnchor.cases.Outdated.make({}),
          },
        ])

        expect(mapped[0]).toMatchObject({
          baseRevision,
          headRevision,
          originalAnchor: lineAnchor,
          currentBaseRevision: nextBase,
          currentHeadRevision: nextHead,
          currentAnchor: { _tag: "Outdated" },
        })
        expect(
          Option.getOrThrow(
            yield* database.get(
              "SELECT current_anchor_json, anchor_status FROM review_threads WHERE id = ?",
              [created.thread.id],
            ),
          ),
        ).toEqual({ current_anchor_json: null, anchor_status: "outdated" })

        const failed = yield* Effect.result(
          store.updateCurrentMappings([
            {
              threadId: created.thread.id,
              currentBaseRevision: ReviewRevision.make("rolled-back-base"),
              currentHeadRevision: ReviewRevision.make("rolled-back-head"),
              currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor: lineAnchor }),
            },
            {
              threadId: ReviewThreadId.make("missing"),
              currentBaseRevision: nextBase,
              currentHeadRevision: nextHead,
              currentAnchor: CurrentReviewAnchor.cases.Outdated.make({}),
            },
          ]),
        )
        expect(Result.isFailure(failed)).toBe(true)

        const afterRollback = yield* store.get(created.thread.id)
        expect(afterRollback.thread).toMatchObject({
          currentBaseRevision: nextBase,
          currentHeadRevision: nextHead,
          currentAnchor: { _tag: "Outdated" },
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
