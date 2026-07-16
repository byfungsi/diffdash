import { Effect, Schema } from "effect"

import { formatError } from "./errors"

class RendererApiError extends Schema.TaggedError<RendererApiError>()("RendererApiError", {
  error: Schema.Defect,
  message: Schema.String,
}) {}

/** Lifts one typed preload promise into an Effect atom operation. */
export function fetchEffect<A>(tryPromise: () => Promise<A>) {
  return Effect.tryPromise({
    try: tryPromise,
    catch: (error) =>
      RendererApiError.make({
        error,
        message: formatError(error, "Unknown renderer API error"),
      }),
  })
}
