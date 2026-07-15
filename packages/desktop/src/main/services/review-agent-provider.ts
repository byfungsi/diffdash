import { Context, type Effect, Schema } from "effect"

import type {
  ReviewAgentProviderId,
  ReviewAgentProviderRunId,
  ReviewAgentTurnInput,
  ReviewAgentTurnResult,
} from "@diffdash/domain/review-agent"
import { CliStreamError } from "@diffdash/process/cli-stream"
import type { DiffDashMcpRunAccess } from "./diffdash-mcp-server"

/** Ephemeral execution resources owned by one orchestrated provider turn. */
export interface ReviewAgentExecutionContext {
  readonly mcp: DiffDashMcpRunAccess
  readonly providerRunId: ReviewAgentProviderRunId | null
}

/** The selected review provider is unavailable or cannot enforce thread-mode permissions. */
export class ReviewAgentUnavailableError extends Schema.TaggedError<ReviewAgentUnavailableError>()(
  "ReviewAgentUnavailableError",
  {
    provider: Schema.String,
    reason: Schema.String,
  },
) {}

/** A selected provider failed while executing one review thread turn. */
export class ReviewAgentExecutionError extends Schema.TaggedError<ReviewAgentExecutionError>()(
  "ReviewAgentExecutionError",
  {
    provider: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** A provider emitted malformed protocol events that could not be normalized safely. */
export class ReviewAgentProtocolError extends Schema.TaggedError<ReviewAgentProtocolError>()(
  "ReviewAgentProtocolError",
  {
    provider: Schema.String,
    reason: Schema.String,
  },
) {}

/** A provider returned a final answer that failed the DiffDash response schema. */
export class ReviewAgentInvalidResponseError extends Schema.TaggedError<ReviewAgentInvalidResponseError>()(
  "ReviewAgentInvalidResponseError",
  {
    provider: Schema.String,
    reason: Schema.String,
  },
) {}

/** A provider could not enforce the required read-only thread-mode policy. */
export class ReviewAgentPermissionError extends Schema.TaggedError<ReviewAgentPermissionError>()(
  "ReviewAgentPermissionError",
  {
    provider: Schema.String,
    reason: Schema.String,
  },
) {}

/** Recoverable provider-neutral failures from a review thread turn. */
export type ReviewAgentProviderError =
  | ReviewAgentUnavailableError
  | ReviewAgentExecutionError
  | ReviewAgentProtocolError
  | ReviewAgentInvalidResponseError
  | ReviewAgentPermissionError

/** One provider implementation for read-only local AI review thread turns. */
export class ReviewAgentProvider extends Context.Tag("@diffdash/ReviewAgentProvider")<
  ReviewAgentProvider,
  {
    readonly id: ReviewAgentProviderId
    readonly isAvailable: Effect.Effect<boolean, ReviewAgentProviderError>
    readonly runThreadTurn: (
      input: ReviewAgentTurnInput,
      execution: ReviewAgentExecutionContext,
    ) => Effect.Effect<ReviewAgentTurnResult, ReviewAgentProviderError>
  }
>() {}

/** Maps an unknown provider boundary failure into a bounded provider-neutral execution error. */
export const mapReviewAgentExecutionError = (provider: ReviewAgentProviderId, cause: unknown) =>
  ReviewAgentExecutionError.make({
    provider,
    reason: executionFailureReason(cause),
    cause,
  })

/** Returns a bounded, token-redacted provider diagnostic suitable for local thread status. */
export const executionFailureReason = (cause: unknown) => {
  if (
    cause instanceof ReviewAgentExecutionError ||
    cause instanceof ReviewAgentProtocolError ||
    cause instanceof ReviewAgentInvalidResponseError ||
    cause instanceof ReviewAgentPermissionError ||
    cause instanceof ReviewAgentUnavailableError
  ) {
    return cause.reason
  }
  const message = cause instanceof Error ? cause.message : "Review agent execution failed"
  if (!(cause instanceof CliStreamError) || cause.stderr.trim().length === 0) return message
  const diagnostic = redactDiagnostic(cause.stderr).trim()
  return diagnostic.length === 0 ? message : `${message}: ${diagnostic}`
}

const redactDiagnostic = (value: string) =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]")
    .replace(/DIFFDASH_MCP_BEARER_TOKEN=[^\s]+/giu, "DIFFDASH_MCP_BEARER_TOKEN=[redacted]")
    .replace(/\s+/gu, " ")
    .slice(-600)
