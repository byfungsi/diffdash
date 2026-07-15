import { Context, Effect, Layer, Schema } from "effect"

import {
  StoredWalkthrough,
  Walkthrough,
  type SaveWalkthroughInput,
  type WalkthroughCacheKey,
} from "@diffdash/domain/walkthrough"
import { DatabaseService } from "./database"

interface WalkthroughRow {
  readonly repo_id: string
  readonly pr_number: number | null
  readonly review_key: string
  readonly base_sha: string
  readonly head_sha: string
  readonly prompt_version: string
  readonly content_json: string
  readonly created_at: string
}

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
          .get<WalkthroughRow>(
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
            Effect.mapError((cause) => WalkthroughStoreError.make({ operation: "get", cause })),
            Effect.flatMap((row) => (row === undefined ? Effect.succeed(null) : toStored(row))),
          )
      })

      return WalkthroughStore.of({
        get,
        save: Effect.fn("WalkthroughStore.save")(function (input) {
          const createdAt = new Date().toISOString()
          const contentJson = JSON.stringify(input.walkthrough)

          return database
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
              Effect.mapError((cause) => WalkthroughStoreError.make({ operation: "save", cause })),
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

const toStored = (row: WalkthroughRow): Effect.Effect<StoredWalkthrough, WalkthroughStoreError> =>
  decodeContentJson(row.content_json).pipe(
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

const decodeContentJson = (
  contentJson: string,
): Effect.Effect<Walkthrough, WalkthroughStoreError> =>
  Effect.try({
    try: () => JSON.parse(contentJson) as unknown,
    catch: (cause) => WalkthroughStoreError.make({ operation: "decodeContentJson.parse", cause }),
  }).pipe(
    Effect.flatMap((content) =>
      Schema.decodeUnknown(Walkthrough)(content).pipe(
        Effect.mapError((cause) =>
          WalkthroughStoreError.make({ operation: "decodeContentJson.schema", cause }),
        ),
      ),
    ),
  )
