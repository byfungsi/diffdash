import { Schema } from "effect"
import type { DuplicateAgentProviderError } from "@diffdash/agent-provider"
import type { DuplicateGitProviderError, GitProviderOperationError } from "@diffdash/git-provider"
import type { HostedReviewWorkspacePoolError } from "@diffdash/local-git/hosted-review-workspace-pool"
import type { DatabaseError } from "@diffdash/persistence/database"
import type { DiffDashMcpServerError } from "@diffdash/review-agent/mcp-server"

/** A recoverable failure while decoding host-owned Core configuration. */
export class CoreConfigurationError extends Schema.TaggedError<CoreConfigurationError>()(
  "CoreConfigurationError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** A recoverable failure while acquiring Core-owned runtime resources. */
export class CoreStartupError extends Schema.TaggedError<CoreStartupError>()("CoreStartupError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

/** Complete expected failure union while acquiring the embedded Core runtime. */
export type CoreStartupFailure =
  | CoreConfigurationError
  | CoreStartupError
  | DatabaseError
  | DiffDashMcpServerError
  | DuplicateAgentProviderError
  | DuplicateGitProviderError
  | GitProviderOperationError
  | HostedReviewWorkspacePoolError
