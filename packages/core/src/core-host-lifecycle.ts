import { Cause, Effect } from "effect"

import { CoreAuthenticatedHostSession } from "./core-transport-authentication"
import { CoreLifecycle, type CoreLifecycleIdentity } from "./core-lifecycle"
import { CoreOwnershipRecovery } from "./core-ownership-recovery"

/** Runs ownership/recovery only after authorization and exits after authenticated host death. */
export const runCoreHostLifecycle = Effect.fn("CoreHostLifecycle.run")(function* (
  identity: CoreLifecycleIdentity,
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
