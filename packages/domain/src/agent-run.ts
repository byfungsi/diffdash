import { Schema } from "effect"

import {
  AgentRunId,
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "./review-agent"
import { ReviewThreadId } from "./review-thread"

/** Version identifier for the stable prompt contract used by an agent run. */
export const AgentPromptVersion = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("AgentPromptVersion"),
)

/** Version identifier for the stable prompt contract used by an agent run. */
export type AgentPromptVersion = typeof AgentPromptVersion.Type

/** Lifecycle state for one persisted review-agent run. */
export const AgentRunStatus = Schema.Literal("running", "completed", "failed")

/** Lifecycle state for one persisted review-agent run. */
export type AgentRunStatus = typeof AgentRunStatus.Type

/** Persisted lifecycle record for one provider execution in a review thread. */
export class AgentRun extends Schema.Class<AgentRun>("AgentRun")({
  id: AgentRunId,
  threadId: ReviewThreadId,
  provider: ReviewAgentProviderId,
  model: Schema.String.pipe(Schema.minLength(1)),
  promptVersion: AgentPromptVersion,
  status: AgentRunStatus,
  providerRunId: Schema.NullOr(ReviewAgentProviderRunId),
  usage: Schema.NullOr(ReviewAgentUsage),
  error: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
}) {}

/** Input for recording the start of a provider execution. */
export class StartAgentRunInput extends Schema.Class<StartAgentRunInput>("StartAgentRunInput")({
  threadId: ReviewThreadId,
  provider: ReviewAgentProviderId,
  model: Schema.String.pipe(Schema.minLength(1)),
  promptVersion: AgentPromptVersion,
}) {}

/** Input for attaching a provider-owned run or session ID. */
export class SetAgentProviderRunIdInput extends Schema.Class<SetAgentProviderRunIdInput>(
  "SetAgentProviderRunIdInput",
)({
  runId: AgentRunId,
  providerRunId: ReviewAgentProviderRunId,
}) {}

/** Input for completing a running provider execution. */
export class CompleteAgentRunInput extends Schema.Class<CompleteAgentRunInput>(
  "CompleteAgentRunInput",
)({
  runId: AgentRunId,
  providerRunId: Schema.optional(ReviewAgentProviderRunId),
  usage: Schema.NullOr(ReviewAgentUsage),
}) {}

/** Input for failing a running provider execution with a user-safe error summary. */
export class FailAgentRunInput extends Schema.Class<FailAgentRunInput>("FailAgentRunInput")({
  runId: AgentRunId,
  error: Schema.String.pipe(Schema.minLength(1)),
  providerRunId: Schema.optional(ReviewAgentProviderRunId),
}) {}

/** A normalized artifact together with its persistent run and thread ownership. */
export class StoredAgentRunArtifact extends Schema.Class<StoredAgentRunArtifact>(
  "StoredAgentRunArtifact",
)({
  id: ReviewAgentArtifactId,
  runId: AgentRunId,
  threadId: ReviewThreadId,
  artifact: ReviewAgentArtifact,
  createdAt: Schema.String,
}) {}

/** Input for persisting one already-normalized provider artifact. */
export class SaveAgentRunArtifactInput extends Schema.Class<SaveAgentRunArtifactInput>(
  "SaveAgentRunArtifactInput",
)({
  runId: AgentRunId,
  threadId: ReviewThreadId,
  artifact: ReviewAgentArtifact,
}) {}

/** Stable identifier for the algorithm that produced a compact thread summary. */
export const ThreadMemorySummaryAlgorithm = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ThreadMemorySummaryAlgorithm"),
)

/** Stable identifier for the algorithm that produced a compact thread summary. */
export type ThreadMemorySummaryAlgorithm = typeof ThreadMemorySummaryAlgorithm.Type

const ThreadMemoryWatermark = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0))
const ThreadMemorySummaryVersion = Schema.Int.pipe(Schema.greaterThanOrEqualTo(1))

/** Compact context retained independently from provider session memory. */
export class ThreadMemory extends Schema.Class<ThreadMemory>("ThreadMemory")({
  threadId: ReviewThreadId,
  summary: Schema.String,
  summarizedThroughSequence: ThreadMemoryWatermark,
  summaryAlgorithm: ThreadMemorySummaryAlgorithm,
  summaryVersion: ThreadMemorySummaryVersion,
  importantArtifactIds: Schema.Array(ReviewAgentArtifactId),
  updatedAt: Schema.String,
}) {}

/** Input for replacing the compact memory associated with one review thread. */
export class UpsertThreadMemoryInput extends Schema.Class<UpsertThreadMemoryInput>(
  "UpsertThreadMemoryInput",
)({
  threadId: ReviewThreadId,
  summary: Schema.String,
  summarizedThroughSequence: ThreadMemoryWatermark,
  summaryAlgorithm: ThreadMemorySummaryAlgorithm,
  summaryVersion: ThreadMemorySummaryVersion,
  importantArtifactIds: Schema.Array(ReviewAgentArtifactId),
}) {}
