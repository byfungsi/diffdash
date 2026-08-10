import {
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  type ReviewProjectId as ReviewProjectIdType,
} from "@diffdash/domain/review-identity"
import type { RepositoryComparisonRef as RepositoryComparisonRefType } from "@diffdash/domain/repository-comparison"
import { Context, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { makeDatabase, type DatabaseRow, type SqlParams } from "./database"

const ViewedFileRow = Schema.Struct({
  patch_hash: ReviewFilePatchHash,
  review_key: ReviewKey,
})

const ViewedFileRows = Schema.Array(ViewedFileRow)

const ViewedFileStoreOperation = Schema.Literals([
  "listHosted.query",
  "listHosted.decode",
  "listLocal.query",
  "listLocal.decode",
  "setHosted",
  "setLocal",
])
type ViewedFileStoreOperation = typeof ViewedFileStoreOperation.Type

/** A typed failure from viewed-file persistence operations. */
export class ViewedFileStoreError extends Schema.TaggedError<ViewedFileStoreError>()(
  "ViewedFileStoreError",
  {
    operation: ViewedFileStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Persisted viewed identity for one file patch. */
interface ViewedFileRecord {
  readonly patchHash: ReviewFilePatchHash
  readonly reviewKey: ReviewKey
}

/** Hosted review scope shared by viewed-file reads and writes. */
interface HostedViewedFileScope {
  readonly baseRefName: RepositoryComparisonRefType
  readonly prNumber: number
  readonly repoId: ReviewProjectIdType
}

/** Local and repository-comparison scope shared by viewed-file reads and writes. */
export const LocalViewedFileScope = Schema.Struct({
  comparisonKind: Schema.Literals(["workingTree", "branch", "repositoryComparison"]),
  comparisonTarget: Schema.String,
  repoId: ReviewProjectId,
  sourceIdentity: Schema.String,
})

/** Local and repository-comparison scope shared by viewed-file reads and writes. */
export type LocalViewedFileScope = typeof LocalViewedFileScope.Type

/** Viewed-file mutation for one exact hosted patch identity. */
interface SetHostedViewedFileInput extends HostedViewedFileScope, ViewedFileRecord {
  readonly viewed: boolean
}

/** Viewed-file mutation for one exact local patch identity. */
interface SetLocalViewedFileInput extends ViewedFileRecord {
  readonly viewed: boolean
}

/** Domain-oriented persistence service for viewed file state. */
export class ViewedFileStore extends Context.Service<
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
    readonly setLocal: (
      scope: LocalViewedFileScope,
      input: SetLocalViewedFileInput,
    ) => Effect.Effect<void, ViewedFileStoreError>
  }
>()("@diffdash/ViewedFileStore") {
  static readonly layer = Layer.effect(
    ViewedFileStore,
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      const database = makeDatabase(client)

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
          const parameters: SqlParams = input.viewed
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
        setLocal: Effect.fn("ViewedFileStore.setLocal")(function (scope, input) {
          const statement = input.viewed
            ? `INSERT OR REPLACE INTO local_viewed_files (
                 repo_id, source_identity, comparison_kind, comparison_target,
                 review_key, patch_hash, viewed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            : `DELETE FROM local_viewed_files
               WHERE repo_id = ? AND source_identity = ?
                 AND comparison_kind = ? AND comparison_target = ?
                 AND review_key = ? AND patch_hash = ?`
          const identity: SqlParams = [
            scope.repoId,
            scope.sourceIdentity,
            scope.comparisonKind,
            scope.comparisonTarget,
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

const decodeViewedFileRows = (operation: ViewedFileStoreOperation, input: readonly DatabaseRow[]) =>
  Schema.decodeUnknownEffect(ViewedFileRows)(input).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        patchHash: row.patch_hash,
        reviewKey: row.review_key,
      })),
    ),
    Effect.mapError((cause) => ViewedFileStoreError.make({ operation, cause })),
  )
