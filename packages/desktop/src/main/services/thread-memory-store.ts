import { Context, Effect, Layer, Schema } from "effect"

import {
  ThreadMemory,
  ThreadMemorySummaryAlgorithm,
  type UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import { ReviewAgentArtifactId } from "@diffdash/domain/review-agent"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { DatabaseService } from "./database"

const ImportantArtifactIdsJson = Schema.parseJson(Schema.Array(ReviewAgentArtifactId))
const ThreadMemoryRow = Schema.Struct({
  thread_id: ReviewThreadId,
  summary: Schema.String,
  summarized_through_sequence: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  summary_algorithm: ThreadMemorySummaryAlgorithm,
  summary_version: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  important_artifact_ids_json: Schema.String,
  updated_at: Schema.String,
})

/** A typed failure from compact review-thread memory persistence operations. */
export class ThreadMemoryStoreError extends Schema.TaggedError<ThreadMemoryStoreError>()(
  "ThreadMemoryStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Persistence for compact thread summaries and selected normalized artifacts. */
export class ThreadMemoryStore extends Context.Tag("@diffdash/ThreadMemoryStore")<
  ThreadMemoryStore,
  {
    readonly get: (
      threadId: ReviewThreadId,
    ) => Effect.Effect<ThreadMemory | null, ThreadMemoryStoreError>
    readonly upsert: (
      input: UpsertThreadMemoryInput,
    ) => Effect.Effect<ThreadMemory, ThreadMemoryStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    ThreadMemoryStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const get = Effect.fn("ThreadMemoryStore.get")(function (threadId: ReviewThreadId) {
        return database.get("SELECT * FROM thread_memory WHERE thread_id = ?", [threadId]).pipe(
          Effect.mapError((cause) =>
            ThreadMemoryStoreError.make({ operation: "get.query", cause }),
          ),
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.succeed(null)
              : Effect.try({
                  try: () => decodeThreadMemoryRow(row),
                  catch: (cause) => ThreadMemoryStoreError.make({ operation: "get.decode", cause }),
                }),
          ),
        )
      })

      return ThreadMemoryStore.of({
        get,
        upsert: Effect.fn("ThreadMemoryStore.upsert")(function (input) {
          return Schema.encode(ImportantArtifactIdsJson)(input.importantArtifactIds).pipe(
            Effect.mapError((cause) =>
              ThreadMemoryStoreError.make({ operation: "upsert.encodeArtifactIds", cause }),
            ),
            Effect.flatMap((importantArtifactIdsJson) =>
              database.transaction("threadMemory.upsert", (transaction) => {
                transaction.run(
                  `INSERT INTO thread_memory (
                    thread_id, summary, summarized_through_sequence, summary_algorithm,
                    summary_version, important_artifact_ids_json, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(thread_id) DO UPDATE SET
                    summary = excluded.summary,
                    summarized_through_sequence = excluded.summarized_through_sequence,
                    summary_algorithm = excluded.summary_algorithm,
                    summary_version = excluded.summary_version,
                    important_artifact_ids_json = excluded.important_artifact_ids_json,
                    updated_at = excluded.updated_at
                  WHERE excluded.summarized_through_sequence >
                    thread_memory.summarized_through_sequence`,
                  [
                    input.threadId,
                    input.summary,
                    input.summarizedThroughSequence,
                    input.summaryAlgorithm,
                    input.summaryVersion,
                    importantArtifactIdsJson,
                    new Date().toISOString(),
                  ],
                )
                const row = transaction.get("SELECT * FROM thread_memory WHERE thread_id = ?", [
                  input.threadId,
                ])
                if (row === undefined) throw new Error("Thread memory was not found after upsert")
                return decodeThreadMemoryRow(row)
              }),
            ),
            Effect.mapError((cause) =>
              cause instanceof ThreadMemoryStoreError
                ? cause
                : ThreadMemoryStoreError.make({ operation: "upsert", cause }),
            ),
          )
        }),
      })
    }),
  )
}

const decodeThreadMemoryRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(ThreadMemoryRow)(input)
  return ThreadMemory.make({
    threadId: row.thread_id,
    summary: row.summary,
    summarizedThroughSequence: row.summarized_through_sequence,
    summaryAlgorithm: row.summary_algorithm,
    summaryVersion: row.summary_version,
    importantArtifactIds: Schema.decodeUnknownSync(ImportantArtifactIdsJson)(
      row.important_artifact_ids_json,
    ),
    updatedAt: row.updated_at,
  })
}
