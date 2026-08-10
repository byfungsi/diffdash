import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import {
  StoredWalkthrough,
  Walkthrough,
  type SaveWalkthroughInput,
  type WalkthroughCacheKey,
} from "@diffdash/domain/walkthrough"
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { WalkthroughOperationPromptVersion } from "@diffdash/domain/walkthrough-operation"
import { type DatabaseRow, makeDatabase } from "./database"

const WalkthroughRow = Schema.Struct({
  repo_id: ReviewProjectId,
  pr_number: Schema.NullOr(Schema.Int),
  review_key: ReviewKey,
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  prompt_version: WalkthroughOperationPromptVersion,
  content_json: Schema.String,
  created_at: Schema.String,
})

const WalkthroughJson = Schema.fromJsonString(Walkthrough)

const WalkthroughStoreOperation = Schema.Literals([
  "get.query",
  "get.decodeRow",
  "get.decodeContent",
  "save.encodeContent",
  "save.query",
  "save.get",
])
type WalkthroughStoreOperation = typeof WalkthroughStoreOperation.Type

/** A typed failure from walkthrough persistence operations. */
export class WalkthroughStoreError extends Schema.TaggedError<WalkthroughStoreError>()(
  "WalkthroughStoreError",
  {
    operation: WalkthroughStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Domain-oriented persistence service for generated walkthrough artifacts. */
export class WalkthroughStore extends Context.Service<
  WalkthroughStore,
  {
    readonly get: (
      key: WalkthroughCacheKey,
    ) => Effect.Effect<Option.Option<StoredWalkthrough>, WalkthroughStoreError>
    readonly save: (
      input: SaveWalkthroughInput,
    ) => Effect.Effect<StoredWalkthrough, WalkthroughStoreError>
  }
>()("@diffdash/WalkthroughStore") {
  static readonly layer = Layer.effect(
    WalkthroughStore,
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      const database = makeDatabase(client)

      const get = Effect.fn("WalkthroughStore.get")(function (key: WalkthroughCacheKey) {
        return database
          .get(
            `SELECT * FROM walkthroughs
             WHERE repo_id = ?
               AND review_key = ?
               AND head_sha = ?
               AND prompt_version = ?
               AND (base_sha = ? OR base_sha = head_sha)
             ORDER BY CASE WHEN base_sha = ? THEN 0 ELSE 1 END
             LIMIT 1`,
            [key.repoId, key.reviewKey, key.headSha, key.promptVersion, key.baseSha, key.baseSha],
          )
          .pipe(
            Effect.mapError((cause) =>
              WalkthroughStoreError.make({ operation: "get.query", cause }),
            ),
            Effect.flatMap((row) =>
              Option.map(row, (value) => decodeWalkthrough(value)).pipe(Effect.transposeOption),
            ),
          )
      })

      return WalkthroughStore.of({
        get,
        save: Effect.fn("WalkthroughStore.save")(function (input) {
          const createdAt = new Date().toISOString()
          return Schema.encodeEffect(WalkthroughJson)(input.walkthrough).pipe(
            Effect.mapError((cause) =>
              WalkthroughStoreError.make({ operation: "save.encodeContent", cause }),
            ),
            Effect.flatMap((contentJson) =>
              database
                .run(
                  `INSERT INTO walkthroughs (
                  repo_id, pr_number, review_key, base_sha, head_sha, prompt_version, content_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo_id, review_key, base_sha, head_sha, prompt_version) DO UPDATE SET
                  pr_number = excluded.pr_number,
                  content_json = excluded.content_json,
                  created_at = excluded.created_at`,
                  [
                    input.repoId,
                    input.prNumber,
                    input.reviewKey,
                    input.baseSha,
                    input.headSha,
                    input.promptVersion,
                    contentJson,
                    createdAt,
                  ],
                )
                .pipe(
                  Effect.mapError((cause) =>
                    WalkthroughStoreError.make({ operation: "save.query", cause }),
                  ),
                ),
            ),
            Effect.flatMap(() => get(input)),
            Effect.flatMap((stored) =>
              Effect.fromOption(stored, () =>
                WalkthroughStoreError.make({
                  operation: "save.get",
                  cause: new Error("Walkthrough cache row was not found after save."),
                }),
              ),
            ),
          )
        }),
      })
    }),
  )
}

const decodeWalkthrough = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(WalkthroughRow)(input).pipe(
    Effect.mapError((cause) => WalkthroughStoreError.make({ operation: "get.decodeRow", cause })),
    Effect.flatMap((row) =>
      Schema.decodeUnknownEffect(WalkthroughJson)(row.content_json).pipe(
        Effect.mapError((cause) =>
          WalkthroughStoreError.make({ operation: "get.decodeContent", cause }),
        ),
        Effect.map((walkthrough) =>
          StoredWalkthrough.make({
            repoId: row.repo_id,
            prNumber: row.pr_number,
            reviewKey: row.review_key,
            baseSha: row.base_sha,
            headSha: row.head_sha,
            promptVersion: row.prompt_version,
            walkthrough,
            createdAt: row.created_at,
          }),
        ),
      ),
    ),
  )
