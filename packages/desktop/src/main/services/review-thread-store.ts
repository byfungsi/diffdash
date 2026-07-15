import { Context, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"

import {
  type AddReviewThreadUserMessageRequest,
  type CreatePendingReviewThreadAgentMessageInput,
  type CreateReviewThreadInput,
  MarkdownBody,
  type ReviewThreadAnchor,
  ReviewThreadAnchor as ReviewThreadAnchorSchema,
  type ReviewAnchorStatus as ReviewAnchorStatusType,
  ReviewAnchorStatus,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  type ReviewThreadListKey,
  ReviewThreadMessage,
  ReviewThreadMessageAuthor,
  ReviewThreadMessageId,
  ReviewThreadMessageStatus,
  type ReviewThreadRevisionKey,
} from "../../shared/review-thread"
import { ReviewKey, ReviewRevision } from "../../shared/review-identity"
import { DatabaseService, type DatabaseTransaction } from "./database"

/** One thread's complete current-revision mapping, persisted as a single logical update. */
export interface ReviewThreadCurrentMapping {
  readonly threadId: ReviewThreadId
  readonly currentBaseRevision: ReviewRevision
  readonly currentHeadRevision: ReviewRevision
  readonly currentAnchor: ReviewThreadAnchor | null
  readonly anchorStatus: ReviewAnchorStatusType
}

/** Final state for one pending agent message owned by a persisted run. */
export interface CompleteReviewThreadAgentMessageInput {
  readonly messageId: ReviewThreadMessageId
  readonly threadId: ReviewThreadId
  readonly bodyMarkdown: MarkdownBody
  readonly status: "complete" | "failed"
}

const ReviewThreadRow = Schema.Struct({
  id: ReviewThreadId,
  repo_id: Schema.String,
  review_key: ReviewKey,
  pr_number: Schema.NullOr(Schema.Number),
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  current_base_sha: ReviewRevision,
  current_head_sha: ReviewRevision,
  original_anchor_json: Schema.String,
  current_anchor_json: Schema.NullOr(Schema.String),
  anchor_status: ReviewAnchorStatus,
  created_at: Schema.String,
  updated_at: Schema.String,
})

const ReviewThreadMessageRow = Schema.Struct({
  id: ReviewThreadMessageId,
  thread_id: ReviewThreadId,
  sequence: Schema.Number,
  author: ReviewThreadMessageAuthor,
  body_markdown: MarkdownBody,
  status: ReviewThreadMessageStatus,
  agent_run_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

interface NextSequenceRow {
  readonly next_sequence: number
}

/** A typed failure from local review thread persistence operations. */
export class ReviewThreadStoreError extends Schema.TaggedError<ReviewThreadStoreError>()(
  "ReviewThreadStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Domain-oriented persistence for local review threads and Markdown messages. */
export class ReviewThreadStore extends Context.Tag("@diffdash/ReviewThreadStore")<
  ReviewThreadStore,
  {
    readonly create: (
      input: CreateReviewThreadInput,
    ) => Effect.Effect<ReviewThreadDetails, ReviewThreadStoreError>
    readonly get: (
      threadId: ReviewThreadId,
    ) => Effect.Effect<ReviewThreadDetails, ReviewThreadStoreError>
    readonly listForReview: (
      key: ReviewThreadListKey,
    ) => Effect.Effect<readonly ReviewThread[], ReviewThreadStoreError>
    readonly listForRevision: (
      key: ReviewThreadRevisionKey,
    ) => Effect.Effect<readonly ReviewThread[], ReviewThreadStoreError>
    readonly updateCurrentMappings: (
      mappings: readonly ReviewThreadCurrentMapping[],
    ) => Effect.Effect<readonly ReviewThread[], ReviewThreadStoreError>
    readonly createPendingAgentMessage: (
      input: CreatePendingReviewThreadAgentMessageInput,
    ) => Effect.Effect<ReviewThreadMessage, ReviewThreadStoreError>
    readonly addUserMessage: (
      input: AddReviewThreadUserMessageRequest,
    ) => Effect.Effect<ReviewThreadDetails, ReviewThreadStoreError>
    readonly completeAgentMessage: (
      input: CompleteReviewThreadAgentMessageInput,
    ) => Effect.Effect<ReviewThreadMessage, ReviewThreadStoreError>
  }
>() {
  static readonly layer = Layer.effect(
    ReviewThreadStore,
    Effect.gen(function* () {
      const database = yield* DatabaseService

      const get = Effect.fn("ReviewThreadStore.get")(function (threadId: ReviewThreadId) {
        return database
          .transaction("reviewThreads.get", (transaction) => getDetails(transaction, threadId))
          .pipe(mapStoreError("get"))
      })

      return ReviewThreadStore.of({
        create: Effect.fn("ReviewThreadStore.create")(function (input) {
          return database
            .transaction("reviewThreads.create", (transaction) => {
              const threadId = ReviewThreadId.make(randomUUID())
              const messageId = ReviewThreadMessageId.make(randomUUID())
              const now = new Date().toISOString()
              const anchorJson = encodeAnchor(input.anchor)
              transaction.run(
                `INSERT INTO review_threads (
                  id, repo_id, review_key, pr_number, base_sha, head_sha,
                  current_base_sha, current_head_sha, original_anchor_json,
                  current_anchor_json, anchor_status, status, closed_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'open', NULL, ?, ?)`,
                [
                  threadId,
                  input.repoId,
                  input.reviewKey,
                  input.prNumber,
                  input.baseRevision,
                  input.headRevision,
                  input.baseRevision,
                  input.headRevision,
                  anchorJson,
                  anchorJson,
                  now,
                  now,
                ],
              )
              transaction.run(
                `INSERT INTO review_thread_messages (
                  id, thread_id, sequence, author, body_markdown, status,
                  agent_run_id, created_at, updated_at
                ) VALUES (?, ?, 1, 'user', ?, 'complete', NULL, ?, ?)`,
                [messageId, threadId, input.bodyMarkdown, now, now],
              )
              return getDetails(transaction, threadId)
            })
            .pipe(mapStoreError("create"))
        }),
        get,
        listForReview: Effect.fn("ReviewThreadStore.listForReview")(function (key) {
          return database
            .all(
              `SELECT * FROM review_threads
               WHERE repo_id = ? AND review_key = ?
               ORDER BY updated_at DESC, id ASC`,
              [key.repoId, key.reviewKey],
            )
            .pipe(
              Effect.mapError((cause) =>
                ReviewThreadStoreError.make({ operation: "listForReview.query", cause }),
              ),
              Effect.flatMap((rows) => decodeThreadRows("listForReview.decode", rows)),
            )
        }),
        listForRevision: Effect.fn("ReviewThreadStore.listForRevision")(function (key) {
          return database
            .all(
              `SELECT * FROM review_threads
               WHERE repo_id = ? AND review_key = ? AND current_head_sha = ?
               ORDER BY updated_at DESC, id ASC`,
              [key.repoId, key.reviewKey, key.headRevision],
            )
            .pipe(
              Effect.mapError((cause) =>
                ReviewThreadStoreError.make({ operation: "listForRevision.query", cause }),
              ),
              Effect.flatMap((rows) => decodeThreadRows("listForRevision.decode", rows)),
            )
        }),
        updateCurrentMappings: Effect.fn("ReviewThreadStore.updateCurrentMappings")(
          function (mappings) {
            return database
              .transaction("reviewThreads.updateCurrentMappings", (transaction) => {
                const now = new Date().toISOString()
                return mappings.map((mapping) => {
                  getThread(transaction, mapping.threadId)
                  const anchorJson =
                    mapping.currentAnchor === null ? null : encodeAnchor(mapping.currentAnchor)
                  transaction.run(
                    `UPDATE review_threads
                   SET current_base_sha = ?, current_head_sha = ?, current_anchor_json = ?,
                       anchor_status = ?, updated_at = ?
                   WHERE id = ? AND NOT (
                     current_base_sha IS ? AND current_head_sha IS ? AND
                     current_anchor_json IS ? AND anchor_status IS ?
                   )`,
                    [
                      mapping.currentBaseRevision,
                      mapping.currentHeadRevision,
                      anchorJson,
                      mapping.anchorStatus,
                      now,
                      mapping.threadId,
                      mapping.currentBaseRevision,
                      mapping.currentHeadRevision,
                      anchorJson,
                      mapping.anchorStatus,
                    ],
                  )
                  return getThread(transaction, mapping.threadId)
                })
              })
              .pipe(mapStoreError("updateCurrentMappings"))
          },
        ),
        createPendingAgentMessage: Effect.fn("ReviewThreadStore.createPendingAgentMessage")(
          function (input) {
            return database
              .transaction("reviewThreads.createPendingAgentMessage", (transaction) => {
                getThread(transaction, input.threadId)
                const sequence = nextMessageSequence(transaction, input.threadId)
                const id = ReviewThreadMessageId.make(randomUUID())
                const now = new Date().toISOString()
                transaction.run(
                  `INSERT INTO review_thread_messages (
                  id, thread_id, sequence, author, body_markdown, status,
                  agent_run_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    id,
                    input.threadId,
                    sequence,
                    "agent",
                    MarkdownBody.make(""),
                    "pending",
                    input.agentRunId,
                    now,
                    now,
                  ],
                )
                transaction.run("UPDATE review_threads SET updated_at = ? WHERE id = ?", [
                  now,
                  input.threadId,
                ])
                return getMessage(transaction, id)
              })
              .pipe(mapStoreError("createPendingAgentMessage"))
          },
        ),
        addUserMessage: Effect.fn("ReviewThreadStore.addUserMessage")(function (input) {
          return database
            .transaction("reviewThreads.addUserMessage", (transaction) => {
              getThread(transaction, input.threadId)
              const latest = latestMessage(transaction, input.threadId)
              if (latest === undefined || latest.author === "user" || latest.status === "pending") {
                throw new Error(
                  "Wait for the current agent response before sending another message",
                )
              }
              const id = ReviewThreadMessageId.make(randomUUID())
              const now = new Date().toISOString()
              transaction.run(
                `INSERT INTO review_thread_messages (
                  id, thread_id, sequence, author, body_markdown, status,
                  agent_run_id, created_at, updated_at
                ) VALUES (?, ?, ?, 'user', ?, 'complete', NULL, ?, ?)`,
                [
                  id,
                  input.threadId,
                  nextMessageSequence(transaction, input.threadId),
                  input.bodyMarkdown,
                  now,
                  now,
                ],
              )
              transaction.run("UPDATE review_threads SET updated_at = ? WHERE id = ?", [
                now,
                input.threadId,
              ])
              return getDetails(transaction, input.threadId)
            })
            .pipe(mapStoreError("addUserMessage"))
        }),
        completeAgentMessage: Effect.fn("ReviewThreadStore.completeAgentMessage")(function (input) {
          return database
            .transaction("reviewThreads.completeAgentMessage", (transaction) => {
              const current = getMessage(transaction, input.messageId)
              if (current.threadId !== input.threadId || current.author !== "agent") {
                throw new Error("Agent message does not belong to the requested thread")
              }
              if (current.status !== "pending") {
                throw new Error(`Agent message is already ${current.status}`)
              }
              const now = new Date().toISOString()
              transaction.run(
                `UPDATE review_thread_messages
                 SET body_markdown = ?, status = ?, updated_at = ?
                 WHERE id = ? AND thread_id = ?`,
                [input.bodyMarkdown, input.status, now, input.messageId, input.threadId],
              )
              transaction.run("UPDATE review_threads SET updated_at = ? WHERE id = ?", [
                now,
                input.threadId,
              ])
              return getMessage(transaction, input.messageId)
            })
            .pipe(mapStoreError("completeAgentMessage"))
        }),
      })
    }),
  )
}

const getDetails = (transaction: DatabaseTransaction, threadId: ReviewThreadId) =>
  ReviewThreadDetails.make({
    thread: getThread(transaction, threadId),
    messages: transaction
      .all("SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY sequence ASC", [
        threadId,
      ])
      .map(decodeMessageRow),
  })

const getThread = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const row = transaction.get("SELECT * FROM review_threads WHERE id = ?", [threadId])
  if (row === undefined) throw new Error(`Review thread not found: ${threadId}`)
  return decodeThreadRow(row)
}

const getMessage = (transaction: DatabaseTransaction, messageId: ReviewThreadMessageId) => {
  const row = transaction.get("SELECT * FROM review_thread_messages WHERE id = ?", [messageId])
  if (row === undefined) throw new Error(`Review thread message not found: ${messageId}`)
  return decodeMessageRow(row)
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
    originalAnchor: decodeAnchor(row.original_anchor_json),
    currentAnchor: row.current_anchor_json === null ? null : decodeAnchor(row.current_anchor_json),
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

const decodeThreadRows = (operation: string, rows: readonly unknown[]) =>
  Effect.try({
    try: () => rows.map(decodeThreadRow),
    catch: (cause) => ReviewThreadStoreError.make({ operation, cause }),
  })

const nextMessageSequence = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const row = transaction.get<NextSequenceRow>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM review_thread_messages WHERE thread_id = ?`,
    [threadId],
  )
  if (row === undefined) throw new Error("Unable to allocate message sequence")
  return row.next_sequence
}

const latestMessage = (transaction: DatabaseTransaction, threadId: ReviewThreadId) => {
  const row = transaction.get(
    "SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY sequence DESC LIMIT 1",
    [threadId],
  )
  return row === undefined ? undefined : decodeMessageRow(row)
}

const ReviewThreadAnchorJson = Schema.parseJson(ReviewThreadAnchorSchema)
const encodeAnchor = Schema.encodeSync(ReviewThreadAnchorJson)
const decodeAnchor = Schema.decodeUnknownSync(ReviewThreadAnchorJson)

const mapStoreError = (operation: string) =>
  Effect.mapError((cause: unknown) => ReviewThreadStoreError.make({ operation, cause }))
