import { Cause, Effect, Exit, Option } from "effect"

/** Runs one closed renderer Effect while rejecting with its original expected failure. */
export const runRendererPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) throw failure.value
  throw Cause.squash(exit.cause)
}
