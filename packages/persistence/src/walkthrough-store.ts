import { Context, Effect, Layer, Schema } from "effect"

import {
  StoredWalkthrough,
  Walkthrough,
  type SaveWalkthroughInput,
  type WalkthroughCacheKey,
} from "@diffdash/domain/walkthrough"
import { DatabaseService } from "./database"

const WalkthroughRow = Schema.Struct({
  repo_id: Schema.String,
  pr_number: Schema.NullOr(Schema.Int),
  review_key: Schema.String,
  base_sha: Schema.String,
  head_sha: Schema.String,
  prompt_version: Schema.String,
  content_json: Schema.String,
  created_at: Schema.String,
})

const WalkthroughJson = Schema.parseJson(Walkthrough)

/** A typed failure from walkthrough persistence operations. */
export class WalkthroughStoreError extends Schema.TaggedError<WalkthroughStoreError>()(
  "WalkthroughStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Domain-oriented persistence service for generated walkthrough artifacts. */
export class WalkthroughStore extends Context.Tag("@diffdash/WalkthroughStore")<
  WalkthroughStore,
  {
    readonly get: (
      key: WalkthroughCacheKey,
    ) => Effect.Effect<StoredWalkthrough | null, WalkthroughStoreError>
    readonly save: (
      input: SaveWalkthroughInput,
    ) => Effect.Effect<StoredWalkthrough, WalkthroughStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    WalkthroughStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

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
              row === undefined
                ? Effect.succeed(null)
                : decodeWalkthroughRow("get.decodeRow", row).pipe(
                    Effect.flatMap((decoded) => toStored("get.decodeContent", decoded)),
                  ),
            ),
          )
      })

      return WalkthroughStore.of({
        get,
        save: Effect.fn("WalkthroughStore.save")(function (input) {
          const createdAt = new Date().toISOString()
          return Schema.encode(WalkthroughJson)(input.walkthrough).pipe(
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
              stored === null
                ? WalkthroughStoreError.make({
                    operation: "save.get",
                    cause: new Error("Walkthrough cache row was not found after save."),
                  })
                : Effect.succeed(stored),
            ),
          )
        }),
      })
    }),
  )
}

const decodeWalkthroughRow = (operation: string, input: unknown) =>
  Schema.decodeUnknown(WalkthroughRow)(input).pipe(
    Effect.mapError((cause) => WalkthroughStoreError.make({ operation, cause })),
  )

const toStored = (
  operation: string,
  row: typeof WalkthroughRow.Type,
): Effect.Effect<StoredWalkthrough, WalkthroughStoreError> =>
  Schema.decodeUnknown(WalkthroughJson)(row.content_json).pipe(
    Effect.mapError((cause) => WalkthroughStoreError.make({ operation, cause })),
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
  )
