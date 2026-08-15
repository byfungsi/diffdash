import {
  type ApplicationInstanceId,
  type CoreProcessEpoch,
  type DatabaseOwnershipAuthorizationId,
} from "@diffdash/core-rpc/identity"
import { Context, Effect, Schema } from "effect"

/** Exact persisted authorization evidence supplied to Core ownership recovery. */
export interface CoreOwnershipRecoveryAuthorization {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
  readonly authorizationId: DatabaseOwnershipAuthorizationId
}

/** Sanitized failure from ownership acquisition or startup recovery. */
export class CoreOwnershipRecoveryError extends Schema.TaggedError<CoreOwnershipRecoveryError>()(
  "CoreOwnershipRecoveryError",
  {
    stage: Schema.Literals(["ownership", "recovery", "not-configured"]),
    safeMessage: Schema.Literal("DiffDash Core could not acquire and recover its owned resources."),
  },
) {}

/** Core-owned boundary that acquires persisted ownership and completes startup recovery. */
export interface CoreOwnershipLease {
  /** Releases every resource acquired for this Core ownership epoch. */
  readonly release: Effect.Effect<void>
}

/** Core-owned boundary that acquires persisted ownership and completes startup recovery. */
export interface CoreOwnershipRecoveryOperations {
  readonly acquireAndRecover: (
    authorization: CoreOwnershipRecoveryAuthorization,
  ) => Effect.Effect<CoreOwnershipLease, CoreOwnershipRecoveryError>
}

/** Production integration seam for scoped database ownership and startup recovery. */
export class CoreOwnershipRecovery extends Context.Service<
  CoreOwnershipRecovery,
  CoreOwnershipRecoveryOperations
>()("@diffdash/core/CoreOwnershipRecovery") {}

/** Fail-closed placeholder used until product SQLite ownership is composed into standalone Core. */
export const coreOwnershipRecoveryNotConfigured = CoreOwnershipRecovery.of({
  acquireAndRecover: Effect.fn("CoreOwnershipRecovery.notConfigured")(function* () {
    return yield* CoreOwnershipRecoveryError.make({
      stage: "not-configured",
      safeMessage: "DiffDash Core could not acquire and recover its owned resources.",
    })
  }),
})
