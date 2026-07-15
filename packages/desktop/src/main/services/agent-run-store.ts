import { Context, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"

import {
  AgentRun,
  AgentPromptVersion,
  AgentRunStatus,
  type CompleteAgentRunInput,
  type FailAgentRunInput,
  type SetAgentProviderRunIdInput,
  type StartAgentRunInput,
} from "@diffdash/domain/agent-run"
import {
  AgentRunId,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { DatabaseService, type DatabaseTransaction } from "./database"

const ReviewAgentUsageJson = Schema.NullOr(Schema.parseJson(ReviewAgentUsage))

const AgentRunRow = Schema.Struct({
  id: AgentRunId,
  thread_id: ReviewThreadId,
  provider: ReviewAgentProviderId,
  model: Schema.String.pipe(Schema.minLength(1)),
  prompt_version: AgentPromptVersion,
  status: AgentRunStatus,
  provider_run_id: Schema.NullOr(ReviewAgentProviderRunId),
  usage_json: Schema.NullOr(Schema.String),
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
    readonly start: (input: StartAgentRunInput) => Effect.Effect<AgentRun, AgentRunStoreError>
    readonly get: (runId: AgentRunId) => Effect.Effect<AgentRun, AgentRunStoreError>
    readonly listForThread: (
      threadId: ReviewThreadId,
    ) => Effect.Effect<readonly AgentRun[], AgentRunStoreError>
    readonly setProviderRunId: (
      input: SetAgentProviderRunIdInput,
    ) => Effect.Effect<AgentRun, AgentRunStoreError>
    readonly complete: (input: CompleteAgentRunInput) => Effect.Effect<AgentRun, AgentRunStoreError>
    readonly fail: (input: FailAgentRunInput) => Effect.Effect<AgentRun, AgentRunStoreError>
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

      const transition = (
        operation: "complete" | "fail",
        runId: AgentRunId,
        providerRunId: ReviewAgentProviderRunId | undefined,
        usageJson: string | null,
        error: string | null,
      ) =>
        database
          .transaction(`agentRuns.${operation}`, (transaction) => {
            const current = getAgentRun(transaction, runId)
            if (current.status !== "running") {
              throw new Error(`Agent run ${runId} is already ${current.status}`)
            }
            const completedAt = new Date().toISOString()
            transaction.run(
              `UPDATE agent_runs
               SET status = ?, provider_run_id = ?, usage_json = ?, error = ?, completed_at = ?
               WHERE id = ?`,
              [
                operation === "complete" ? "completed" : "failed",
                providerRunId ?? current.providerRunId,
                usageJson,
                error,
                completedAt,
                runId,
              ],
            )
            return getAgentRun(transaction, runId)
          })
          .pipe(mapStoreError(operation))

      return AgentRunStore.of({
        start: Effect.fn("AgentRunStore.start")(function (input) {
          return database
            .transaction("agentRuns.start", (transaction) => {
              const id = AgentRunId.make(randomUUID())
              const startedAt = new Date().toISOString()
              transaction.run(
                `INSERT INTO agent_runs (
                  id, thread_id, provider, model, prompt_version, status,
                  provider_run_id, usage_json, error, started_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, NULL)`,
                [id, input.threadId, input.provider, input.model, input.promptVersion, startedAt],
              )
              return getAgentRun(transaction, id)
            })
            .pipe(mapStoreError("start"))
        }),
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
        setProviderRunId: Effect.fn("AgentRunStore.setProviderRunId")(function (input) {
          return database
            .transaction("agentRuns.setProviderRunId", (transaction) => {
              const current = getAgentRun(transaction, input.runId)
              if (current.status !== "running") {
                throw new Error(`Cannot update provider ID for ${current.status} agent run`)
              }
              transaction.run("UPDATE agent_runs SET provider_run_id = ? WHERE id = ?", [
                input.providerRunId,
                input.runId,
              ])
              return getAgentRun(transaction, input.runId)
            })
            .pipe(mapStoreError("setProviderRunId"))
        }),
        complete: Effect.fn("AgentRunStore.complete")(function (input) {
          return Schema.encode(ReviewAgentUsageJson)(input.usage).pipe(
            Effect.mapError((cause) =>
              AgentRunStoreError.make({ operation: "complete.encodeUsage", cause }),
            ),
            Effect.flatMap((usageJson) =>
              transition("complete", input.runId, input.providerRunId, usageJson, null),
            ),
          )
        }),
        fail: Effect.fn("AgentRunStore.fail")(function (input) {
          return transition("fail", input.runId, input.providerRunId, null, input.error)
        }),
      })
    }),
  )
}

const getAgentRun = (transaction: DatabaseTransaction, runId: AgentRunId) =>
  requireAgentRun(transaction.get("SELECT * FROM agent_runs WHERE id = ?", [runId]), runId)

const requireAgentRun = (row: unknown, runId: AgentRunId) => {
  if (row === undefined) throw new Error(`Agent run not found: ${runId}`)
  return decodeAgentRunRow(row)
}

const decodeAgentRunRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(AgentRunRow)(input)
  return AgentRun.make({
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status,
    providerRunId: row.provider_run_id,
    usage: Schema.decodeUnknownSync(ReviewAgentUsageJson)(row.usage_json),
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  })
}

const mapStoreError = (operation: string) =>
  Effect.mapError((cause: unknown) => AgentRunStoreError.make({ operation, cause }))
