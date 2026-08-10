import {
  AgentPromptVersion,
  CompletedAgentRun,
  FailedAgentRun,
  RunningAgentRun,
} from "@diffdash/domain/agent-run"
import { AgentRunId, ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import {
  CompletedAgentReviewThreadMessage,
  CompletedAgentReviewTurn,
  FailedAgentReviewThreadMessage,
  FailedAgentReviewTurn,
  InternalReviewThreadMessageFailure,
  MarkdownBody,
  PendingAgentReviewThreadMessage,
  PendingAgentReviewTurn,
  type ReviewThread,
  ReviewThreadMessageId,
  type ReviewTurn,
  UserReviewThreadMessage,
  UserReviewTurn,
} from "@diffdash/domain/review-thread"

interface DemoReviewMessageInput {
  readonly id: string
  readonly sequence: number
  readonly bodyMarkdown: string
  readonly author: "user" | "agent"
  readonly status: "pending" | "complete" | "failed"
  readonly agentRunId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Builds one internally coherent demo conversation turn from the authored lifecycle state. */
export const makeDemoReviewTurn = (
  thread: ReviewThread,
  input: DemoReviewMessageInput,
): ReviewTurn => {
  const validationError = validateDemoReviewMessage(input)
  if (validationError !== null) throw new Error(validationError)
  const message = {
    id: ReviewThreadMessageId.make(input.id),
    threadId: thread.id,
    sequence: input.sequence,
    bodyMarkdown: MarkdownBody.make(input.bodyMarkdown),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
  if (input.author === "user") {
    return UserReviewTurn.make({ message: UserReviewThreadMessage.make(message) })
  }
  if (input.agentRunId === null) throw new Error(`Agent message ${input.id} has no run.`)
  const runId = AgentRunId.make(input.agentRunId)
  const runIdentity = {
    id: runId,
    threadId: thread.id,
    reviewKey: thread.reviewKey,
    baseRevision: thread.baseRevision,
    headRevision: thread.headRevision,
    provider: ReviewAgentProviderId.make("demo"),
    model: "demo-model",
    promptVersion: AgentPromptVersion.make("demo-v1"),
    startedAt: input.createdAt,
  }
  switch (input.status) {
    case "pending":
      return PendingAgentReviewTurn.make({
        message: PendingAgentReviewThreadMessage.make({ ...message, agentRunId: runId }),
        run: RunningAgentRun.make(runIdentity),
      })
    case "complete":
      return CompletedAgentReviewTurn.make({
        message: CompletedAgentReviewThreadMessage.make({ ...message, agentRunId: runId }),
        run: CompletedAgentRun.make({ ...runIdentity, completedAt: input.updatedAt }),
      })
    case "failed":
      return FailedAgentReviewTurn.make({
        message: FailedAgentReviewThreadMessage.make({
          ...message,
          agentRunId: runId,
          failure: InternalReviewThreadMessageFailure.make({}),
        }),
        run: FailedAgentRun.make({
          ...runIdentity,
          error: input.bodyMarkdown,
          completedAt: input.updatedAt,
        }),
      })
  }
  throw new Error(`Unsupported demo message status: ${input.status}`)
}

/** Validates that authored message fields describe exactly one domain lifecycle state. */
export const validateDemoReviewMessage = (input: DemoReviewMessageInput): string | null => {
  if (input.author === "user") {
    return input.status === "complete" && input.agentRunId === null
      ? null
      : `User message ${input.id} must be complete and must not reference an agent run.`
  }
  if (input.agentRunId === null) return `Agent message ${input.id} must reference an agent run.`
  if (input.status === "pending" && input.bodyMarkdown.length > 0) {
    return `Pending agent message ${input.id} must not contain completed response text.`
  }
  if (input.status === "failed" && input.bodyMarkdown.length === 0) {
    return `Failed agent message ${input.id} must contain a diagnostic.`
  }
  return null
}
