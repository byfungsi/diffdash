import { Context, Effect, Layer, Schema } from "effect"

import { AgentRun, AgentPromptVersion, AgentRunStatus } from "@diffdash/domain/agent-run"
import {
  AgentRunId,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import { DatabaseService } from "./database"

const ReviewAgentUsageJson = Schema.NullOr(Schema.parseJson(ReviewAgentUsage))

const AgentRunRow = Schema.Struct({
  id: AgentRunId,
  thread_id: ReviewThreadId,
  review_key: ReviewKey,
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  provider: ReviewAgentProviderId,
  model: Schema.String.pipe(Schema.minLength(1)),
  prompt_version: AgentPromptVersion,
  status: AgentRunStatus,
  provider_run_id: Schema.NullOr(ReviewAgentProviderRunId),
  usage_json: ReviewAgentUsageJson,
  error: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
})

/** A typed failure from persisted review-agent run lifecycle operations. */
export class AgentRunStoreError extends Schema.TaggedError<AgentRunStoreError>()(
  "AgentRunStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Domain-oriented persistence for review-agent run lifecycle records. */
export class AgentRunStore extends Context.Tag("@diffdash/AgentRunStore")<
  AgentRunStore,
  {
    readonly get: (runId: AgentRunId) => Effect.Effect<AgentRun, AgentRunStoreError>
    readonly listForThread: (
      threadId: ReviewThreadId,
    ) => Effect.Effect<readonly AgentRun[], AgentRunStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    AgentRunStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const get = Effect.fn("AgentRunStore.get")(function (runId: AgentRunId) {
        return database.get("SELECT * FROM agent_runs WHERE id = ?", [runId]).pipe(
          Effect.mapError((cause) => AgentRunStoreError.make({ operation: "get.query", cause })),
          Effect.flatMap((row) =>
            Effect.try({
              try: () => requireAgentRun(row, runId),
              catch: (cause) => AgentRunStoreError.make({ operation: "get.decode", cause }),
            }),
          ),
        )
      })

      return AgentRunStore.of({
        get,
        listForThread: Effect.fn("AgentRunStore.listForThread")(function (threadId) {
          return database
            .all(
              `SELECT * FROM agent_runs
               WHERE thread_id = ?
               ORDER BY started_at DESC, id ASC`,
              [threadId],
            )
            .pipe(
              Effect.mapError((cause) =>
                AgentRunStoreError.make({ operation: "listForThread.query", cause }),
              ),
              Effect.flatMap((rows) =>
                Effect.try({
                  try: () => rows.map(decodeAgentRunRow),
                  catch: (cause) =>
                    AgentRunStoreError.make({ operation: "listForThread.decode", cause }),
                }),
              ),
            )
        }),
      })
    }),
  )
}

const requireAgentRun = (row: unknown, runId: AgentRunId) => {
  if (row === undefined) throw new Error(`Agent run not found: ${runId}`)
  return decodeAgentRunRow(row)
}

const decodeAgentRunRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(AgentRunRow)(input)
  return AgentRun.make({
    id: row.id,
    threadId: row.thread_id,
    reviewKey: row.review_key,
    baseRevision: row.base_sha,
    headRevision: row.head_sha,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status,
    providerRunId: row.provider_run_id,
    usage: row.usage_json,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  })
}
