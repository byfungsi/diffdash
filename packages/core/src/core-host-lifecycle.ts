import { Cause, Effect } from "effect"

import { CoreAuthenticatedHostSession } from "./core-transport-authentication"
import { CoreLifecycle, type CoreLifecycleIdentity } from "./core-lifecycle"
import { CoreOwnershipRecovery } from "./core-ownership-recovery"

/** Owns initialization resources only after authorization and releases them on host death or drain. */
export const runCoreHostLifecycle = Effect.fn("CoreHostLifecycle.run")(function* <E, R>(
  identity: CoreLifecycleIdentity,
  initialize: Effect.Effect<void, E, R>,
) {
  const lifecycle = yield* CoreLifecycle
  const hostSession = yield* CoreAuthenticatedHostSession
  const ownershipRecovery = yield* CoreOwnershipRecovery

  const ownedRecovery = lifecycle.ownershipAuthorization.pipe(
    Effect.flatMap((authorizationId) =>
      Effect.acquireRelease(
        ownershipRecovery.acquireAndRecover({ ...identity, authorizationId }),
        (lease) => lease.release,
      ),
    ),
    Effect.andThen(initialize),
    Effect.andThen(lifecycle.completeRecovery),
    Effect.andThen(Effect.never),
    Effect.tapError(() => lifecycle.fail),
  )
  const ownAndRecover = Effect.scoped(lifecycle.interruptOnDrain(ownedRecovery)).pipe(
    Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void),
  )
  const hostDied = hostSession.awaitDeath.pipe(Effect.andThen(lifecycle.authenticatedHostDied))

  yield* Effect.raceFirst(hostDied, ownAndRecover)
  yield* lifecycle.completeShutdown
})
