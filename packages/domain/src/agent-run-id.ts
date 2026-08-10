import { Schema } from "effect"

/** Persistent identity for one review agent execution. */
export const AgentRunId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AgentRunId"),
)

/** Persistent identity for one review agent execution. */
export type AgentRunId = typeof AgentRunId.Type
