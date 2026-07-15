import { Context, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"

import { type SaveAgentRunArtifactInput, StoredAgentRunArtifact } from "@diffdash/domain/agent-run"
import {
  AgentRunId,
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentArtifactType,
  ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { DatabaseService, type DatabaseTransaction } from "./database"

const ArtifactMetadata = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const ArtifactMetadataJson = Schema.parseJson(ArtifactMetadata)

const AgentRunArtifactRow = Schema.Struct({
  id: ReviewAgentArtifactId,
  run_id: AgentRunId,
  thread_id: ReviewThreadId,
  type: ReviewAgentArtifactType,
  provider: ReviewAgentProviderId,
  title: Schema.String,
  content: Schema.String,
  content_digest: Schema.String,
  metadata_json: Schema.String,
  truncated: Schema.Literal(0, 1),
  original_size: Schema.Number,
  created_at: Schema.String,
})

interface AgentRunOwnerRow {
  readonly provider: unknown
  readonly thread_id: unknown
}

/** A typed failure from normalized agent artifact persistence operations. */
export class AgentRunArtifactStoreError extends Schema.TaggedError<AgentRunArtifactStoreError>()(
  "AgentRunArtifactStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Persistence and thread/run queries for normalized provider artifacts. */
export class AgentRunArtifactStore extends Context.Tag("@diffdash/AgentRunArtifactStore")<
  AgentRunArtifactStore,
  {
    readonly save: (
      input: SaveAgentRunArtifactInput,
    ) => Effect.Effect<StoredAgentRunArtifact, AgentRunArtifactStoreError>
    readonly get: (
      artifactId: ReviewAgentArtifactId,
    ) => Effect.Effect<StoredAgentRunArtifact, AgentRunArtifactStoreError>
    readonly listForRun: (
      runId: AgentRunId,
    ) => Effect.Effect<readonly StoredAgentRunArtifact[], AgentRunArtifactStoreError>
    readonly listForThread: (
      threadId: ReviewThreadId,
    ) => Effect.Effect<readonly StoredAgentRunArtifact[], AgentRunArtifactStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    AgentRunArtifactStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const get = Effect.fn("AgentRunArtifactStore.get")(function (
        artifactId: ReviewAgentArtifactId,
      ) {
        return database.get(artifactSelect("WHERE artifact.id = ?"), [artifactId]).pipe(
          Effect.mapError((cause) =>
            AgentRunArtifactStoreError.make({ operation: "get.query", cause }),
          ),
          Effect.flatMap((row) =>
            Effect.try({
              try: () => decodeArtifactRow(requireArtifactRow(row, artifactId)),
              catch: (cause) => AgentRunArtifactStoreError.make({ operation: "get.decode", cause }),
            }),
          ),
        )
      })

      const list = (operation: string, where: string, id: AgentRunId | ReviewThreadId) =>
        database.all(artifactSelect(where), [id]).pipe(
          Effect.mapError((cause) =>
            AgentRunArtifactStoreError.make({ operation: `${operation}.query`, cause }),
          ),
          Effect.flatMap((rows) => decodeArtifactRows(`${operation}.decode`, rows)),
        )

      return AgentRunArtifactStore.of({
        save: Effect.fn("AgentRunArtifactStore.save")(function (input) {
          return Schema.encode(ArtifactMetadataJson)(input.artifact.metadata).pipe(
            Effect.mapError((cause) =>
              AgentRunArtifactStoreError.make({ operation: "save.encodeMetadata", cause }),
            ),
            Effect.flatMap((metadataJson) =>
              database.transaction("agentRunArtifacts.save", (transaction) => {
                assertArtifactOwner(transaction, input)
                const id = ReviewAgentArtifactId.make(randomUUID())
                const createdAt = new Date().toISOString()
                transaction.run(
                  `INSERT INTO agent_run_artifacts (
                    id, run_id, thread_id, type, title, content, content_digest,
                    metadata_json, truncated, original_size, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    id,
                    input.runId,
                    input.threadId,
                    input.artifact.type,
                    input.artifact.title,
                    input.artifact.content,
                    input.artifact.contentDigest,
                    metadataJson,
                    input.artifact.truncated ? 1 : 0,
                    input.artifact.originalSize,
                    createdAt,
                  ],
                )
                return requireArtifactRow(
                  transaction.get(artifactSelect("WHERE artifact.id = ?"), [id]),
                  id,
                )
              }),
            ),
            Effect.flatMap((row) => decodeArtifactEffect("save.decode", row)),
            Effect.mapError((cause) =>
              cause instanceof AgentRunArtifactStoreError
                ? cause
                : AgentRunArtifactStoreError.make({ operation: "save", cause }),
            ),
          )
        }),
        get,
        listForRun: Effect.fn("AgentRunArtifactStore.listForRun")(function (runId) {
          return list("listForRun", "WHERE artifact.run_id = ?", runId)
        }),
        listForThread: Effect.fn("AgentRunArtifactStore.listForThread")(function (threadId) {
          return list("listForThread", "WHERE artifact.thread_id = ?", threadId)
        }),
      })
    }),
  )
}

const artifactSelect = (where: string) => `
  SELECT artifact.*, run.provider AS provider
  FROM agent_run_artifacts AS artifact
  INNER JOIN agent_runs AS run ON run.id = artifact.run_id AND run.thread_id = artifact.thread_id
  ${where}
  ORDER BY artifact.created_at ASC, artifact.id ASC`

const assertArtifactOwner = (
  transaction: DatabaseTransaction,
  input: SaveAgentRunArtifactInput,
) => {
  const row = transaction.get<AgentRunOwnerRow>(
    "SELECT provider, thread_id FROM agent_runs WHERE id = ?",
    [input.runId],
  )
  if (row === undefined) throw new Error(`Agent run not found: ${input.runId}`)
  const owner = Schema.decodeUnknownSync(
    Schema.Struct({ provider: ReviewAgentProviderId, thread_id: ReviewThreadId }),
  )(row)
  if (owner.thread_id !== input.threadId) throw new Error("Artifact thread does not own agent run")
  if (owner.provider !== input.artifact.provider) {
    throw new Error("Artifact provider does not match agent run provider")
  }
}

const requireArtifactRow = (row: unknown, artifactId: ReviewAgentArtifactId) => {
  if (row === undefined) throw new Error(`Agent run artifact not found: ${artifactId}`)
  return row
}

const decodeArtifactEffect = (operation: string, input: unknown) =>
  Effect.try({
    try: () => decodeArtifactRow(input),
    catch: (cause) => AgentRunArtifactStoreError.make({ operation, cause }),
  })

const decodeArtifactRows = (operation: string, rows: readonly unknown[]) =>
  Effect.try({
    try: () => rows.map(decodeArtifactRow),
    catch: (cause) => AgentRunArtifactStoreError.make({ operation, cause }),
  })

const decodeArtifactRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(AgentRunArtifactRow)(input)
  const metadata = Schema.decodeUnknownSync(ArtifactMetadataJson)(row.metadata_json)
  return StoredAgentRunArtifact.make({
    id: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    artifact: ReviewAgentArtifact.make({
      type: row.type,
      provider: row.provider,
      title: row.title,
      content: row.content,
      contentDigest: row.content_digest,
      metadata,
      truncated: row.truncated === 1,
      originalSize: row.original_size,
    }),
    createdAt: row.created_at,
  })
}
