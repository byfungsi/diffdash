import { Schema } from "effect"

import { NonNegativeInteger, PositiveInteger, UtcIsoTimestamp } from "./domain-scalar"
import {
  ReviewAgentArtifact,
  ReviewAgentArtifactId,
  ReviewAgentProviderRunId,
  ReviewAgentUsage,
} from "./review-agent-run-data"
import { AgentRunId } from "./agent-run-id"
import { ReviewAgentProviderId } from "./review-agent-provider-id"
import { ReviewKey, ReviewRevision } from "./review-identity"
import { ReviewThreadId } from "./review-thread-id"

/** Version identifier for the stable prompt contract used by an agent run. */
export const AgentPromptVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AgentPromptVersion"),
)

/** Version identifier for the stable prompt contract used by an agent run. */
export type AgentPromptVersion = typeof AgentPromptVersion.Type

const AgentRunIdentity = {
  id: AgentRunId,
  threadId: ReviewThreadId,
  reviewKey: ReviewKey,
  baseRevision: ReviewRevision,
  headRevision: ReviewRevision,
  provider: ReviewAgentProviderId,
  model: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  promptVersion: AgentPromptVersion,
  startedAt: UtcIsoTimestamp,
}

/** A provider execution that still owns an active pending response. */
export class RunningAgentRun extends Schema.TaggedClass<RunningAgentRun>()("Running", {
  ...AgentRunIdentity,
}) {}

/** A successfully completed provider execution. */
export class CompletedAgentRun extends Schema.TaggedClass<CompletedAgentRun>()("Completed", {
  ...AgentRunIdentity,
  providerRunId: Schema.optional(ReviewAgentProviderRunId),
  usage: Schema.optional(ReviewAgentUsage),
  completedAt: UtcIsoTimestamp,
}) {}

/** A failed provider execution with a durable diagnostic. */
export class FailedAgentRun extends Schema.TaggedClass<FailedAgentRun>()("Failed", {
  ...AgentRunIdentity,
  providerRunId: Schema.optional(ReviewAgentProviderRunId),
  error: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  completedAt: UtcIsoTimestamp,
}) {}

/** A provider execution stopped by an explicit user cancellation. */
export class CancelledAgentRun extends Schema.TaggedClass<CancelledAgentRun>()("Cancelled", {
  ...AgentRunIdentity,
  completedAt: UtcIsoTimestamp,
}) {}

/** A provider execution abandoned when its owning Core process stopped. */
export class InterruptedAgentRun extends Schema.TaggedClass<InterruptedAgentRun>()("Interrupted", {
  ...AgentRunIdentity,
  completedAt: UtcIsoTimestamp,
}) {}

/** Persisted lifecycle record for one provider execution in a review thread. */
export const AgentRun = Schema.Union([
  RunningAgentRun,
  CompletedAgentRun,
  FailedAgentRun,
  CancelledAgentRun,
  InterruptedAgentRun,
])

/** Persisted lifecycle record for one provider execution in a review thread. */
export type AgentRun = typeof AgentRun.Type

/** Returns whether a persisted run has reached a durable terminal state. */
export const isTerminalAgentRun = (run: AgentRun): run is Exclude<AgentRun, RunningAgentRun> =>
  !Schema.is(RunningAgentRun)(run)

/** A normalized artifact together with its persistent run and thread ownership. */
export class StoredAgentRunArtifact extends Schema.Class<StoredAgentRunArtifact>(
  "StoredAgentRunArtifact",
)({
  id: ReviewAgentArtifactId,
  runId: AgentRunId,
  threadId: ReviewThreadId,
  artifact: ReviewAgentArtifact,
  createdAt: UtcIsoTimestamp,
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
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ThreadMemorySummaryAlgorithm"),
)

/** Stable identifier for the algorithm that produced a compact thread summary. */
export type ThreadMemorySummaryAlgorithm = typeof ThreadMemorySummaryAlgorithm.Type

const ThreadMemoryWatermark = NonNegativeInteger
const ThreadMemorySummaryVersion = PositiveInteger

/** Compact context retained independently from provider session memory. */
export class ThreadMemory extends Schema.Class<ThreadMemory>("ThreadMemory")({
  threadId: ReviewThreadId,
  summary: Schema.String,
  summarizedThroughSequence: ThreadMemoryWatermark,
  summaryAlgorithm: ThreadMemorySummaryAlgorithm,
  summaryVersion: ThreadMemorySummaryVersion,
  importantArtifactIds: Schema.Array(ReviewAgentArtifactId),
  updatedAt: UtcIsoTimestamp,
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
