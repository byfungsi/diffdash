import { Schema } from "effect"

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
export type CoreStartupFailure = CoreConfigurationError | CoreStartupError

/** Normalizes dependency-owned acquisition failures at the Core boundary. */
export const toCoreStartupError = (cause: unknown): CoreStartupError =>
  cause instanceof CoreStartupError
    ? cause
    : CoreStartupError.make({
        operation: "acquireRuntime",
        message: "DiffDash Core could not acquire its runtime resources.",
        cause,
      })
