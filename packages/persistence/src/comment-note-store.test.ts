import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CommentNoteId,
  CommentNoteSubject,
  HostedCommentNoteContext,
  MAX_COMMENT_NOTES_PER_PROJECT,
  ProjectCommentNoteContext,
} from "@diffdash/domain/comment-note"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import * as DatabaseNode from "./database-node"
import { makeDatabase } from "./database"
import { CommentNoteStore } from "./comment-note-store"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const projectContext = ProjectCommentNoteContext.make({})
const reviewContext = HostedCommentNoteContext.make({
  review: makeHostedReviewLocator("github", "fungsi", "diffdash", 42),
  baseRefName: RepositoryComparisonRef.make("main"),
})
const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-comment-note-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "test.sqlite")))

const insertProject = Effect.gen(function* () {
  const database = makeDatabase(yield* SqlClient.SqlClient)
  yield* database.run(
    `INSERT INTO repos (
      id, provider, owner, name, remote_url, local_path, is_favorite,
      last_opened_at, last_synced_at, created_at, updated_at
    ) VALUES (?, 'github', 'fungsi', 'diffdash', 'https://github.com/fungsi/diffdash',
      '/workspace/diffdash', 0, NULL, NULL, ?, ?)`,
    [projectId, "2026-08-29T10:00:00.000Z", "2026-08-29T10:00:00.000Z"],
  )
})

describe("CommentNoteStore", () => {
  it.effect("isolates ordered context notes and supports individual and bulk removal", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const layer = CommentNoteStore.layer.pipe(
        Layer.provideMerge(DatabaseNode.layer(databasePath)),
      )
      yield* Effect.gen(function* () {
        yield* insertProject
        const store = yield* CommentNoteStore
        const subject = CommentNoteSubject.cases.CodeLine.make({
          workspaceRevision: ReviewRevision.make("workspace-1"),
          gitRevision: null,
          path: RepositoryRelativePath.make("src/index.ts"),
          lineNumber: 12,
          lineContent: "return value",
        })
        yield* store.create({
          id: CommentNoteId.make("note-b"),
          projectId,
          context: projectContext,
          subject,
          body: MarkdownBody.make("Second"),
          createdAt: "2026-08-29T10:01:00.000Z",
        })
        yield* store.create({
          id: CommentNoteId.make("note-a"),
          projectId,
          context: projectContext,
          subject,
          body: MarkdownBody.make("First"),
          createdAt: "2026-08-29T10:00:00.000Z",
        })
        yield* store.create({
          id: CommentNoteId.make("review-note"),
          projectId,
          context: reviewContext,
          subject,
          body: MarkdownBody.make("Review only"),
          createdAt: "2026-08-29T10:02:00.000Z",
        })

        expect((yield* store.list(projectId, projectContext)).map((note) => note.id)).toEqual([
          "note-a",
          "note-b",
        ])
        expect((yield* store.list(projectId, reviewContext)).map((note) => note.id)).toEqual([
          "review-note",
        ])

        yield* store.delete(projectId, projectContext, CommentNoteId.make("note-a"))
        expect((yield* store.list(projectId, projectContext)).map((note) => note.id)).toEqual([
          "note-b",
        ])

        yield* store.clear(projectId, projectContext)
        expect(yield* store.list(projectId, projectContext)).toEqual([])
        expect((yield* store.list(projectId, reviewContext)).map((note) => note.id)).toEqual([
          "review-note",
        ])
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("rejects creation before a project exceeds the list contract", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const layer = CommentNoteStore.layer.pipe(
        Layer.provideMerge(DatabaseNode.layer(databasePath)),
      )
      yield* Effect.gen(function* () {
        yield* insertProject
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const store = yield* CommentNoteStore
        const subject = CommentNoteSubject.cases.CodeLine.make({
          workspaceRevision: ReviewRevision.make("workspace-1"),
          gitRevision: null,
          path: RepositoryRelativePath.make("src/index.ts"),
          lineNumber: 12,
          lineContent: "return value",
        })
        const subjectJson = Schema.encodeSync(Schema.fromJsonString(CommentNoteSubject))(subject)
        yield* database.run(
          `WITH RECURSIVE note_numbers(value) AS (
             SELECT 1
             UNION ALL
             SELECT value + 1 FROM note_numbers WHERE value < ?
           )
           INSERT INTO comment_notes (id, repo_id, subject_json, body_markdown, created_at)
           SELECT 'limit-note-' || value, ?, ?, 'At limit', ? FROM note_numbers`,
          [MAX_COMMENT_NOTES_PER_PROJECT, projectId, subjectJson, "2026-08-29T10:00:00.000Z"],
        )

        const failure = yield* Effect.flip(
          store.create({
            id: CommentNoteId.make("one-too-many"),
            projectId,
            context: reviewContext,
            subject,
            body: MarkdownBody.make("Must be rejected"),
            createdAt: "2026-08-29T10:01:00.000Z",
          }),
        )

        expect(failure).toMatchObject({ operation: "create.query" })
      }).pipe(Effect.provide(layer))
    }),
  )
})
