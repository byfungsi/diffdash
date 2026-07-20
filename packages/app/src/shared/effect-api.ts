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

/** Lifts and decodes one context-bridged preload response into an Effect atom operation. */
export function fetchSchemaEffect<A, I>(
  schema: Schema.Schema<A, I, never>,
  tryPromise: () => Promise<unknown>,
) {
  return fetchEffect(async () => Schema.decodeUnknownSync(schema)(await tryPromise()))
}
