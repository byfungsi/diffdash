import { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import { Context, Effect, Layer, Schema } from "effect"

import { DatabaseService } from "./database"

const ViewedFileRow = Schema.Struct({
  patch_hash: ReviewFilePatchHash,
  review_key: Schema.String.pipe(Schema.minLength(1)),
})

const ViewedFileRows = Schema.Array(ViewedFileRow)

const viewedFileRecords = (
  rows: ReadonlyArray<typeof ViewedFileRow.Type>,
): readonly ViewedFileRecord[] =>
  rows.map((row) => ({
    patchHash: row.patch_hash,
    reviewKey: row.review_key,
  }))

/** A typed failure from viewed-file persistence operations. */
export class ViewedFileStoreError extends Schema.TaggedError<ViewedFileStoreError>()(
  "ViewedFileStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Persisted viewed identity for one file patch. */
interface ViewedFileRecord {
  readonly patchHash: ReviewFilePatchHash
  readonly reviewKey: string
}

/** Hosted review scope shared by viewed-file reads and writes. */
interface HostedViewedFileScope {
  readonly baseRefName: string
  readonly prNumber: number
  readonly repoId: string
}

/** Local review scope shared by viewed-file reads and writes. */
export interface LocalViewedFileScope {
  readonly comparisonKind: "workingTree" | "branch"
  readonly comparisonTarget: string
  readonly repoId: string
  readonly sourceIdentity: string
}

/** Viewed-file mutation for one exact hosted patch identity. */
interface SetHostedViewedFileInput extends HostedViewedFileScope, ViewedFileRecord {
  readonly viewed: boolean
}

/** Viewed-file mutation for one exact local patch identity. */
interface SetLocalViewedFileInput extends LocalViewedFileScope, ViewedFileRecord {
  readonly viewed: boolean
}

/** Domain-oriented persistence service for viewed file state. */
export class ViewedFileStore extends Context.Tag("@diffdash/ViewedFileStore")<
  ViewedFileStore,
  {
    readonly listHosted: (
      scope: HostedViewedFileScope,
    ) => Effect.Effect<readonly ViewedFileRecord[], ViewedFileStoreError>
    readonly listLocal: (
      scope: LocalViewedFileScope,
    ) => Effect.Effect<readonly ViewedFileRecord[], ViewedFileStoreError>
    readonly setHosted: (
      input: SetHostedViewedFileInput,
    ) => Effect.Effect<void, ViewedFileStoreError>
    readonly setLocal: (input: SetLocalViewedFileInput) => Effect.Effect<void, ViewedFileStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    ViewedFileStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      return ViewedFileStore.of({
        listHosted: Effect.fn("ViewedFileStore.listHosted")(function (scope) {
          return database
            .all(
              `SELECT review_key, patch_hash FROM hosted_viewed_files
               WHERE repo_id = ? AND pr_number = ? AND base_ref_name = ?
               ORDER BY viewed_at ASC`,
              [scope.repoId, scope.prNumber, scope.baseRefName],
            )
            .pipe(
              Effect.mapError((cause) =>
                ViewedFileStoreError.make({ operation: "listHosted.query", cause }),
              ),
              Effect.flatMap((rows) => decodeViewedFileRows("listHosted.decode", rows)),
            )
        }),
        listLocal: Effect.fn("ViewedFileStore.listLocal")(function (scope) {
          return database
            .all(
              `SELECT review_key, patch_hash FROM local_viewed_files
               WHERE repo_id = ? AND source_identity = ?
                 AND comparison_kind = ? AND comparison_target = ?
               ORDER BY viewed_at ASC`,
              [scope.repoId, scope.sourceIdentity, scope.comparisonKind, scope.comparisonTarget],
            )
            .pipe(
              Effect.mapError((cause) =>
                ViewedFileStoreError.make({ operation: "listLocal.query", cause }),
              ),
              Effect.flatMap((rows) => decodeViewedFileRows("listLocal.decode", rows)),
            )
        }),
        setHosted: Effect.fn("ViewedFileStore.setHosted")(function (input) {
          const statement = input.viewed
            ? `INSERT OR REPLACE INTO hosted_viewed_files (
                 repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at
               ) VALUES (?, ?, ?, ?, ?, ?)`
            : `DELETE FROM hosted_viewed_files
               WHERE repo_id = ? AND pr_number = ? AND base_ref_name = ?
                 AND review_key = ? AND patch_hash = ?`
          const parameters: readonly unknown[] = input.viewed
            ? [
                input.repoId,
                input.prNumber,
                input.baseRefName,
                input.reviewKey,
                input.patchHash,
                new Date().toISOString(),
              ]
            : [input.repoId, input.prNumber, input.baseRefName, input.reviewKey, input.patchHash]
          return database
            .run(statement, parameters)
            .pipe(
              Effect.mapError((cause) =>
                ViewedFileStoreError.make({ operation: "setHosted", cause }),
              ),
            )
        }),
        setLocal: Effect.fn("ViewedFileStore.setLocal")(function (input) {
          const statement = input.viewed
            ? `INSERT OR REPLACE INTO local_viewed_files (
                 repo_id, source_identity, comparison_kind, comparison_target,
                 review_key, patch_hash, viewed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            : `DELETE FROM local_viewed_files
               WHERE repo_id = ? AND source_identity = ?
                 AND comparison_kind = ? AND comparison_target = ?
                 AND review_key = ? AND patch_hash = ?`
          const identity: readonly unknown[] = [
            input.repoId,
            input.sourceIdentity,
            input.comparisonKind,
            input.comparisonTarget,
            input.reviewKey,
            input.patchHash,
          ]
          return database
            .run(statement, input.viewed ? [...identity, new Date().toISOString()] : identity)
            .pipe(
              Effect.mapError((cause) =>
                ViewedFileStoreError.make({ operation: "setLocal", cause }),
              ),
            )
        }),
      })
    }),
  )
}

const decodeViewedFileRows = (operation: string, input: readonly unknown[]) =>
  Schema.decodeUnknown(ViewedFileRows)(input).pipe(
    Effect.map(viewedFileRecords),
    Effect.mapError((cause) => ViewedFileStoreError.make({ operation, cause })),
  )
