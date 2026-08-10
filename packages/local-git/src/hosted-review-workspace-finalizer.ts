import { Cause, Effect, Exit } from "effect"

/** Completes an operation after its finalizer, retaining both Causes when both fail. */
export const completeWithFinalizer = <A, E, R, E2, R2>(
  effect: Effect.Effect<A, E, R>,
  finalizer: Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.gen(function* () {
    const effectExit = yield* Effect.exit(effect)
    const finalizerExit = yield* Effect.exit(finalizer)
    if (Exit.isFailure(effectExit)) {
      return yield* Effect.failCause(
        Exit.isFailure(finalizerExit)
          ? Cause.combine(effectExit.cause, finalizerExit.cause)
          : effectExit.cause,
      )
    }
    if (Exit.isFailure(finalizerExit)) return yield* Effect.failCause(finalizerExit.cause)
    return effectExit.value
  })
