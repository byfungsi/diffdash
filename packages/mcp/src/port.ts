import { Effect, Redacted, Schema } from "effect"
import type { DiffDashMcpToolRequest, DiffDashMcpToolResponse } from "@diffdash/protocol/mcp"

/** A Core-owned review-context tool failed before producing a transport result. */
export class DiffDashMcpToolError extends Schema.TaggedError<DiffDashMcpToolError>()(
  "DiffDashMcpToolError",
  { operation: Schema.String, reason: Schema.String },
) {}

/** Core-owned implementations of every tool exposed by the MCP adapter. */
export interface DiffDashMcpToolHandlers {
  readonly execute: (
    request: DiffDashMcpToolRequest,
  ) => Effect.Effect<DiffDashMcpToolResponse, DiffDashMcpToolError>
}

/** Immutable, non-domain metadata and Core-owned handlers for one MCP capability. */
export interface DiffDashMcpRunContext {
  readonly runId: string
  readonly threadId: string
  readonly repoId: string
  readonly localPath: string | null
  readonly handlers: DiffDashMcpToolHandlers
  readonly maxToolOutputBytes?: number
}

/** Connection details passed to the selected provider for one scoped capability. */
export interface DiffDashMcpRunAccess {
  readonly url: string
  readonly bearerToken: Redacted.Redacted<string>
}

/** Optional lifecycle probes and gates used by deterministic server-boundary tests. */
export interface DiffDashMcpServerLifecycleHooks {
  readonly onHttpRequest?: Effect.Effect<void>
  readonly onCapabilityRevoking?: () => void
  readonly beforeMcpConnect?: Effect.Effect<void>
  readonly beforeMcpClose?: (resource: "transport" | "server") => Effect.Effect<void>
  readonly onCleanupError?: (operation: string) => void
}

/** Finite lifecycle limits for the loopback MCP server. */
export interface DiffDashMcpServerLayerOptions {
  readonly capabilityGraceMs?: number
  readonly requestFinalizerMs?: number
  readonly mcpCloseMs?: number
  readonly httpCloseMs?: number
  readonly httpForceCloseMs?: number
  readonly hooks?: DiffDashMcpServerLifecycleHooks
}

/** A typed failure from the local DiffDash MCP adapter. */
export class DiffDashMcpServerError extends Schema.TaggedError<DiffDashMcpServerError>()(
  "DiffDashMcpServerError",
  {
    operation: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}
