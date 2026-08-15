import {
  type ApplicationInstanceId,
  type CoreProcessEpoch,
  type DatabaseOwnershipAuthorizationId,
} from "@diffdash/core-rpc/identity"
import { Context, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  acquireDatabaseOwnership,
  type DatabaseOwnerInspector,
  type DatabaseOwnershipError,
} from "@diffdash/persistence/database-ownership"

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

/** Inputs for the production sidecar ownership and startup-recovery implementation. */
export interface CoreOwnershipRecoveryOptions {
  readonly databasePath: string
  readonly pid: number
  readonly processStartIdentity: string
  readonly inspector: DatabaseOwnerInspector
  readonly recover: Effect.Effect<void, CoreOwnershipRecoveryError>
}

/** Acquires exact database ownership, runs recovery, and retains the lease until scope release. */
export const makeCoreOwnershipRecovery = (
  options: CoreOwnershipRecoveryOptions,
): CoreOwnershipRecoveryOperations => ({
  acquireAndRecover: Effect.fn("CoreOwnershipRecovery.acquireAndRecover")(
    function* (authorization) {
      const lease = yield* acquireDatabaseOwnership({
        databasePath: options.databasePath,
        owner: {
          applicationInstance: authorization.applicationInstanceId,
          processEpoch: authorization.processEpoch,
          pid: options.pid,
          processStartIdentity: options.processStartIdentity,
          nonce: createHash("sha256").update(authorization.authorizationId).digest("base64url"),
        },
        inspector: options.inspector,
      }).pipe(Effect.mapError(() => ownershipFailure("ownership")))
      yield* options.recover.pipe(
        Effect.onError(() => lease.release().pipe(Effect.ignore)),
        Effect.mapError(() => ownershipFailure("recovery")),
      )
      return {
        release: lease.release().pipe(
          Effect.mapError(mapReleaseFailure),
          Effect.catch(() => Effect.void),
        ),
      }
    },
  ),
})

const ownershipFailure = (stage: "ownership" | "recovery") =>
  CoreOwnershipRecoveryError.make({
    stage,
    safeMessage: "DiffDash Core could not acquire and recover its owned resources.",
  })

const mapReleaseFailure = (_error: DatabaseOwnershipError) => ownershipFailure("ownership")
