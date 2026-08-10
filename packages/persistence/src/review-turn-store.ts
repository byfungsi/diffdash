import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import {
  AgentPromptVersion,
  CompletedAgentRun,
  RunningAgentRun,
  type ThreadMemory,
  ThreadMemory as ThreadMemoryModel,
  ThreadMemorySummaryAlgorithm,
  type UpsertThreadMemoryInput,
} from "@diffdash/domain/agent-run"
import { makeHostedRepositoryKey, makeHostedReviewKey } from "@diffdash/domain/git-provider"
import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import {
  AgentProviderFailure,
  type AgentProviderFailure as AgentProviderFailureType,
} from "@diffdash/domain/provider-failure"
import {
  AgentRunId,
  type ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentArtifactMetadata,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  type ReviewAgentUsage,
  ReviewAgentUsage as ReviewAgentUsageSchema,
} from "@diffdash/domain/review-agent"
import { ReviewKey, ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import {
  MarkdownBody,
  CompletedAgentReviewThreadMessage,
  PendingAgentReviewThreadMessage,
  ReviewThreadAnchor,
  ReviewThreadDetails,
  ReviewThreadId,
  type ReviewThreadMessage,
  ReviewThreadMessageId,
  UserReviewThreadMessage,
  type ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { makeRepositoryComparisonReviewKey } from "@diffdash/domain/repository-comparison"
import { Context, Effect, Layer, Match, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type Database, type DatabaseRow, makeDatabase, toError, type SqlParams } from "./database"
import { makeReviewThreadFromRow, ReviewThreadRow } from "./review-thread-row"
import {
  decodeAgentRunRow,
  decodeReviewThreadMessageRow,
  projectReviewConversation,
} from "./review-turn-row"

const AgentProviderFailureJson = Schema.NullOr(Schema.fromJsonString(AgentProviderFailure))
const ReviewAgentUsageJson = Schema.NullOr(Schema.fromJsonString(ReviewAgentUsageSchema))
const ArtifactMetadataJson = Schema.fromJsonString(ReviewAgentArtifactMetadata)
const ImportantArtifactIdsJson = Schema.fromJsonString(Schema.Array(ReviewAgentArtifactId))

const ThreadMemoryRow = Schema.Struct({
  thread_id: ReviewThreadId,
  summary: Schema.String,
  summarized_through_sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  summary_algorithm: ThreadMemorySummaryAlgorithm,
  summary_version: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  important_artifact_ids_json: ImportantArtifactIdsJson,
  updated_at: Schema.String,
})

const RepositoryTargetRow = Schema.Struct({
  id: ReviewProjectId,
  provider: Schema.NonEmptyString,
  owner: Schema.String,
  name: Schema.String,
  local_path: Schema.NullOr(RepositoryCheckoutPath),
})

const NextSequenceRow = Schema.Struct({
  next_sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
})

/** Identity supplied by the renderer and checked before expensive review-turn work. */
interface ReviewTurnTargetInput {
  readonly threadId: ReviewThreadId
  readonly target: ReviewThreadTarget
  readonly repoId: ReviewProjectId
  readonly reviewKey: ReviewKey
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
}

/** Exact active mapping observed by the advisory target check and rechecked by beginTurn. */
export class ReviewTurnMappingToken extends Schema.Class<ReviewTurnMappingToken>(
  "ReviewTurnMappingToken",
)({
  threadId: ReviewThreadId,
  repoId: ReviewProjectId,
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
  readonly run: RunningAgentRun
  readonly pendingMessage: PendingAgentReviewThreadMessage
  readonly details: ReviewThreadDetails
  readonly latestUserMessage: UserReviewThreadMessage
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
  readonly failure: AgentProviderFailureType | null
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
    operation: DiagnosticOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Transactional persistence boundary for the complete durable lifecycle of one review turn. */
export class ReviewTurnStore extends Context.Service<
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
>()("@diffdash/ReviewTurnStore") {
  /** Builds the aggregate layer with optional post-write fault instrumentation. */
  static readonly layerWith = (options: ReviewTurnStoreOptions = {}) =>
    Layer.effect(
      ReviewTurnStore,
      Effect.gen(function* () {
        const database = makeDatabase(yield* SqlClient.SqlClient)
        const write = makeWrite(options)

        const validateTarget = Effect.fn("ReviewTurnStore.validateTarget")(function (
          input: ReviewTurnTargetInput,
        ) {
          return database
            .transaction(validateTargetTransaction(database, input))
            .pipe(mapTargetTransactionError("validateTarget"))
        })

        return ReviewTurnStore.of({
          validateTarget,
          beginTurn: Effect.fn("ReviewTurnStore.beginTurn")(function (input) {
            return database
              .transaction(
                Effect.gen(function* () {
                  const mapping = yield* validateTargetTransaction(database, input)
                  yield* assertMappingUnchanged(mapping, input.mapping)
                  const messages = yield* getMessages(database, input.threadId)
                  const latestUserMessage = yield* requireUnansweredUserMessage(messages)
                  yield* assertNoActiveTurn(database, input.threadId)
                  const memory = yield* getMemory(database, input.threadId)
                  const resumableProviderRunId = yield* getResumableProviderRunId(
                    database,
                    input.threadId,
                    input.provider,
                  )
                  const runId = AgentRunId.make(randomUUID())
                  const messageId = ReviewThreadMessageId.make(randomUUID())
                  const now = new Date().toISOString()
                  yield* write(
                    database,
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
                  yield* write(
                    database,
                    "begin.message",
                    `INSERT INTO review_thread_messages (
                    id, thread_id, sequence, author, body_markdown, status,
                    agent_run_id, created_at, updated_at
                  ) VALUES (?, ?, ?, 'agent', '', 'pending', ?, ?, ?)`,
                    [
                      messageId,
                      input.threadId,
                      yield* nextMessageSequence(database, input.threadId),
                      runId,
                      now,
                      now,
                    ],
                  )
                  yield* write(
                    database,
                    "begin.thread",
                    "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                    [now, input.threadId],
                  )
                  const run = yield* getRun(database, runId)
                  const pendingMessage = yield* getMessage(database, messageId)
                  if (
                    !Schema.is(RunningAgentRun)(run) ||
                    !Schema.is(PendingAgentReviewThreadMessage)(pendingMessage)
                  ) {
                    return yield* storeError(
                      "beginTurn.projection",
                      new Error("New review turn did not decode as an active run and response."),
                    )
                  }
                  return {
                    run,
                    pendingMessage,
                    details: yield* getDetails(database, input.threadId),
                    latestUserMessage,
                    memory: Option.getOrNull(memory),
                    resumableProviderRunId: Option.getOrNull(resumableProviderRunId),
                  }
                }),
              )
              .pipe(mapBeginTransactionError("beginTurn"))
          }),
          completeTurn: Effect.fn("ReviewTurnStore.completeTurn")(function (input) {
            return prepareCompleteInput(input).pipe(
              Effect.flatMap((prepared) =>
                database.transaction(
                  Effect.gen(function* () {
                    const { run, message } = yield* requireOwnedActiveTurn(database, input)
                    const now = new Date().toISOString()
                    const artifactIds = new Set<string>()
                    for (const artifact of prepared.artifacts) {
                      if (artifactIds.has(artifact.id)) {
                        return yield* storeError(
                          "completeTurn.duplicateArtifact",
                          new Error(`Duplicate prepared artifact ID: ${artifact.id}`),
                        )
                      }
                      artifactIds.add(artifact.id)
                      if (artifact.provider !== run.provider) {
                        return yield* ReviewTurnOwnershipError.make({
                          reason: "Artifact provider does not own the active review turn.",
                        })
                      }
                      yield* write(
                        database,
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
                    yield* write(
                      database,
                      "complete.message",
                      `UPDATE review_thread_messages
                   SET body_markdown = ?, status = 'complete', updated_at = ?
                     WHERE id = ? AND thread_id = ? AND agent_run_id = ? AND status = 'pending'`,
                      [input.bodyMarkdown, now, message.id, input.threadId, input.runId],
                    )
                    yield* write(
                      database,
                      "complete.run",
                      `UPDATE agent_runs
                     SET status = 'completed', provider_run_id = ?, usage_json = ?,
                         error = NULL, completed_at = ?
                     WHERE id = ? AND thread_id = ? AND status = 'running'`,
                      [
                        prepared.providerRunId,
                        prepared.usageJson,
                        now,
                        input.runId,
                        input.threadId,
                      ],
                    )
                    if (prepared.memory !== null) {
                      if (
                        prepared.memory.threadId !== input.threadId ||
                        prepared.memory.summarizedThroughSequence !== message.sequence
                      ) {
                        return yield* ReviewTurnOwnershipError.make({
                          reason: "Thread memory does not finalize the active review-turn message.",
                        })
                      }
                      yield* write(
                        database,
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
                    yield* write(
                      database,
                      "complete.thread",
                      "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                      [now, input.threadId],
                    )
                    return yield* getDetails(database, input.threadId)
                  }),
                ),
              ),
              mapFinalizeTransactionError("completeTurn"),
            )
          }),
          failTurn: Effect.fn("ReviewTurnStore.failTurn")(function (input) {
            return Schema.encodeEffect(AgentProviderFailureJson)(input.failure).pipe(
              Effect.flatMap((failureJson) =>
                database.transaction(
                  Effect.gen(function* () {
                    yield* requireOwnedActiveTurn(database, input)
                    const now = new Date().toISOString()
                    yield* write(
                      database,
                      "fail.message",
                      `UPDATE review_thread_messages
                    SET body_markdown = ?, status = 'failed', failure_json = ?, updated_at = ?
                    WHERE id = ? AND thread_id = ? AND agent_run_id = ? AND status = 'pending'`,
                      [
                        input.diagnostic,
                        failureJson,
                        now,
                        input.messageId,
                        input.threadId,
                        input.runId,
                      ],
                    )
                    yield* write(
                      database,
                      "fail.run",
                      `UPDATE agent_runs
                   SET status = 'failed', provider_run_id = ?, usage_json = NULL,
                       error = ?, completed_at = ?
                   WHERE id = ? AND thread_id = ? AND status = 'running'`,
                      [
                        input.providerRunId ?? null,
                        input.diagnostic,
                        now,
                        input.runId,
                        input.threadId,
                      ],
                    )
                    yield* write(
                      database,
                      "fail.thread",
                      "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                      [now, input.threadId],
                    )
                    return yield* getDetails(database, input.threadId)
                  }),
                ),
              ),
              mapFinalizeTransactionError("failTurn"),
            )
          }),
          recoverInterruptedTurns: database
            .transaction(
              Effect.gen(function* () {
                const running = yield* database
                  .all("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at, id")
                  .pipe(
                    Effect.flatMap((rows) => Effect.forEach(rows, decodeAgentRunRow)),
                    Effect.mapError((cause) => storeError("decode.run", cause)),
                  )
                const now = new Date().toISOString()
                const diagnostic =
                  "The previous local agent run was interrupted. Retry to try again."
                for (const run of running) {
                  const row = yield* database.get(
                    `SELECT * FROM review_thread_messages
                   WHERE thread_id = ? AND agent_run_id = ? AND author = 'agent' AND status = 'pending'`,
                    [run.threadId, run.id],
                  )
                  if (Option.isNone(row)) {
                    return yield* storeError(
                      "recoverInterruptedTurns.missingMessage",
                      new Error(`Running review turn has no linked pending message: ${run.id}`),
                    )
                  }
                  const message = yield* decodeMessageRowEffect(row.value)
                  yield* write(
                    database,
                    "recover.message",
                    `UPDATE review_thread_messages
                   SET body_markdown = ?, status = 'failed', updated_at = ? WHERE id = ?`,
                    [diagnostic, now, message.id],
                  )
                  yield* write(
                    database,
                    "recover.run",
                    `UPDATE agent_runs
                   SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
                    [diagnostic, now, run.id],
                  )
                  yield* write(
                    database,
                    "recover.thread",
                    "UPDATE review_threads SET updated_at = ? WHERE id = ?",
                    [now, run.threadId],
                  )
                }
                return running.length
              }),
            )
            .pipe(Effect.mapError((cause) => storeError("recoverInterruptedTurns", cause))),
        })
      }),
    )

  /** Production layer without fault injection. */
  static readonly layer = ReviewTurnStore.layerWith()
}

const validateTargetTransaction = (database: Database, input: ReviewTurnTargetInput) =>
  Effect.gen(function* () {
    const thread = yield* getThread(database, input.threadId)
    const repositoryRow = yield* database.get(
      "SELECT id, provider, owner, name, local_path FROM repos WHERE id = ?",
      [input.repoId],
    )
    if (Option.isNone(repositoryRow)) {
      return yield* targetError("The requested repository is not available.")
    }
    const repository = yield* decodeRepositoryTargetRowEffect(repositoryRow.value)
    const expectedTarget = yield* Effect.try({
      try: () => canonicalTarget(input.target, repository),
      catch: (cause) =>
        Schema.is(ReviewTurnTargetError)(cause)
          ? cause
          : storeError("validateTarget.canonicalTarget", cause),
    })
    if (
      thread.repoId !== input.repoId ||
      expectedTarget.repoId !== input.repoId ||
      thread.reviewKey !== input.reviewKey ||
      expectedTarget.reviewKey !== input.reviewKey
    ) {
      return yield* targetError("The review thread belongs to a different review target.")
    }
    if (
      thread.currentBaseRevision !== input.baseRevision ||
      thread.currentHeadRevision !== input.headRevision
    ) {
      return yield* targetError("The review thread is mapped to a different review revision.")
    }
    const activeAnchor = Match.value(thread.currentAnchor).pipe(
      Match.tag("Active", ({ anchor }) => Option.some(anchor)),
      Match.orElse(() => Option.none()),
    )
    if (Option.isNone(activeAnchor)) {
      return yield* targetError(
        "The review thread line is unavailable in the current review revision.",
      )
    }
    return ReviewTurnMappingToken.make({
      threadId: thread.id,
      repoId: thread.repoId,
      reviewKey: thread.reviewKey,
      baseRevision: thread.currentBaseRevision,
      headRevision: thread.currentHeadRevision,
      currentAnchor: activeAnchor.value,
    })
  })

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
  if (target.kind === "repositoryComparison") {
    if (repository.provider === "local") {
      throw targetError("A repository comparison cannot use a local-only repository identity.")
    }
    return {
      repoId: makeHostedRepositoryKey(target.repository),
      reviewKey: makeRepositoryComparisonReviewKey(target),
    }
  }
  if (repository.local_path === null) throw targetError("A local review requires a local checkout.")
  const localPath = repository.local_path
  const targetRoot = resolve(target.rootPath)
  if (resolve(localPath) !== targetRoot) {
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
  return Match.value(comparison).pipe(
    Match.tag("workingTree", () => ReviewKey.make(`local:${rootHash}`)),
    Match.tag("branch", (branch) => {
      const refHash = createHash("sha256").update(branch.baseRef).digest("hex")
      return ReviewKey.make(`local:${rootHash}:base:${refHash}`)
    }),
    Match.exhaustive,
  )
}

const assertMappingUnchanged = (
  current: ReviewTurnMappingToken,
  expected: ReviewTurnMappingToken,
) =>
  Effect.gen(function* () {
    if (
      current.threadId !== expected.threadId ||
      current.repoId !== expected.repoId ||
      current.reviewKey !== expected.reviewKey ||
      current.baseRevision !== expected.baseRevision ||
      current.headRevision !== expected.headRevision ||
      !sameAnchor(current.currentAnchor, expected.currentAnchor)
    ) {
      return yield* targetError("The review thread mapping changed before the agent turn began.")
    }
  })

const requireUnansweredUserMessage = (messages: readonly ReviewThreadMessage[]) =>
  Effect.gen(function* () {
    let latestUser: UserReviewThreadMessage | undefined
    for (const message of messages) {
      if (Schema.is(UserReviewThreadMessage)(message)) latestUser = message
    }
    if (latestUser === undefined) {
      return yield* ReviewTurnRejectedError.make({ reason: "Review thread has no user message." })
    }
    const laterAgents = messages.filter(
      (message) =>
        !Schema.is(UserReviewThreadMessage)(message) && message.sequence > latestUser.sequence,
    )
    if (laterAgents.some((message) => Schema.is(PendingAgentReviewThreadMessage)(message))) {
      return yield* ReviewTurnRejectedError.make({
        reason: "A review agent turn is already running.",
      })
    }
    if (laterAgents.some((message) => Schema.is(CompletedAgentReviewThreadMessage)(message))) {
      return yield* ReviewTurnRejectedError.make({
        reason: "The latest user message already has an agent response.",
      })
    }
    return latestUser
  })

const assertNoActiveTurn = (database: Database, threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const activeRun = yield* database.get(
      "SELECT id FROM agent_runs WHERE thread_id = ? AND status = 'running' LIMIT 1",
      [threadId],
    )
    const pendingMessage = yield* database.get(
      `SELECT id FROM review_thread_messages
     WHERE thread_id = ? AND author = 'agent' AND status = 'pending' LIMIT 1`,
      [threadId],
    )
    if (Option.isSome(activeRun) || Option.isSome(pendingMessage)) {
      return yield* ReviewTurnRejectedError.make({
        reason: "A review agent turn is already running.",
      })
    }
  })

const requireOwnedActiveTurn = (
  database: Database,
  input: Pick<CompleteReviewTurnInput, "threadId" | "runId" | "messageId">,
) =>
  Effect.gen(function* () {
    const run = yield* getRun(database, input.runId)
    const message = yield* getMessage(database, input.messageId)
    if (
      run.threadId !== input.threadId ||
      !Schema.is(RunningAgentRun)(run) ||
      message.threadId !== input.threadId ||
      !Schema.is(PendingAgentReviewThreadMessage)(message) ||
      message.agentRunId !== input.runId
    ) {
      return yield* ReviewTurnOwnershipError.make({
        reason: "The run and pending message do not own the same active review turn.",
      })
    }
    return { run, message }
  })

const prepareCompleteInput = (input: CompleteReviewTurnInput) =>
  Effect.gen(function* () {
    const usageJson = yield* Schema.encodeEffect(ReviewAgentUsageJson)(input.usage)
    const artifacts = yield* Effect.forEach(input.artifacts, ({ id, artifact }) =>
      Effect.gen(function* () {
        const metadataJson = yield* Schema.encodeEffect(ArtifactMetadataJson)(artifact.metadata)
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
            importantArtifactIdsJson: yield* Schema.encodeEffect(ImportantArtifactIdsJson)(
              input.memoryUpdate.importantArtifactIds,
            ),
          }
    return { providerRunId: input.providerRunId, usageJson, artifacts, memory }
  }).pipe(Effect.mapError((cause) => storeError("completeTurn.prepare", cause)))

const getThread = (database: Database, threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const row = yield* database.get("SELECT * FROM review_threads WHERE id = ?", [threadId])
    const threadRow = yield* Effect.fromOption(row, () =>
      targetError("The requested review thread was not found."),
    )
    const decoded = yield* decodeReviewThreadRowEffect(threadRow)
    if (decoded.status !== "open") {
      return yield* targetError("The requested review thread is not open.")
    }
    return yield* makeReviewThreadFromRow(decoded).pipe(
      Effect.mapError((cause) => storeError("decode.thread", cause)),
    )
  })

const getMessages = (database: Database, threadId: ReviewThreadId) =>
  database
    .all("SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY sequence ASC", [
      threadId,
    ])
    .pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeReviewThreadMessageRow)),
      Effect.mapError((cause) => storeError("decode.message", cause)),
    )

const getRuns = (database: Database, threadId: ReviewThreadId) =>
  database
    .all("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC, id ASC", [threadId])
    .pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeAgentRunRow)),
      Effect.mapError((cause) => storeError("decode.run", cause)),
    )

const getMessage = (database: Database, messageId: ReviewThreadMessageId) =>
  Effect.gen(function* () {
    const row = yield* database.get("SELECT * FROM review_thread_messages WHERE id = ?", [
      messageId,
    ])
    const messageRow = yield* Effect.fromOption(row, () =>
      ReviewTurnOwnershipError.make({
        reason: "The active review-turn message was not found.",
      }),
    )
    return yield* decodeMessageRowEffect(messageRow)
  })

const getRun = (database: Database, runId: AgentRunId) =>
  Effect.gen(function* () {
    const row = yield* database.get("SELECT * FROM agent_runs WHERE id = ?", [runId])
    const runRow = yield* Effect.fromOption(row, () =>
      ReviewTurnOwnershipError.make({
        reason: "The active review turn was not found.",
      }),
    )
    return yield* decodeRunRowEffect(runRow)
  })

const getDetails = (database: Database, threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const messages = yield* getMessages(database, threadId)
    const runs = yield* getRuns(database, threadId)
    return ReviewThreadDetails.make({
      thread: yield* getThread(database, threadId),
      conversation: yield* projectReviewConversation(messages, runs).pipe(
        Effect.mapError((cause) => storeError("decode.conversation", cause)),
      ),
    })
  })

const getMemory = (database: Database, threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const row = yield* database.get("SELECT * FROM thread_memory WHERE thread_id = ?", [threadId])
    return yield* Option.map(row, decodeMemoryRowEffect).pipe(Effect.transposeOption)
  })

const getResumableProviderRunId = (
  database: Database,
  threadId: ReviewThreadId,
  provider: ReviewAgentProviderId,
) =>
  Effect.gen(function* () {
    const row = yield* database.get(
      `SELECT * FROM agent_runs
     WHERE thread_id = ? AND provider = ? AND status = 'completed' AND provider_run_id IS NOT NULL
     ORDER BY started_at DESC, id ASC LIMIT 1`,
      [threadId, provider],
    )
    const run = yield* Option.map(row, decodeRunRowEffect).pipe(Effect.transposeOption)
    return Option.flatMap(run, (completed) =>
      Schema.is(CompletedAgentRun)(completed) && completed.providerRunId !== undefined
        ? Option.some(completed.providerRunId)
        : Option.none(),
    )
  })

const nextMessageSequence = (database: Database, threadId: ReviewThreadId) =>
  Effect.gen(function* () {
    const row = yield* database.get(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM review_thread_messages WHERE thread_id = ?`,
      [threadId],
    )
    return yield* Effect.fromOption(row, () =>
      storeError(
        "beginTurn.nextMessageSequence",
        new Error("Unable to allocate review-turn message sequence"),
      ),
    ).pipe(
      Effect.flatMap(decodeNextSequenceRowEffect),
      Effect.map((decoded) => decoded.next_sequence),
    )
  })

const makeMemoryEffect = (row: typeof ThreadMemoryRow.Type) =>
  ThreadMemoryModel.makeEffect({
    threadId: row.thread_id,
    summary: row.summary,
    summarizedThroughSequence: row.summarized_through_sequence,
    summaryAlgorithm: row.summary_algorithm,
    summaryVersion: row.summary_version,
    importantArtifactIds: row.important_artifact_ids_json,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError((cause) => storeError("decode.memory", cause)))

const decodeRepositoryTargetRowEffect = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(RepositoryTargetRow)(input).pipe(
    Effect.mapError((cause) => storeError("decode.repositoryTarget", cause)),
  )

const decodeReviewThreadRowEffect = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(ReviewThreadRow)(input).pipe(
    Effect.mapError((cause) => storeError("decode.reviewThreadRow", cause)),
  )

const decodeNextSequenceRowEffect = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(NextSequenceRow)(input).pipe(
    Effect.mapError((cause) => storeError("decode.nextSequenceRow", cause)),
  )

const decodeMessageRowEffect = (input: DatabaseRow) =>
  decodeReviewThreadMessageRow(input).pipe(
    Effect.mapError((cause) => storeError("decode.message", cause)),
  )

const decodeRunRowEffect = (input: DatabaseRow) =>
  decodeAgentRunRow(input).pipe(Effect.mapError((cause) => storeError("decode.run", cause)))

const decodeMemoryRowEffect = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(ThreadMemoryRow)(input).pipe(
    Effect.mapError((cause) => storeError("decode.memory", cause)),
    Effect.flatMap(makeMemoryEffect),
  )

const makeWrite =
  (options: ReviewTurnStoreOptions) =>
  (database: Database, step: ReviewTurnWriteStep, sql: string, params: SqlParams) =>
    database.run(sql, params).pipe(
      Effect.flatMap(() =>
        options.afterWrite === undefined
          ? Effect.void
          : Effect.try({
              try: () => options.afterWrite?.(step),
              catch: (cause) => storeError(`afterWrite.${step}`, cause),
            }),
      ),
      Effect.asVoid,
    )

const targetError = (reason: string) => ReviewTurnTargetError.make({ reason })

const storeError = <A>(operation: string, cause: A) =>
  ReviewTurnStoreError.make({
    operation: DiagnosticOperation.make(operation),
    cause: toError(cause),
  })

const nestedCause = <A>(cause: A) => {
  const nested = Option.getOrNull(
    Schema.decodeUnknownOption(Schema.Struct({ cause: Schema.ErrorInstance() }))(cause),
  )
  return nested?.cause ?? cause
}

const mapTargetTransactionError = (operation: string) =>
  Effect.mapError((cause) => {
    if (Schema.is(ReviewTurnTargetError)(cause) || Schema.is(ReviewTurnStoreError)(cause))
      return cause
    const nested = nestedCause(cause)
    return Schema.is(ReviewTurnTargetError)(nested) ? nested : storeError(operation, cause)
  })

const mapBeginTransactionError = (operation: string) =>
  Effect.mapError((cause) => {
    if (
      Schema.is(ReviewTurnTargetError)(cause) ||
      Schema.is(ReviewTurnRejectedError)(cause) ||
      Schema.is(ReviewTurnStoreError)(cause)
    ) {
      return cause
    }
    const nested = nestedCause(cause)
    return Schema.is(ReviewTurnTargetError)(nested) || Schema.is(ReviewTurnRejectedError)(nested)
      ? nested
      : storeError(operation, cause)
  })

const mapFinalizeTransactionError = (operation: string) =>
  Effect.mapError((cause) => {
    if (Schema.is(ReviewTurnOwnershipError)(cause) || Schema.is(ReviewTurnStoreError)(cause)) {
      return cause
    }
    const nested = nestedCause(cause)
    return Schema.is(ReviewTurnOwnershipError)(nested) ? nested : storeError(operation, cause)
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
