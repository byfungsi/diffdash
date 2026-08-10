import { Schema } from "effect"

/** Open identity owned by an agent provider package. */
export const AgentProviderId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AgentProviderId"),
)

/** Open identity owned by an agent provider package. */
export type AgentProviderId = typeof AgentProviderId.Type

/** Provider-owned model identity. */
export const AgentModelId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AgentModelId"),
)

/** Provider-owned model identity. */
export type AgentModelId = typeof AgentModelId.Type

/** Identity of an MCP tool exposed for one run. */
export const McpToolName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("McpToolName"),
)

/** Identity of an MCP tool exposed for one run. */
export type McpToolName = typeof McpToolName.Type
