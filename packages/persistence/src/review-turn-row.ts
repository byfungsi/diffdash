import {
  AgentPromptVersion,
  type AgentRun,
  CompletedAgentRun,
  FailedAgentRun,
  RunningAgentRun,
} from "@diffdash/domain/agent-run"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import {
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "@diffdash/domain/review-agent"
import { ReviewKey, ReviewRevision } from "@diffdash/domain/review-identity"
import {
  CompletedAgentReviewThreadMessage,
  CompletedAgentReviewTurn,
  FailedAgentReviewThreadMessage,
  FailedAgentReviewTurn,
  InternalReviewThreadMessageFailure,
  MarkdownBody,
  PendingAgentReviewThreadMessage,
  PendingAgentReviewTurn,
  ProviderReviewThreadMessageFailure,
  type ReviewThreadMessage,
  ReviewThreadMessageId,
  type ReviewTurn,
  UserReviewThreadMessage,
  UserReviewTurn,
} from "@diffdash/domain/review-thread"
import { ReviewThreadId } from "@diffdash/domain/review-thread"
import { Effect, Match, Schema } from "effect"
import type { DatabaseRow } from "./database"

const AgentProviderFailureJson = Schema.NullOr(Schema.fromJsonString(AgentProviderFailure))
const ReviewAgentUsageJson = Schema.NullOr(Schema.fromJsonString(ReviewAgentUsage))

/** Existing SQLite message representation retained behind the lifecycle decoder. */
export const ReviewThreadMessageRow = Schema.Struct({
  id: ReviewThreadMessageId,
  thread_id: ReviewThreadId,
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  author: Schema.Literals(["user", "agent"]),
  body_markdown: MarkdownBody,
  status: Schema.Literals(["pending", "complete", "failed"]),
  agent_run_id: Schema.NullOr(AgentRunId),
  failure_json: AgentProviderFailureJson,
  created_at: Schema.String,
  updated_at: Schema.String,
})

/** Existing SQLite agent-run representation retained behind the lifecycle decoder. */
export const AgentRunRow = Schema.Struct({
  id: AgentRunId,
  thread_id: ReviewThreadId,
  review_key: ReviewKey,
  base_sha: ReviewRevision,
  head_sha: ReviewRevision,
  provider: ReviewAgentProviderId,
  model: Schema.NonEmptyString,
  prompt_version: AgentPromptVersion,
  status: Schema.Literals(["running", "completed", "failed"]),
  provider_run_id: Schema.NullOr(ReviewAgentProviderRunId),
  usage_json: ReviewAgentUsageJson,
  error: Schema.NullOr(Schema.NonEmptyString),
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
})

/** A durable legacy row cannot be represented by the tagged lifecycle contract. */
export class ReviewLifecycleRowDecodeError extends Schema.TaggedError<ReviewLifecycleRowDecodeError>()(
  "ReviewLifecycleRowDecodeError",
  {
    entity: Schema.Literals(["message", "run", "conversation"]),
    id: Schema.String,
    reason: Schema.NonEmptyString,
  },
) {}

/** One durable agent run was linked to more than one conversation response. */
export class ReviewConversationAgentRunReuseError extends Schema.TaggedError<ReviewConversationAgentRunReuseError>()(
  "ReviewConversationAgentRunReuseError",
  {
    agentRunId: AgentRunId,
    firstMessageId: ReviewThreadMessageId,
    reusedByMessageId: ReviewThreadMessageId,
    reason: Schema.NonEmptyString,
  },
) {}

/** Decodes one flat compatibility message row into its legal authored lifecycle variant. */
export const decodeReviewThreadMessageRow = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(ReviewThreadMessageRow)(input).pipe(
    Effect.flatMap((row): Effect.Effect<ReviewThreadMessage, ReviewLifecycleRowDecodeError> => {
      const identity = {
        id: row.id,
        threadId: row.thread_id,
        sequence: row.sequence,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
      if (row.author === "user") {
        if (row.status !== "complete" || row.agent_run_id !== null || row.failure_json !== null) {
          return invalid(
            "message",
            row.id,
            "User messages must be complete and cannot own runs or failures.",
          )
        }
        return Effect.succeed(
          UserReviewThreadMessage.make({ ...identity, bodyMarkdown: row.body_markdown }),
        )
      }
      if (row.agent_run_id === null) {
        return invalid("message", row.id, "Agent responses must own an agent run.")
      }
      if (row.status === "pending") {
        if (row.failure_json !== null) {
          return invalid("message", row.id, "Pending agent responses cannot contain a failure.")
        }
        return Effect.succeed(
          PendingAgentReviewThreadMessage.make({ ...identity, agentRunId: row.agent_run_id }),
        )
      }
      if (row.status === "complete") {
        if (row.failure_json !== null) {
          return invalid("message", row.id, "Completed agent responses cannot contain a failure.")
        }
        return Effect.succeed(
          CompletedAgentReviewThreadMessage.make({
            ...identity,
            agentRunId: row.agent_run_id,
            bodyMarkdown: row.body_markdown,
          }),
        )
      }
      return Effect.succeed(
        FailedAgentReviewThreadMessage.make({
          ...identity,
          agentRunId: row.agent_run_id,
          failure:
            row.failure_json === null
              ? InternalReviewThreadMessageFailure.make({})
              : ProviderReviewThreadMessageFailure.make({ details: row.failure_json }),
        }),
      )
    }),
  )

/** Decodes one flat compatibility run row into its legal lifecycle variant. */
export const decodeAgentRunRow = (input: DatabaseRow) =>
  Schema.decodeUnknownEffect(AgentRunRow)(input).pipe(
    Effect.flatMap((row): Effect.Effect<AgentRun, ReviewLifecycleRowDecodeError> => {
      const identity = {
        id: row.id,
        threadId: row.thread_id,
        reviewKey: row.review_key,
        baseRevision: row.base_sha,
        headRevision: row.head_sha,
        provider: row.provider,
        model: row.model,
        promptVersion: row.prompt_version,
        startedAt: row.started_at,
      }
      if (row.status === "running") {
        if (
          row.provider_run_id !== null ||
          row.usage_json !== null ||
          row.error !== null ||
          row.completed_at !== null
        ) {
          return invalid("run", row.id, "Running agent runs cannot contain completion fields.")
        }
        return Effect.succeed(RunningAgentRun.make(identity))
      }
      if (row.completed_at === null) {
        return invalid("run", row.id, "Finished agent runs require a completion timestamp.")
      }
      if (row.status === "completed") {
        if (row.error !== null) {
          return invalid("run", row.id, "Completed agent runs cannot contain an error.")
        }
        const completed: {
          providerRunId?: ReviewAgentProviderRunId
          usage?: ReviewAgentUsage
          completedAt: string
        } & typeof identity = { ...identity, completedAt: row.completed_at }
        if (row.provider_run_id !== null) completed.providerRunId = row.provider_run_id
        if (row.usage_json !== null) completed.usage = row.usage_json
        return Effect.succeed(CompletedAgentRun.make(completed))
      }
      if (row.error === null || row.usage_json !== null) {
        return invalid(
          "run",
          row.id,
          "Failed agent runs require an error and cannot contain usage.",
        )
      }
      const failed: {
        providerRunId?: ReviewAgentProviderRunId
        error: string
        completedAt: string
      } & typeof identity = { ...identity, error: row.error, completedAt: row.completed_at }
      if (row.provider_run_id !== null) failed.providerRunId = row.provider_run_id
      return Effect.succeed(FailedAgentRun.make(failed))
    }),
  )

/** Joins ordered messages and runs into the only conversation projection exposed to callers. */
export const projectReviewConversation = (
  messages: readonly ReviewThreadMessage[],
  runs: readonly AgentRun[],
): Effect.Effect<
  readonly ReviewTurn[],
  ReviewLifecycleRowDecodeError | ReviewConversationAgentRunReuseError
> => {
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const projectedRunMessages = new Map<AgentRunId, ReviewThreadMessageId>()
  return Effect.forEach(
    messages,
    (
      message,
    ): Effect.Effect<
      ReviewTurn,
      ReviewLifecycleRowDecodeError | ReviewConversationAgentRunReuseError
    > => {
      if (Schema.is(UserReviewThreadMessage)(message)) {
        return Effect.succeed(UserReviewTurn.make({ message }))
      }
      const run = runsById.get(message.agentRunId)
      if (run === undefined || run.threadId !== message.threadId) {
        return invalid(
          "conversation",
          message.id,
          "Agent response and run lifecycle states must match and share ownership.",
        )
      }
      const firstMessageId = projectedRunMessages.get(run.id)
      if (firstMessageId !== undefined) {
        return Effect.fail(
          ReviewConversationAgentRunReuseError.make({
            agentRunId: run.id,
            firstMessageId,
            reusedByMessageId: message.id,
            reason: "Agent runs may belong to exactly one conversation response.",
          }),
        )
      }
      projectedRunMessages.set(run.id, message.id)
      return Match.value(message).pipe(
        Match.tag("Pending", (pending) =>
          Schema.is(RunningAgentRun)(run)
            ? Effect.succeed(PendingAgentReviewTurn.make({ message: pending, run }))
            : invalid(
                "conversation",
                pending.id,
                "Pending agent response must own a running agent run.",
              ),
        ),
        Match.tag("Completed", (completed) =>
          Schema.is(CompletedAgentRun)(run)
            ? Effect.succeed(CompletedAgentReviewTurn.make({ message: completed, run }))
            : invalid(
                "conversation",
                completed.id,
                "Completed agent response must own a completed agent run.",
              ),
        ),
        Match.tag("Failed", (failed) =>
          Schema.is(FailedAgentRun)(run)
            ? Effect.succeed(FailedAgentReviewTurn.make({ message: failed, run }))
            : invalid(
                "conversation",
                failed.id,
                "Failed agent response must own a failed agent run.",
              ),
        ),
        Match.exhaustive,
      )
    },
  ).pipe(
    Effect.flatMap((conversation) => {
      const orphan = runs.find((run) => !projectedRunMessages.has(run.id))
      return orphan === undefined
        ? Effect.succeed(conversation)
        : invalid("conversation", orphan.id, "Agent run has no linked conversation response.")
    }),
  )
}

const invalid = (entity: ReviewLifecycleRowDecodeError["entity"], id: string, reason: string) =>
  Effect.fail(ReviewLifecycleRowDecodeError.make({ entity, id, reason }))
