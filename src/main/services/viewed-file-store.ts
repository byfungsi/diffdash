import { Context, Effect, Layer, Schema } from "effect"

import { DatabaseService } from "./database"

interface ViewedFileRow {
  readonly review_key: string
}

/** A typed failure from viewed-file persistence operations. */
export class ViewedFileStoreError extends Schema.TaggedError<ViewedFileStoreError>()(
  "ViewedFileStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Input for identifying viewed-file state for one PR head. */
export interface ViewedFileReviewKey {
  readonly repoId: string
  readonly prNumber: number | null
  readonly headSha: string
}

/** Input for marking or unmarking one file as viewed. */
export interface SetViewedFileInput extends ViewedFileReviewKey {
  readonly filePath: string
  readonly reviewKey: string
  readonly viewed: boolean
}

/** Domain-oriented persistence service for viewed file state. */
export class ViewedFileStore extends Context.Tag("@diffdash/ViewedFileStore")<
  ViewedFileStore,
  {
    readonly list: (
      key: ViewedFileReviewKey,
    ) => Effect.Effect<readonly string[], ViewedFileStoreError>
    readonly set: (input: SetViewedFileInput) => Effect.Effect<void, ViewedFileStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    ViewedFileStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      return ViewedFileStore.of({
        list: Effect.fn("ViewedFileStore.list")(function (key) {
          return database
            .all<ViewedFileRow>(
              `SELECT review_key FROM viewed_files
               WHERE repo_id = ? AND pr_number IS ? AND head_sha = ?
               ORDER BY viewed_at ASC`,
              [key.repoId, key.prNumber, key.headSha],
            )
            .pipe(
              Effect.map((rows) => rows.map((row) => row.review_key)),
              Effect.mapError((cause) => ViewedFileStoreError.make({ operation: "list", cause })),
            )
        }),
        set: Effect.fn("ViewedFileStore.set")(function (input) {
          if (!input.viewed) {
            return database
              .run(
                `DELETE FROM viewed_files
                 WHERE repo_id = ? AND pr_number IS ? AND review_key = ? AND file_path = ? AND head_sha = ?`,
                [input.repoId, input.prNumber, input.reviewKey, input.filePath, input.headSha],
              )
              .pipe(
                Effect.mapError((cause) =>
                  ViewedFileStoreError.make({ operation: "set.delete", cause }),
                ),
              )
          }

          return database
            .run(
              `INSERT OR REPLACE INTO viewed_files (
                 repo_id, pr_number, review_key, file_path, head_sha, viewed_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                input.repoId,
                input.prNumber,
                input.reviewKey,
                input.filePath,
                input.headSha,
                new Date().toISOString(),
              ],
            )
            .pipe(
              Effect.mapError((cause) =>
                ViewedFileStoreError.make({ operation: "set.insert", cause }),
              ),
            )
        }),
      })
    }),
  )
}
