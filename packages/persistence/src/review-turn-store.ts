import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import {
  AgentPromptVersion,
  AgentRun,
  AgentRunStatus,
  type ThreadMemory,
  ThreadMemory as ThreadMemoryModel,
  ThreadMemorySummaryAlgorithm,
  type UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import { makeHostedRepositoryKey, makeHostedReviewKey } from "@diffdash/domain/git-provider"
import {
  AgentRunId,
  type ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  type ReviewAgentUsage,
  ReviewAgentUsage as ReviewAgentUsageSchema,
} from "@diffdash/domain/review-agent"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  MarkdownBody,
  ReviewAnchorStatus,
  ReviewThread,
  ReviewThreadAnchor,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageAuthor,
  ReviewThreadMessageId,
  ReviewThreadMessageStatus,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { Context, Effect, Layer, Schema } from "effect"
import { DatabaseService, type DatabaseTransaction } from "./database"

const ReviewThreadAnchorJson = Schema.parseJson(ReviewThreadAnchor)
const ReviewAgentUsageJson = Schema.NullOr(Schema.parseJson(ReviewAgentUsageSchema))
const ArtifactMetadataJson = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
)
const ImportantArtifactIdsJson = Schema.parseJson(Schema.Array(ReviewAgentArtifactId))

const ReviewThreadRow = Schema.Struct({
  id: ReviewThreadId,
  repo_id: Schema.NonEmptyString,
  review_key: ReviewKey,
  pr_number: Schema.NullOr(Schema.Int),
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  current_base_sha: ReviewRevision,
  current_head_sha: ReviewRevision,
  original_anchor_json: ReviewThreadAnchorJson,
  current_anchor_json: Schema.NullOr(ReviewThreadAnchorJson),
  anchor_status: ReviewAnchorStatus,
  status: Schema.Literal("open", "closed"),
  closed_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

const ReviewThreadMessageRow = Schema.Struct({
  id: ReviewThreadMessageId,
  thread_id: ReviewThreadId,
  sequence: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  author: ReviewThreadMessageAuthor,
  body_markdown: MarkdownBody,
  status: ReviewThreadMessageStatus,
  agent_run_id: Schema.NullOr(AgentRunId),
  created_at: Schema.String,
  updated_at: Schema.String,
})

const AgentRunRow = Schema.Struct({
  id: AgentRunId,
  thread_id: ReviewThreadId,
  review_key: ReviewKey,
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  provider: ReviewAgentProviderId,
  model: Schema.NonEmptyString,
  prompt_version: AgentPromptVersion,
  status: AgentRunStatus,
  provider_run_id: Schema.NullOr(ReviewAgentProviderRunId),
  usage_json: ReviewAgentUsageJson,
  error: Schema.NullOr(Schema.NonEmptyString),
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
})

const ThreadMemoryRow = Schema.Struct({
  thread_id: ReviewThreadId,
  summary: Schema.String,
  summarized_through_sequence: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  summary_algorithm: ThreadMemorySummaryAlgorithm,
  summary_version: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  important_artifact_ids_json: ImportantArtifactIdsJson,
  updated_at: Schema.String,
})

const RepositoryTargetRow = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: Schema.NonEmptyString,
  owner: Schema.String,
  name: Schema.String,
  local_path: Schema.NullOr(Schema.String),
})

const NextSequenceRow = Schema.Struct({
  next_sequence: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
})

/** Identity supplied by the renderer and checked before expensive review-turn work. */
interface ReviewTurnTargetInput {
  readonly threadId: ReviewThreadId
  readonly target: ReviewThreadTarget
  readonly repoId: string
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
}

/** Exact active mapping observed by the advisory target check and rechecked by beginTurn. */
export class ReviewTurnMappingToken extends Schema.Class<ReviewTurnMappingToken>(
  "ReviewTurnMappingToken",
)({
  threadId: ReviewThreadId,
  repoId: Schema.NonEmptyString,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  currentAnchor: ReviewThreadAnchor,
}) {}

/** Input for atomically reserving one validated provider turn. */
interface BeginReviewTurnInput extends ReviewTurnTargetInput {
  readonly mapping: ReviewTurnMappingToken
  readonly provider: ReviewAgentProviderId
  readonly model: string
  readonly promptVersion: AgentPromptVersion
}

/** Validated persisted state reserved for one provider execution. */
export interface BegunReviewTurn {
  readonly run: AgentRun
  readonly pendingMessage: ReviewThreadMessage
  readonly details: ReviewThreadDetails
  readonly latestUserMessage: ReviewThreadMessage
  readonly memory: ThreadMemory | null
  readonly resumableProviderRunId: ReviewAgentProviderRunId | null
}

/** One normalized artifact with its identity allocated before finalization starts. */
interface PreparedReviewTurnArtifact {
  readonly id: ReviewAgentArtifactId
  readonly artifact: ReviewAgentArtifact
}

/** Input for atomically finalizing every durable result of a successful provider turn. */
interface CompleteReviewTurnInput {
  readonly threadId: ReviewThreadId
  readonly runId: AgentRunId
  readonly messageId: ReviewThreadMessageId
  readonly bodyMarkdown: MarkdownBody
  readonly artifacts: readonly PreparedReviewTurnArtifact[]
  readonly providerRunId: ReviewAgentProviderRunId | null
  readonly usage: ReviewAgentUsage | null
  readonly memoryUpdate: UpsertThreadMemoryInput | null
}

/** Input for atomically failing the exact linked run and pending agent message. */
interface FailReviewTurnInput {
  readonly threadId: ReviewThreadId
  readonly runId: AgentRunId
  readonly messageId: ReviewThreadMessageId
  readonly diagnostic: MarkdownBody
  readonly providerRunId?: ReviewAgentProviderRunId
}

/** Stable write boundary names exposed only for deterministic rollback fault injection. */
export type ReviewTurnWriteStep =
  | "begin.run"
  | "begin.message"
  | "begin.thread"
  | "complete.artifact"
  | "complete.message"
  | "complete.run"
  | "complete.memory"
  | "complete.thread"
  | "fail.message"
  | "fail.run"
  | "fail.thread"
  | "recover.message"
  | "recover.run"
  | "recover.thread"

/** Optional synchronous instrumentation for proving aggregate transaction rollback. */
interface ReviewTurnStoreOptions {
  readonly afterWrite?: (step: ReviewTurnWriteStep) => void
}

/** A stale or wrong review target rejected without mutating persisted turn state. */
export class ReviewTurnTargetError extends Schema.TaggedError<ReviewTurnTargetError>()(
  "ReviewTurnTargetError",
  {
    reason: Schema.NonEmptyString,
  },
) {}

/** A valid target cannot currently reserve a provider turn. */
export class ReviewTurnRejectedError extends Schema.TaggedError<ReviewTurnRejectedError>()(
  "ReviewTurnRejectedError",
  {
    reason: Schema.NonEmptyString,
  },
) {}

/** A completion or failure does not own the exact active run/message pair. */
export class ReviewTurnOwnershipError extends Schema.TaggedError<ReviewTurnOwnershipError>()(
  "ReviewTurnOwnershipError",
  {
    reason: Schema.NonEmptyString,
  },
) {}

/** A database or row-decoding failure prevented an aggregate persistence operation. */
export class ReviewTurnStoreError extends Schema.TaggedError<ReviewTurnStoreError>()(
  "ReviewTurnStoreError",
  {
    operation: Schema.NonEmptyString,
    cause: Schema.Defect,
  },
) {}

/** Transactional persistence boundary for the complete durable lifecycle of one review turn. */
export class ReviewTurnStore extends Context.Tag("@diffdash/ReviewTurnStore")<
  ReviewTurnStore,
  {
    readonly validateTarget: (
      input: ReviewTurnTargetInput,
    ) => Effect.Effect<ReviewTurnMappingToken, ReviewTurnTargetError | ReviewTurnStoreError>
    readonly beginTurn: (
      input: BeginReviewTurnInput,
    ) => Effect.Effect<
      BegunReviewTurn,
      ReviewTurnTargetError | ReviewTurnRejectedError | ReviewTurnStoreError
    >
    readonly completeTurn: (
      input: CompleteReviewTurnInput,
    ) => Effect.Effect<ReviewThreadDetails, ReviewTurnOwnershipError | ReviewTurnStoreError>
    readonly failTurn: (
      input: FailReviewTurnInput,
    ) => Effect.Effect<ReviewThreadDetails, ReviewTurnOwnershipError | ReviewTurnStoreError>
    readonly recoverInterruptedTurns: Effect.Effect<number, ReviewTurnStoreError>
  }
>() {
  /** Builds the aggregate layer with optional synchronous write instrumentation. */
  static readonly layerWith = (options: ReviewTurnStoreOptions = {}) =>
    Layer.effect(
      ReviewTurnStore,
      Effect.gen(function* () {
        const database = yield* DatabaseService
        const write = makeWrite(options)

        const validateTarget = Effect.fn("ReviewTurnStore.validateTarget")(function (
          input: ReviewTurnTargetInput,
        ) {
          return database
            .transaction("reviewTurns.validateTarget", (transaction) =>
              validateTargetTransaction(transaction, input),
            )
            .pipe(mapTargetTransactionError("validateTarget"))
        })

        return ReviewTurnStore.of({
          validateTarget,
          beginTurn: Effect.fn("ReviewTurnStore.beginTurn")(function (input) {
            return database
              .transaction("reviewTurns.beginTurn", (transaction) => {
                const mapping = validateTargetTransaction(transaction, input)
                assertMappingUnchanged(mapping, input.mapping)
                const messages = getMessages(transaction, input.threadId)
                const latestUserMessage = requireUnansweredUserMessage(messages)
                assertNoActiveTurn(transaction, input.threadId)
                const memory = getMemory(transaction, input.threadId)
                const resumableProviderRunId = getResumableProviderRunId(
                  transaction,
                  input.threadId,
                  input.provider,
                )
                const runId = AgentRunId.make(randomUUID())
                const messageId = ReviewThreadMessageId.make(randomUUID())
                const now = new Date().toISOString()
                write(
                  transaction,
                  "begin.run",
                  `INSERT INTO agent_runs (
                    id, thread_id, review_key, base_sha, head_sha, provider, model,
                    prompt_version, status, provider_run_id, error, started_at,
                    completed_at, usage_json
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, NULL)`,
                  [
                    runId,
                    input.threadId,
                    input.reviewKey,
                    input.baseRevision,
                    input.headRevision,
                    input.provider,
                    input.model,
                    input.promptVersion,
                    now,
                  ],
                )
                write(
                  transaction,
                  "begin.message",
                  `INSERT INTO review_thread_messages (
                    id, thread_id, sequence, author, body_markdown, status,
                    agent_run_id, created_at, updated_at
                  ) VALUES (?, ?, ?, 'agent', '', 'pending', ?, ?, ?)`,
                  [
                    messageId,
                    input.threadId,
                    nextMessageSequence(transaction, input.threadId),
                    runId,
                    now,
                    now,
                  ],
                )
                write(
                  transaction,
                  "begin.thread",
                  "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                  [now, input.threadId],
                )
                return {
                  run: getRun(transaction, runId),
                  pendingMessage: getMessage(transaction, messageId),
                  details: getDetails(transaction, input.threadId),
                  latestUserMessage,
                  memory,
                  resumableProviderRunId,
                }
              })
              .pipe(mapBeginTransactionError("beginTurn"))
          }),
          completeTurn: Effect.fn("ReviewTurnStore.completeTurn")(function (input) {
            return prepareCompleteInput(input).pipe(
              Effect.flatMap((prepared) =>
                database.transaction("reviewTurns.completeTurn", (transaction) => {
                  const { run, message } = requireOwnedActiveTurn(transaction, input)
                  const now = new Date().toISOString()
                  const artifactIds = new Set<string>()
                  for (const artifact of prepared.artifacts) {
                    if (artifactIds.has(artifact.id)) {
                      throw new Error(`Duplicate prepared artifact ID: ${artifact.id}`)
                    }
                    artifactIds.add(artifact.id)
                    if (artifact.provider !== run.provider) {
                      throw ReviewTurnOwnershipError.make({
                        reason: "Artifact provider does not own the active review turn.",
                      })
                    }
                    write(
                      transaction,
                      "complete.artifact",
                      `INSERT INTO agent_run_artifacts (
                        id, run_id, thread_id, type, title, content, content_digest,
                        metadata_json, truncated, original_size, created_at
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                      [
                        artifact.id,
                        input.runId,
                        input.threadId,
                        artifact.type,
                        artifact.title,
                        artifact.content,
                        artifact.contentDigest,
                        artifact.metadataJson,
                        artifact.truncated ? 1 : 0,
                        artifact.originalSize,
                        now,
                      ],
                    )
                  }
                  write(
                    transaction,
                    "complete.message",
                    `UPDATE review_thread_messages
                     SET body_markdown = ?, status = 'complete', updated_at = ?
                     WHERE id = ? AND thread_id = ? AND agent_run_id = ? AND status = 'pending'`,
                    [input.bodyMarkdown, now, message.id, input.threadId, input.runId],
                  )
                  write(
                    transaction,
                    "complete.run",
                    `UPDATE agent_runs
                     SET status = 'completed', provider_run_id = ?, usage_json = ?,
                         error = NULL, completed_at = ?
                     WHERE id = ? AND thread_id = ? AND status = 'running'`,
                    [prepared.providerRunId, prepared.usageJson, now, input.runId, input.threadId],
                  )
                  if (prepared.memory !== null) {
                    if (
                      prepared.memory.threadId !== input.threadId ||
                      prepared.memory.summarizedThroughSequence !== message.sequence
                    ) {
                      throw ReviewTurnOwnershipError.make({
                        reason: "Thread memory does not finalize the active review-turn message.",
                      })
                    }
                    write(
                      transaction,
                      "complete.memory",
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
                        prepared.memory.summary,
                        prepared.memory.summarizedThroughSequence,
                        prepared.memory.summaryAlgorithm,
                        prepared.memory.summaryVersion,
                        prepared.memory.importantArtifactIdsJson,
                        now,
                      ],
                    )
                  }
                  write(
                    transaction,
                    "complete.thread",
                    "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                    [now, input.threadId],
                  )
                  return getDetails(transaction, input.threadId)
                }),
              ),
              mapFinalizeTransactionError("completeTurn"),
            )
          }),
          failTurn: Effect.fn("ReviewTurnStore.failTurn")(function (input) {
            return database
              .transaction("reviewTurns.failTurn", (transaction) => {
                requireOwnedActiveTurn(transaction, input)
                const now = new Date().toISOString()
                write(
                  transaction,
                  "fail.message",
                  `UPDATE review_thread_messages
                   SET body_markdown = ?, status = 'failed', updated_at = ?
                   WHERE id = ? AND thread_id = ? AND agent_run_id = ? AND status = 'pending'`,
                  [input.diagnostic, now, input.messageId, input.threadId, input.runId],
                )
                write(
                  transaction,
                  "fail.run",
                  `UPDATE agent_runs
                   SET status = 'failed', provider_run_id = ?, usage_json = NULL,
                       error = ?, completed_at = ?
                   WHERE id = ? AND thread_id = ? AND status = 'running'`,
                  [input.providerRunId ?? null, input.diagnostic, now, input.runId, input.threadId],
                )
                write(
                  transaction,
                  "fail.thread",
                  "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                  [now, input.threadId],
                )
                return getDetails(transaction, input.threadId)
              })
              .pipe(mapFinalizeTransactionError("failTurn"))
          }),
          recoverInterruptedTurns: database
            .transaction("reviewTurns.recoverInterruptedTurns", (transaction) => {
              const running = transaction
                .all("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at, id")
                .map(decodeRunRow)
              const now = new Date().toISOString()
              const diagnostic = "The previous local agent run was interrupted. Retry to try again."
              for (const run of running) {
                const row = transaction.get(
                  `SELECT * FROM review_thread_messages
                   WHERE thread_id = ? AND agent_run_id = ? AND author = 'agent' AND status = 'pending'`,
                  [run.threadId, run.id],
                )
                if (row === undefined) {
                  throw new Error(`Running review turn has no linked pending message: ${run.id}`)
                }
                const message = decodeMessageRow(row)
                write(
                  transaction,
                  "recover.message",
                  `UPDATE review_thread_messages
                   SET body_markdown = ?, status = 'failed', updated_at = ? WHERE id = ?`,
                  [diagnostic, now, message.id],
                )
                write(
                  transaction,
                  "recover.run",
                  `UPDATE agent_runs
                   SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
                  [diagnostic, now, run.id],
                )
                write(
                  transaction,
                  "recover.thread",
                  "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                  [now, run.threadId],
                )
              }
              return running.length
            })
            .pipe(
              Effect.mapError((cause) =>
                ReviewTurnStoreError.make({ operation: "recoverInterruptedTurns", cause }),
              ),
            ),
        })
      }),
    )

  /** Production layer without fault injection. */
  static readonly layer = ReviewTurnStore.layerWith()
}

const validateTargetTransaction = (
  transaction: DatabaseTransaction,
  input: ReviewTurnTargetInput,
) => {
  const thread = getThread(transaction, input.threadId)
  const repositoryRow = transaction.get(
    "SELECT id, provider, owner, name, local_path FROM repos WHERE id = ?",
    [input.repoId],
  )
  if (repositoryRow === undefined) throw targetError("The requested repository is not available.")
  const repository = Schema.decodeUnknownSync(RepositoryTargetRow)(repositoryRow)
  const expectedTarget = canonicalTarget(input.target, repository)
  if (
    thread.repoId !== input.repoId ||
    expectedTarget.repoId !== input.repoId ||
    thread.reviewKey !== input.reviewKey ||
    expectedTarget.reviewKey !== input.reviewKey
  ) {
    throw targetError("The review thread belongs to a different review target.")
  }
  if (
    thread.currentBaseRevision !== input.baseRevision ||
    thread.currentHeadRevision !== input.headRevision
  ) {
    throw targetError("The review thread is mapped to a different review revision.")
  }
  if (thread.anchorStatus !== "active" || thread.currentAnchor === null) {
    throw targetError("The review thread line is unavailable in the current review revision.")
  }
  return ReviewTurnMappingToken.make({
    threadId: thread.id,
    repoId: thread.repoId,
    reviewKey: thread.reviewKey,
    baseRevision: thread.currentBaseRevision,
    headRevision: thread.currentHeadRevision,
    currentAnchor: thread.currentAnchor,
  })
}

const canonicalTarget = (
  target: ReviewThreadTarget,
  repository: typeof RepositoryTargetRow.Type,
) => {
  if (target.kind === "hosted") {
    if (repository.provider === "local") {
      throw targetError("A hosted review cannot use a local repository identity.")
    }
    return {
      repoId: makeHostedRepositoryKey(target.review.repository),
      reviewKey: ReviewKey.make(makeHostedReviewKey(target.review)),
    }
  }
  if (repository.provider !== "local" || repository.local_path === null) {
    throw targetError("A local review cannot use a hosted repository identity.")
  }
  const targetRoot = resolve(target.rootPath)
  if (resolve(repository.local_path) !== targetRoot) {
    throw targetError("The local review thread belongs to a different repository path.")
  }
  return {
    repoId: repository.id,
    reviewKey: localReviewKey(targetRoot, target.comparison),
  }
}

const localReviewKey = (
  rootPath: string,
  comparison: Extract<ReviewThreadTarget, { readonly kind: "local" }>["comparison"],
) => {
  const rootHash = createHash("sha256").update(rootPath).digest("hex")
  if (comparison["_tag"] === "workingTree") return ReviewKey.make(`local:${rootHash}`)
  const refHash = createHash("sha256").update(comparison.baseRef).digest("hex")
  return ReviewKey.make(`local:${rootHash}:base:${refHash}`)
}

const assertMappingUnchanged = (
  current: ReviewTurnMappingToken,
  expected: ReviewTurnMappingToken,
) => {
  if (
    current.threadId !== expected.threadId ||
    current.repoId !== expected.repoId ||
    current.reviewKey !== expected.reviewKey ||
    current.baseRevision !== expected.baseRevision ||
    current.headRevision !== expected.headRevision ||
    !sameAnchor(current.currentAnchor, expected.currentAnchor)
  ) {
    throw targetError("The review thread mapping changed before the agent turn began.")
  }
}

const requireUnansweredUserMessage = (messages: readonly ReviewThreadMessage[]) => {
  let latestUser: ReviewThreadMessage | undefined
  for (const message of messages) {
    if (message.author === "user") latestUser = message
  }
  if (latestUser === undefined) {
    throw ReviewTurnRejectedError.make({ reason: "Review thread has no user message." })
  }
  const laterAgents = messages.filter(
    (message) => message.author === "agent" && message.sequence > latestUser.sequence,
  )
  if (laterAgents.some((message) => message.status === "pending")) {
    throw ReviewTurnRejectedError.make({ reason: "A review agent turn is already running." })
  }
  if (laterAgents.some((message) => message.status === "complete")) {
    throw ReviewTurnRejectedError.make({
      reason: "The latest user message already has an agent response.",
    })
  }
  return latestUser
}

const assertNoActiveTurn = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const activeRun = transaction.get(
    "SELECT id FROM agent_runs WHERE thread_id = ? AND status = 'running' LIMIT 1",
    [threadId],
  )
  const pendingMessage = transaction.get(
    `SELECT id FROM review_thread_messages
     WHERE thread_id = ? AND author = 'agent' AND status = 'pending' LIMIT 1`,
    [threadId],
  )
  if (activeRun !== undefined || pendingMessage !== undefined) {
    throw ReviewTurnRejectedError.make({ reason: "A review agent turn is already running." })
  }
}

const requireOwnedActiveTurn = (
  transaction: DatabaseTransaction,
  input: Pick<CompleteReviewTurnInput, "threadId" | "runId" | "messageId">,
) => {
  const run = getRun(transaction, input.runId)
  const message = getMessage(transaction, input.messageId)
  if (
    run.threadId !== input.threadId ||
    run.status !== "running" ||
    message.threadId !== input.threadId ||
    message.author !== "agent" ||
    message.status !== "pending" ||
    message.agentRunId !== input.runId
  ) {
    throw ReviewTurnOwnershipError.make({
      reason: "The run and pending message do not own the same active review turn.",
    })
  }
  return { run, message }
}

const prepareCompleteInput = (input: CompleteReviewTurnInput) =>
  Effect.gen(function* () {
    const usageJson = yield* Schema.encode(ReviewAgentUsageJson)(input.usage)
    const artifacts = yield* Effect.forEach(input.artifacts, ({ id, artifact }) =>
      Effect.gen(function* () {
        const metadataJson = yield* Schema.encode(ArtifactMetadataJson)(artifact.metadata)
        return {
          id,
          provider: artifact.provider,
          type: artifact.type,
          title: artifact.title,
          content: artifact.content,
          contentDigest: artifact.contentDigest,
          metadataJson,
          truncated: artifact.truncated,
          originalSize: artifact.originalSize,
        }
      }),
    )
    const memory =
      input.memoryUpdate === null
        ? null
        : {
            ...input.memoryUpdate,
            importantArtifactIdsJson: yield* Schema.encode(ImportantArtifactIdsJson)(
              input.memoryUpdate.importantArtifactIds,
            ),
          }
    return { providerRunId: input.providerRunId, usageJson, artifacts, memory }
  }).pipe(
    Effect.mapError((cause) =>
      ReviewTurnStoreError.make({ operation: "completeTurn.prepare", cause }),
    ),
  )

const getThread = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const row = transaction.get("SELECT * FROM review_threads WHERE id = ?", [threadId])
  if (row === undefined) throw targetError("The requested review thread was not found.")
  if (Schema.decodeUnknownSync(ReviewThreadRow)(row).status !== "open") {
    throw targetError("The requested review thread is not open.")
  }
  return decodeThreadRow(row)
}

const getMessages = (transaction: DatabaseTransaction, threadId: ReviewThreadId) =>
  transaction
    .all("SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY sequence ASC", [
      threadId,
    ])
    .map(decodeMessageRow)

const getMessage = (transaction: DatabaseTransaction, messageId: ReviewThreadMessageId) => {
  const row = transaction.get("SELECT * FROM review_thread_messages WHERE id = ?", [messageId])
  if (row === undefined) {
    throw ReviewTurnOwnershipError.make({ reason: "The active review-turn message was not found." })
  }
  return decodeMessageRow(row)
}

const getRun = (transaction: DatabaseTransaction, runId: AgentRunId) => {
  const row = transaction.get("SELECT * FROM agent_runs WHERE id = ?", [runId])
  if (row === undefined) {
    throw ReviewTurnOwnershipError.make({ reason: "The active review turn was not found." })
  }
  return decodeRunRow(row)
}

const getDetails = (transaction: DatabaseTransaction, threadId: ReviewThreadId) =>
  ReviewThreadDetails.make({
    thread: getThread(transaction, threadId),
    messages: getMessages(transaction, threadId),
  })

const getMemory = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const row = transaction.get("SELECT * FROM thread_memory WHERE thread_id = ?", [threadId])
  return row === undefined ? null : decodeMemoryRow(row)
}

const getResumableProviderRunId = (
  transaction: DatabaseTransaction,
  threadId: ReviewThreadId,
  provider: ReviewAgentProviderId,
) => {
  const row = transaction.get(
    `SELECT * FROM agent_runs
     WHERE thread_id = ? AND provider = ? AND status = 'completed' AND provider_run_id IS NOT NULL
     ORDER BY started_at DESC, id ASC LIMIT 1`,
    [threadId, provider],
  )
  return row === undefined ? null : decodeRunRow(row).providerRunId
}

const nextMessageSequence = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const row = transaction.get(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM review_thread_messages WHERE thread_id = ?`,
    [threadId],
  )
  if (row === undefined) throw new Error("Unable to allocate review-turn message sequence")
  return Schema.decodeUnknownSync(NextSequenceRow)(row).next_sequence
}

const decodeThreadRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(ReviewThreadRow)(input)
  return ReviewThread.make({
    id: row.id,
    repoId: row.repo_id,
    reviewKey: row.review_key,
    prNumber: row.pr_number,
    baseRevision: row.base_sha,
    headRevision: row.head_sha,
    currentBaseRevision: row.current_base_sha,
    currentHeadRevision: row.current_head_sha,
    originalAnchor: row.original_anchor_json,
    currentAnchor: row.current_anchor_json,
    anchorStatus: row.anchor_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

const decodeMessageRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(ReviewThreadMessageRow)(input)
  return ReviewThreadMessage.make({
    id: row.id,
    threadId: row.thread_id,
    sequence: row.sequence,
    author: row.author,
    bodyMarkdown: row.body_markdown,
    status: row.status,
    agentRunId: row.agent_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

const decodeRunRow = (input: unknown) => {
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

const decodeMemoryRow = (input: unknown) => {
  const row = Schema.decodeUnknownSync(ThreadMemoryRow)(input)
  return ThreadMemoryModel.make({
    threadId: row.thread_id,
    summary: row.summary,
    summarizedThroughSequence: row.summarized_through_sequence,
    summaryAlgorithm: row.summary_algorithm,
    summaryVersion: row.summary_version,
    importantArtifactIds: row.important_artifact_ids_json,
    updatedAt: row.updated_at,
  })
}

const makeWrite =
  (options: ReviewTurnStoreOptions) =>
  (
    transaction: DatabaseTransaction,
    step: ReviewTurnWriteStep,
    sql: string,
    params: readonly unknown[],
  ) => {
    transaction.run(sql, params)
    options.afterWrite?.(step)
  }

const targetError = (reason: string) => ReviewTurnTargetError.make({ reason })

const nestedCause = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : cause

const mapTargetTransactionError = (operation: string) =>
  Effect.mapError((cause: unknown) => {
    const nested = nestedCause(cause)
    return nested instanceof ReviewTurnTargetError
      ? nested
      : ReviewTurnStoreError.make({ operation, cause })
  })

const mapBeginTransactionError = (operation: string) =>
  Effect.mapError((cause: unknown) => {
    const nested = nestedCause(cause)
    return nested instanceof ReviewTurnTargetError || nested instanceof ReviewTurnRejectedError
      ? nested
      : ReviewTurnStoreError.make({ operation, cause })
  })

const mapFinalizeTransactionError = (operation: string) =>
  Effect.mapError((cause: unknown) => {
    const nested = nestedCause(cause)
    return nested instanceof ReviewTurnOwnershipError || nested instanceof ReviewTurnStoreError
      ? nested
      : ReviewTurnStoreError.make({ operation, cause })
  })

const sameAnchor = (left: ReviewThreadAnchor, right: ReviewThreadAnchor) =>
  left.fileId === right.fileId &&
  left.filePath === right.filePath &&
  left.oldPath === right.oldPath &&
  left.hunkId === right.hunkId &&
  left.hunkFingerprint === right.hunkFingerprint &&
  left.hunkHeader === right.hunkHeader &&
  left.side === right.side &&
  left.lineNumber === right.lineNumber &&
  left.lineContent === right.lineContent
