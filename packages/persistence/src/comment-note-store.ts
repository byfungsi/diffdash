import { Context, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import {
  CommentNote,
  type CommentNoteContext,
  commentNoteContextKey,
  CommentNoteId,
  CommentNoteSubject,
  MAX_COMMENT_NOTES_PER_PROJECT,
} from "@diffdash/domain/comment-note"
import { UtcIsoTimestamp } from "@diffdash/domain/domain-scalar"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { MarkdownBody } from "@diffdash/domain/review-thread"
import { type DatabaseRow, makeDatabase, toError } from "./database"

const CommentNoteSubjectJson = Schema.fromJsonString(CommentNoteSubject)
const CommentNoteRow = Schema.Struct({
  id: CommentNoteId,
  repo_id: ReviewProjectId,
  subject_json: CommentNoteSubjectJson,
  body_markdown: MarkdownBody,
  created_at: UtcIsoTimestamp,
})
const CommentNoteCountRow = Schema.Struct({ count: Schema.Number })

const CommentNoteStoreOperation = Schema.Literals([
  "list.query",
  "list.decode",
  "create.encodeSubject",
  "create.query",
  "create.decode",
  "delete.query",
  "deleteMany.query",
  "clear.query",
])
type CommentNoteStoreOperation = typeof CommentNoteStoreOperation.Type

/** Input for persisting one context-scoped source note. */
export interface CreateCommentNoteInput {
  readonly id: CommentNoteId
  readonly projectId: ReviewProjectId
  readonly context: CommentNoteContext
  readonly subject: typeof CommentNoteSubject.Type
  readonly body: MarkdownBody
  readonly createdAt: typeof UtcIsoTimestamp.Type
}

/** A typed failure from collected comment-note persistence. */
export class CommentNoteStoreError extends Schema.TaggedError<CommentNoteStoreError>()(
  "CommentNoteStoreError",
  {
    operation: CommentNoteStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** SQLite authority for context-scoped notes awaiting copy or bulk delivery. */
export class CommentNoteStore extends Context.Service<
  CommentNoteStore,
  {
    readonly list: (
      projectId: ReviewProjectId,
      context: CommentNoteContext,
    ) => Effect.Effect<readonly CommentNote[], CommentNoteStoreError>
    readonly create: (
      input: CreateCommentNoteInput,
    ) => Effect.Effect<CommentNote, CommentNoteStoreError>
    readonly delete: (
      projectId: ReviewProjectId,
      context: CommentNoteContext,
      noteId: CommentNoteId,
    ) => Effect.Effect<void, CommentNoteStoreError>
    readonly deleteMany: (
      projectId: ReviewProjectId,
      context: CommentNoteContext,
      noteIds: readonly CommentNoteId[],
    ) => Effect.Effect<void, CommentNoteStoreError>
    readonly clear: (
      projectId: ReviewProjectId,
      context: CommentNoteContext,
    ) => Effect.Effect<void, CommentNoteStoreError>
  }
>()("@diffdash/CommentNoteStore") {
  static readonly layer = Layer.effect(
    CommentNoteStore,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)

      const list = Effect.fn("CommentNoteStore.list")(function* (
        projectId: ReviewProjectId,
        context: CommentNoteContext,
      ) {
        const rows = yield* database
          .all(
            `SELECT * FROM comment_notes
             WHERE repo_id = ? AND context_key = ?
             ORDER BY created_at ASC, id ASC`,
            [projectId, commentNoteContextKey(context)],
          )
          .pipe(
            Effect.mapError((cause) =>
              CommentNoteStoreError.make({ operation: "list.query", cause }),
            ),
          )
        return yield* Effect.forEach(rows, (row) => decodeCommentNoteRow("list.decode", row))
      })

      const create = Effect.fn("CommentNoteStore.create")(function* (
        input: CreateCommentNoteInput,
      ) {
        const subjectJson = yield* Schema.encodeEffect(CommentNoteSubjectJson)(input.subject).pipe(
          Effect.mapError((cause) =>
            CommentNoteStoreError.make({ operation: "create.encodeSubject", cause }),
          ),
        )
        const contextKey = commentNoteContextKey(input.context)
        yield* database
          .transaction(
            Effect.gen(function* () {
              const countRow = yield* database.get(
                "SELECT COUNT(*) AS count FROM comment_notes WHERE repo_id = ?",
                [input.projectId],
              )
              const row = yield* Effect.fromOption(
                countRow,
                () => new Error("The comment note count query returned no row"),
              )
              const { count } = yield* Schema.decodeUnknownEffect(CommentNoteCountRow)(row)
              if (count >= MAX_COMMENT_NOTES_PER_PROJECT) {
                yield* Effect.fail(new Error("This project has reached the collected note limit"))
              }
              yield* database.run(
                `INSERT INTO comment_notes (
                   id, repo_id, context_key, subject_json, body_markdown, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                [input.id, input.projectId, contextKey, subjectJson, input.body, input.createdAt],
              )
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              CommentNoteStoreError.make({
                operation: "create.query",
                cause: toError(cause),
              }),
            ),
          )
        return yield* decodeCommentNoteRow("create.decode", {
          id: input.id,
          repo_id: input.projectId,
          subject_json: subjectJson,
          body_markdown: input.body,
          created_at: input.createdAt,
        })
      })

      const deleteNote = Effect.fn("CommentNoteStore.delete")(function* (
        projectId: ReviewProjectId,
        context: CommentNoteContext,
        noteId: CommentNoteId,
      ) {
        yield* database
          .run("DELETE FROM comment_notes WHERE repo_id = ? AND context_key = ? AND id = ?", [
            projectId,
            commentNoteContextKey(context),
            noteId,
          ])
          .pipe(
            Effect.mapError((cause) =>
              CommentNoteStoreError.make({ operation: "delete.query", cause }),
            ),
          )
      })

      const clear = Effect.fn("CommentNoteStore.clear")(function* (
        projectId: ReviewProjectId,
        context: CommentNoteContext,
      ) {
        yield* database
          .run("DELETE FROM comment_notes WHERE repo_id = ? AND context_key = ?", [
            projectId,
            commentNoteContextKey(context),
          ])
          .pipe(
            Effect.mapError((cause) =>
              CommentNoteStoreError.make({ operation: "clear.query", cause }),
            ),
          )
      })

      const deleteMany = Effect.fn("CommentNoteStore.deleteMany")(function* (
        projectId: ReviewProjectId,
        context: CommentNoteContext,
        noteIds: readonly CommentNoteId[],
      ) {
        if (noteIds.length === 0) return
        const placeholders = noteIds.map(() => "?").join(", ")
        yield* database
          .run(
            `DELETE FROM comment_notes
             WHERE repo_id = ? AND context_key = ? AND id IN (${placeholders})`,
            [projectId, commentNoteContextKey(context), ...noteIds],
          )
          .pipe(
            Effect.mapError((cause) =>
              CommentNoteStoreError.make({ operation: "deleteMany.query", cause }),
            ),
          )
      })

      return CommentNoteStore.of({ list, create, delete: deleteNote, deleteMany, clear })
    }),
  )
}

const decodeCommentNoteRow = (operation: CommentNoteStoreOperation, input: DatabaseRow) =>
  Schema.decodeUnknownEffect(CommentNoteRow)(input).pipe(
    Effect.mapError((cause) => CommentNoteStoreError.make({ operation, cause })),
    Effect.map((row) =>
      CommentNote.make({
        id: row.id,
        projectId: row.repo_id,
        subject: row.subject_json,
        body: row.body_markdown,
        createdAt: row.created_at,
      }),
    ),
  )
