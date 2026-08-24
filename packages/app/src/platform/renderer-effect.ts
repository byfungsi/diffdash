import { Cause, Effect, Exit, Option } from "effect"

/** Runs one closed renderer Effect while rejecting with its original expected failure. */
export const runRendererPromise = async <A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal })
  return Exit.match(exit, {
    onSuccess: (value) => Promise.resolve(value),
    onFailure: (cause) =>
      Promise.reject(
        Option.getOrElse(Cause.findErrorOption(cause), () =>
          Option.match(
            Option.filter(Option.fromNullishOr(signal), (active) => active.aborted),
            {
              onNone: () => Cause.squash(cause),
              onSome: () => new DOMException("Renderer operation aborted", "AbortError"),
            },
          ),
        ),
      ),
  })
}
