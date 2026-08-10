import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"

import { type SaveAgentRunArtifactInput, StoredAgentRunArtifact } from "@diffdash/domain/agent-run"
import {
  AgentRunId,
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentArtifactMetadata,
  ReviewAgentArtifactType,
  ReviewAgentProviderId,
} from "@diffdash/domain/review-agent"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { type Database, type DatabaseRow, makeDatabase, toError } from "./database"

const ArtifactMetadataJson = Schema.fromJsonString(ReviewAgentArtifactMetadata)

const AgentRunArtifactRow = Schema.Struct({
  id: ReviewAgentArtifactId,
  run_id: AgentRunId,
  thread_id: ReviewThreadId,
  type: ReviewAgentArtifactType,
  provider: ReviewAgentProviderId,
  title: Schema.String,
  content: Schema.String,
  content_digest: Schema.String,
  metadata_json: ArtifactMetadataJson,
  truncated: Schema.Literals([0, 1]),
  original_size: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  created_at: Schema.String,
})
const AgentRunArtifactRows = Schema.Array(AgentRunArtifactRow)

const AgentRunOwnerRow = Schema.Struct({
  provider: ReviewAgentProviderId,
  thread_id: ReviewThreadId,
})

const AgentRunArtifactStoreOperation = Schema.Literals([
  "get.query",
  "get.decode",
  "get",
  "save.encodeMetadata",
  "save",
  "save.decode",
  "listForRun.query",
  "listForRun.decode",
  "listForThread.query",
  "listForThread.decode",
])
type AgentRunArtifactStoreOperation = typeof AgentRunArtifactStoreOperation.Type
type AgentRunArtifactListOperation = "listForRun" | "listForThread"

/** A typed failure from normalized agent artifact persistence operations. */
export class AgentRunArtifactStoreError extends Schema.TaggedError<AgentRunArtifactStoreError>()(
  "AgentRunArtifactStoreError",
  {
    operation: AgentRunArtifactStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Persistence and thread/run queries for normalized provider artifacts. */
export class AgentRunArtifactStore extends Context.Service<
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
>()("@diffdash/AgentRunArtifactStore") {
  static readonly layer = Layer.effect(
    AgentRunArtifactStore,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)

      const get = Effect.fn("AgentRunArtifactStore.get")(function (
        artifactId: ReviewAgentArtifactId,
      ) {
        return database.get(artifactSelect("WHERE artifact.id = ?"), [artifactId]).pipe(
          Effect.mapError((cause) =>
            AgentRunArtifactStoreError.make({ operation: "get.query", cause }),
          ),
          Effect.flatMap((row) => requireArtifactRow("get.decode", row, artifactId)),
          Effect.flatMap((row) => decodeArtifact("get.decode", row)),
        )
      })

      const list = (
        operation: AgentRunArtifactListOperation,
        where: string,
        id: AgentRunId | ReviewThreadId,
      ) =>
        database.all(artifactSelect(where), [id]).pipe(
          Effect.mapError((cause) =>
            AgentRunArtifactStoreError.make({ operation: `${operation}.query`, cause }),
          ),
          Effect.flatMap((rows) => decodeArtifacts(`${operation}.decode`, rows)),
        )

      return AgentRunArtifactStore.of({
        save: Effect.fn("AgentRunArtifactStore.save")(function (input) {
          return Schema.encodeEffect(ArtifactMetadataJson)(input.artifact.metadata).pipe(
            Effect.mapError((cause) =>
              AgentRunArtifactStoreError.make({ operation: "save.encodeMetadata", cause }),
            ),
            Effect.flatMap((metadataJson) =>
              database.transaction(
                Effect.gen(function* () {
                  yield* assertArtifactOwner(database, input)
                  const id = ReviewAgentArtifactId.make(randomUUID())
                  const createdAt = new Date().toISOString()
                  yield* database.run(
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
                  const row = yield* database.get(artifactSelect("WHERE artifact.id = ?"), [id])
                  return yield* requireArtifactRow("save", row, id)
                }),
              ),
            ),
            Effect.flatMap((row) => decodeArtifact("save.decode", row)),
            Effect.mapError((cause) =>
              Schema.is(AgentRunArtifactStoreError)(cause)
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

const assertArtifactOwner = Effect.fn("AgentRunArtifactStore.assertArtifactOwner")(function* (
  database: Database,
  input: SaveAgentRunArtifactInput,
) {
  const row = yield* database.get("SELECT provider, thread_id FROM agent_runs WHERE id = ?", [
    input.runId,
  ])
  const owner = yield* Effect.fromOption(row, () =>
    AgentRunArtifactStoreError.make({
      operation: "save",
      cause: new Error(`Agent run not found: ${input.runId}`),
    }),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AgentRunOwnerRow)),
    Effect.mapError((cause) =>
      Schema.is(AgentRunArtifactStoreError)(cause)
        ? cause
        : AgentRunArtifactStoreError.make({ operation: "save", cause }),
    ),
  )
  if (owner.thread_id !== input.threadId) {
    return yield* AgentRunArtifactStoreError.make({
      operation: "save",
      cause: new Error("Artifact thread does not own agent run"),
    })
  }
  if (owner.provider !== input.artifact.provider) {
    return yield* AgentRunArtifactStoreError.make({
      operation: "save",
      cause: new Error("Artifact provider does not match agent run provider"),
    })
  }
})

const requireArtifactRow = (
  operation: AgentRunArtifactStoreOperation,
  row: Option.Option<DatabaseRow>,
  artifactId: ReviewAgentArtifactId,
) =>
  Effect.fromOption(row, () =>
    AgentRunArtifactStoreError.make({
      operation,
      cause: new Error(`Agent run artifact not found: ${artifactId}`),
    }),
  )

const decodeArtifact = (operation: AgentRunArtifactStoreOperation, input: DatabaseRow) =>
  Schema.decodeUnknownEffect(AgentRunArtifactRow)(input).pipe(
    Effect.flatMap(makeStoredArtifact),
    Effect.mapError((cause) =>
      AgentRunArtifactStoreError.make({ operation, cause: toError(cause) }),
    ),
  )

const decodeArtifacts = (operation: AgentRunArtifactStoreOperation, rows: readonly DatabaseRow[]) =>
  Schema.decodeUnknownEffect(AgentRunArtifactRows)(rows).pipe(
    Effect.flatMap((decoded) => Effect.forEach(decoded, makeStoredArtifact)),
    Effect.mapError((cause) =>
      AgentRunArtifactStoreError.make({ operation, cause: toError(cause) }),
    ),
  )

const makeStoredArtifact = Effect.fn("AgentRunArtifactStore.makeStoredArtifact")(function* (
  row: typeof AgentRunArtifactRow.Type,
) {
  const artifact = yield* ReviewAgentArtifact.makeEffect({
    type: row.type,
    provider: row.provider,
    title: row.title,
    content: row.content,
    contentDigest: row.content_digest,
    metadata: row.metadata_json,
    truncated: row.truncated === 1,
    originalSize: row.original_size,
  })
  return yield* StoredAgentRunArtifact.makeEffect({
    id: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    artifact,
    createdAt: row.created_at,
  })
})
