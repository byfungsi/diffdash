import { Schema } from "effect"

/** Recoverable failures preparing, leasing, or restoring an isolated review workspace. */
export class HostedReviewWorkspacePoolError extends Schema.TaggedError<HostedReviewWorkspacePoolError>()(
  "HostedReviewWorkspacePoolError",
  {
    code: Schema.Literals([
      "link-required",
      "capacity",
      "filesystem",
      "lock",
      "manifest",
      "git",
      "revision-not-found",
      "revision-ambiguous",
      "no-common-ancestor",
      "revision-changed",
      "cleanup",
    ]),
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Constructs a typed workspace-pool failure around an unknown infrastructure cause. */
export const poolError = (
  code: HostedReviewWorkspacePoolError["code"],
  operation: string,
  reason: string,
  cause: Schema.ErrorInstance["Type"],
) => HostedReviewWorkspacePoolError.make({ code, operation, reason, cause })

/** Keeps infrastructure failures as Error instances at the typed error boundary. */
export const toError = <A>(cause: A): Error =>
  Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause))

/** Narrows Node failures by their platform error code. */
export const isNodeError = (
  cause: Schema.ErrorInstance["Type"],
  code: string,
): cause is NodeJS.ErrnoException =>
  Schema.is(Schema.Struct({ code: Schema.String }))(cause) && cause.code === code
