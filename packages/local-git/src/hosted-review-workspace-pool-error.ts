import { Schema } from "effect"

/** Recoverable failures preparing, leasing, or restoring an isolated review workspace. */
export class HostedReviewWorkspacePoolError extends Schema.TaggedError<HostedReviewWorkspacePoolError>()(
  "HostedReviewWorkspacePoolError",
  {
    code: Schema.Literal(
      "link-required",
      "capacity",
      "filesystem",
      "lock",
      "manifest",
      "git",
      "revision-changed",
      "cleanup",
    ),
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Constructs a typed workspace-pool failure around an unknown infrastructure cause. */
export const poolError = (
  code: HostedReviewWorkspacePoolError["code"],
  operation: string,
  reason: string,
  cause: unknown,
) => HostedReviewWorkspacePoolError.make({ code, operation, reason, cause })

/** Narrows Node failures by their platform error code. */
export const isNodeError = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
