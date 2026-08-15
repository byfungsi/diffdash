import { Schema } from "effect"
import {
  CoreExpectedCause,
  type CoreExpectedCause as CoreExpectedCauseType,
} from "./core-error-cause"

const CoreStartupOperation = Schema.Literals([
  "acquireRuntime",
  "createTemporaryDirectory",
  "recoverInterruptedReviewTurns",
  "inspectActiveWalkthroughOperations",
  "reconcileWalkthroughArtifact",
  "completeRecoveredWalkthroughOperation",
  "recoverInterruptedWalkthroughOperations",
])

/** A recoverable failure while decoding host-owned Core configuration. */
export class CoreConfigurationError extends Schema.TaggedError<CoreConfigurationError>()(
  "CoreConfigurationError",
  {
    message: Schema.String,
    cause: CoreExpectedCause,
  },
) {}

/** A recoverable failure while acquiring Core-owned runtime resources. */
export class CoreStartupError extends Schema.TaggedError<CoreStartupError>()("CoreStartupError", {
  operation: CoreStartupOperation,
  message: Schema.String,
  cause: CoreExpectedCause,
}) {}

/** Complete expected failure union while acquiring the embedded Core runtime. */
export type CoreStartupFailure = CoreConfigurationError | CoreStartupError

/** Normalizes dependency-owned acquisition failures at the Core boundary. */
export const toCoreStartupError = (cause: CoreExpectedCauseType): CoreStartupError =>
  Schema.is(CoreStartupError)(cause)
    ? cause
    : CoreStartupError.make({
        operation: "acquireRuntime",
        message: "DiffDash Core could not acquire its runtime resources.",
        cause,
      })
