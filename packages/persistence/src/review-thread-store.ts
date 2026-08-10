import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"

import {
  type AddReviewThreadUserMessageInput,
  type CreateReviewThreadInput,
  type CurrentReviewAnchor,
  PendingAgentReviewThreadMessage,
  ReviewThreadAnchor as ReviewThreadAnchorSchema,
  type ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessageId,
  type ReviewThreadListKey,
  type ReviewThreadRevisionKey,
  UserReviewThreadMessage,
} from "@diffdash/domain/review-thread"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { type Database, type DatabaseRow, makeDatabase, toError } from "./database"
import {
  decodeReviewThreadRow,
  encodeCurrentReviewAnchorRow,
  makeReviewThreadFromRow,
  ReviewThreadRow,
} from "./review-thread-row"
import {
  decodeAgentRunRow,
  decodeReviewThreadMessageRow,
  projectReviewConversation,
} from "./review-turn-row"

/** One thread's complete current-revision mapping, persisted as a single logical update. */
export interface ReviewThreadCurrentMapping {
  readonly threadId: ReviewThreadId
  readonly currentBaseRevision: ReviewRevision
  readonly currentHeadRevision: ReviewRevision
  readonly currentAnchor: CurrentReviewAnchor
}

const ReviewThreadAnchorJson = Schema.fromJsonString(ReviewThreadAnchorSchema)
const ReviewThreadRows = Schema.Array(ReviewThreadRow)

const NextSequenceRow = Schema.Struct({
  next_sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
})

const ReviewThreadStoreOperation = Schema.Literals([
  "create",
  "get",
  "listForReview.query",
  "listForReview.decode",
  "listForRevision.query",
  "listForRevision.decode",
  "updateCurrentMappings",
  "addUserMessage",
])
type ReviewThreadStoreOperation = typeof ReviewThreadStoreOperation.Type

/** A typed failure from local review thread persistence operations. */
export class ReviewThreadStoreError extends Schema.TaggedError<ReviewThreadStoreError>()(
  "ReviewThreadStoreError",
  {
    operation: ReviewThreadStoreOperation,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Domain-oriented persistence for local review threads and Markdown messages. */
export class ReviewThreadStore extends Context.Service<
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
    readonly addUserMessage: (
      input: AddReviewThreadUserMessageInput,
    ) => Effect.Effect<ReviewThreadDetails, ReviewThreadStoreError>
  }
>()("@diffdash/ReviewThreadStore") {
  static readonly layer = Layer.effect(
    ReviewThreadStore,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)

      const get = Effect.fn("ReviewThreadStore.get")(function (threadId: ReviewThreadId) {
        return database.transaction(getDetails(database, threadId)).pipe(mapStoreError("get"))
      })

      return ReviewThreadStore.of({
        create: Effect.fn("ReviewThreadStore.create")(function (input) {
          return database
            .transaction(
              Effect.gen(function* () {
                const threadId = ReviewThreadId.make(randomUUID())
                const messageId = ReviewThreadMessageId.make(randomUUID())
                const now = new Date().toISOString()
                const anchorJson = yield* encodeAnchor(input.anchor)
                yield* database.run(
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
                yield* database.run(
                  `INSERT INTO review_thread_messages (
                    id, thread_id, sequence, author, body_markdown, status,
                    agent_run_id, created_at, updated_at
                  ) VALUES (?, ?, 1, 'user', ?, 'complete', NULL, ?, ?)`,
                  [messageId, threadId, input.bodyMarkdown, now, now],
                )
                return yield* getDetails(database, threadId)
              }),
            )
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
              .transaction(
                Effect.gen(function* () {
                  const now = new Date().toISOString()
                  return yield* Effect.forEach(mappings, (mapping) =>
                    Effect.gen(function* () {
                      yield* getThread(database, mapping.threadId)
                      const storedMapping = encodeCurrentReviewAnchorRow(mapping.currentAnchor)
                      const anchorJson =
                        storedMapping.currentAnchor === null
                          ? null
                          : yield* encodeAnchor(storedMapping.currentAnchor)
                      yield* database.run(
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
                          storedMapping.anchorStatus,
                          now,
                          mapping.threadId,
                          mapping.currentBaseRevision,
                          mapping.currentHeadRevision,
                          anchorJson,
                          storedMapping.anchorStatus,
                        ],
                      )
                      return yield* getThread(database, mapping.threadId)
                    }),
                  )
                }),
              )
              .pipe(mapStoreError("updateCurrentMappings"))
          },
        ),
        addUserMessage: Effect.fn("ReviewThreadStore.addUserMessage")(function (input) {
          return database
            .transaction(
              Effect.gen(function* () {
                yield* getThread(database, input.threadId)
                const latest = yield* latestMessage(database, input.threadId)
                if (
                  Option.isNone(latest) ||
                  Schema.is(UserReviewThreadMessage)(latest.value) ||
                  Schema.is(PendingAgentReviewThreadMessage)(latest.value)
                ) {
                  return yield* new Cause.IllegalArgumentError(
                    "Wait for the current agent response before sending another message",
                  )
                }
                const id = ReviewThreadMessageId.make(randomUUID())
                const now = new Date().toISOString()
                const sequence = yield* nextMessageSequence(database, input.threadId)
                yield* database.run(
                  `INSERT INTO review_thread_messages (
                    id, thread_id, sequence, author, body_markdown, status,
                    agent_run_id, created_at, updated_at
                  ) VALUES (?, ?, ?, 'user', ?, 'complete', NULL, ?, ?)`,
                  [id, input.threadId, sequence, input.bodyMarkdown, now, now],
                )
                yield* database.run("UPDATE review_threads SET updated_at = ? WHERE id = ?", [
                  now,
                  input.threadId,
                ])
                return yield* getDetails(database, input.threadId)
              }),
            )
            .pipe(mapStoreError("addUserMessage"))
        }),
      })
    }),
  )
}

const getDetails = Effect.fn("ReviewThreadStore.getDetails")(function* (
  database: Database,
  threadId: ReviewThreadId,
) {
  const thread = yield* getThread(database, threadId)
  const messageRows = yield* database.all(
    "SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY sequence ASC",
    [threadId],
  )
  const runRows = yield* database.all(
    "SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC, id ASC",
    [threadId],
  )
  const messages = yield* Effect.forEach(messageRows, decodeReviewThreadMessageRow)
  const runs = yield* Effect.forEach(runRows, decodeAgentRunRow)
  return ReviewThreadDetails.make({
    thread,
    conversation: yield* projectReviewConversation(messages, runs),
  })
})

const getThread = Effect.fn("ReviewThreadStore.getThread")(function* (
  database: Database,
  threadId: ReviewThreadId,
) {
  const row = yield* database.get("SELECT * FROM review_threads WHERE id = ?", [threadId])
  return yield* Effect.fromOption(
    row,
    () => new Cause.NoSuchElementError(`Review thread not found: ${threadId}`),
  ).pipe(Effect.flatMap(decodeThreadRow))
})

const decodeThreadRow = decodeReviewThreadRow

const decodeThreadRows = (operation: ReviewThreadStoreOperation, rows: readonly DatabaseRow[]) =>
  Schema.decodeUnknownEffect(ReviewThreadRows)(rows).pipe(
    Effect.flatMap((decoded) => Effect.forEach(decoded, makeReviewThreadFromRow)),
    Effect.mapError((cause) => ReviewThreadStoreError.make({ operation, cause: toError(cause) })),
  )

const nextMessageSequence = Effect.fn("ReviewThreadStore.nextMessageSequence")(function* (
  database: Database,
  threadId: ReviewThreadId,
) {
  const input = yield* database.get(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM review_thread_messages WHERE thread_id = ?`,
    [threadId],
  )
  return yield* Effect.fromOption(
    input,
    () => new Cause.NoSuchElementError("Unable to allocate message sequence"),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NextSequenceRow)),
    Effect.map((row) => row.next_sequence),
  )
})

const latestMessage = Effect.fn("ReviewThreadStore.latestMessage")(function* (
  database: Database,
  threadId: ReviewThreadId,
) {
  const row = yield* database.get(
    "SELECT * FROM review_thread_messages WHERE thread_id = ? ORDER BY sequence DESC LIMIT 1",
    [threadId],
  )
  return yield* Option.map(row, decodeReviewThreadMessageRow).pipe(Effect.transposeOption)
})

const encodeAnchor = Schema.encodeEffect(ReviewThreadAnchorJson)

const mapStoreError = (operation: ReviewThreadStoreOperation) =>
  Effect.mapError((cause) => ReviewThreadStoreError.make({ operation, cause: toError(cause) }))
