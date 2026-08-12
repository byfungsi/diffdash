import {
  type AuthorizeDatabaseOwnershipRequest,
  CoreHealth,
  CoreLifecycleState,
  CoreShutdownAcknowledged,
  DatabaseOwnershipAuthorized,
} from "@diffdash/core-rpc/lifecycle"
import {
  CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure,
  CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure,
  CoreHealthIdentityMismatchFailure,
  CoreOwnershipAuthorizationMismatchFailure,
  CoreShutdownIdentityMismatchFailure,
  CoreShutdownLifecycleRejectedFailure,
} from "@diffdash/core-rpc/failure"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import type {
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
} from "@diffdash/core-rpc/identity"
import { Context, Data, Deferred, Effect, Layer, Match, Ref, Result, Schema } from "effect"

type State = Data.TaggedEnum<{
  Starting: {}
  AwaitingOwnership: {}
  Recovering: { readonly authorizationId: DatabaseOwnershipAuthorizationId }
  Ready: { readonly authorizationId: DatabaseOwnershipAuthorizationId }
  Draining: {}
  Stopped: {}
  Failed: {}
}>

const State = Data.taggedEnum<State>()

const lifecycleOf = (state: State): CoreLifecycleState =>
  Match.value(state).pipe(
    Match.tag("Starting", () => "starting" as const),
    Match.tag("AwaitingOwnership", () => "awaitingOwnership" as const),
    Match.tag("Recovering", () => "recovering" as const),
    Match.tag("Ready", () => "ready" as const),
    Match.tag("Draining", () => "draining" as const),
    Match.tag("Stopped", () => "stopped" as const),
    Match.tag("Failed", () => "failed" as const),
    Match.exhaustive,
  )

/** Internal failure raised when Core implementation code requests an invalid lifecycle transition. */
export class CoreLifecycleTransitionError extends Schema.TaggedError<CoreLifecycleTransitionError>()(
  "CoreLifecycleTransitionError",
  {
    from: CoreLifecycleState,
    to: CoreLifecycleState,
    message: Schema.String,
  },
) {}

/** Internal rejection raised when business work targets another Core process identity. */
export class CoreBusinessIdentityMismatchError extends Schema.TaggedError<CoreBusinessIdentityMismatchError>()(
  "CoreBusinessIdentityMismatchError",
  {
    applicationInstanceId: ApplicationInstanceId,
    processEpoch: CoreProcessEpoch,
    requestId: HostRequestId,
  },
) {}

/** Internal rejection raised when Core cannot currently admit business work. */
export class CoreBusinessLifecycleRejectedError extends Schema.TaggedError<CoreBusinessLifecycleRejectedError>()(
  "CoreBusinessLifecycleRejectedError",
  {
    requestId: HostRequestId,
    lifecycle: CoreLifecycleState,
  },
) {}

/** Fixed identity of the Core process controlled by one lifecycle service. */
export interface CoreLifecycleIdentity {
  /** Application process that launched this Core. */
  readonly applicationInstanceId: ApplicationInstanceId

  /** Exact Core process lifetime governed by this service. */
  readonly processEpoch: CoreProcessEpoch
}

/** Final bootstrap state machine used by Core control RPC handlers and startup orchestration. */
export interface CoreLifecycleOperations {
  /** Admits business work only for the current process identity while Core is ready. */
  readonly admitBusinessRequest: (
    request: HostRequestContext,
  ) => Effect.Effect<void, CoreBusinessIdentityMismatchError | CoreBusinessLifecycleRejectedError>

  /** Reads health after rejecting requests for another application or process epoch. */
  readonly health: (
    request: HostRequestContext,
  ) => Effect.Effect<CoreHealth, CoreHealthIdentityMismatchFailure>

  /** Records persisted ownership authorization and atomically enters recovery. */
  readonly authorizeDatabaseOwnership: (
    request: AuthorizeDatabaseOwnershipRequest,
  ) => Effect.Effect<
    DatabaseOwnershipAuthorized,
    | CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure
    | CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure
    | CoreOwnershipAuthorizationMismatchFailure
  >

  /** Stops new admission and atomically begins graceful draining. */
  readonly shutdown: (
    request: HostRequestContext,
  ) => Effect.Effect<
    CoreShutdownAcknowledged,
    CoreShutdownIdentityMismatchFailure | CoreShutdownLifecycleRejectedFailure
  >

  /** Runs ownership or recovery work until completion or graceful draining interrupts it. */
  readonly interruptOnDrain: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

  /** Marks authenticated transport ready to receive ownership authorization. */
  readonly awaitOwnershipAuthorization: Effect.Effect<void, CoreLifecycleTransitionError>

  /** Marks ownership acquisition and startup recovery complete. */
  readonly completeRecovery: Effect.Effect<void, CoreLifecycleTransitionError>

  /** Marks all draining and resource finalization complete. */
  readonly completeShutdown: Effect.Effect<void, CoreLifecycleTransitionError>

  /** Records an unrecoverable startup or runtime failure before shutdown begins. */
  readonly fail: Effect.Effect<void, CoreLifecycleTransitionError>
}

/** Authority over one Core process epoch's bootstrap, readiness, and shutdown transitions. */
export class CoreLifecycle extends Context.Service<CoreLifecycle, CoreLifecycleOperations>()(
  "@diffdash/core/CoreLifecycle",
) {}

const transitionError = (state: State, to: CoreLifecycleState) =>
  CoreLifecycleTransitionError.make({
    from: lifecycleOf(state),
    to,
    message: `DiffDash Core cannot transition from ${lifecycleOf(state)} to ${to}.`,
  })

/** Constructs the final Core lifecycle service for one fixed application and process identity. */
export const makeCoreLifecycle = (
  identity: CoreLifecycleIdentity,
): Effect.Effect<CoreLifecycleOperations> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<State>(State.Starting())
    const drainRequested = yield* Deferred.make<void>()

    const healthIdentityMismatch = (requestId: HostRequestId) =>
      CoreHealthIdentityMismatchFailure.make({
        code: "CORE_REQUEST_IDENTITY_MISMATCH",
        method: "Core.health",
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId,
        retryClass: "automatic",
        safeMessage: "DiffDash Core rejected a request for a different process identity.",
      })

    const authorizationIdentityMismatch = (requestId: HostRequestId) =>
      CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure.make({
        code: "CORE_REQUEST_IDENTITY_MISMATCH",
        method: "Core.authorizeDatabaseOwnership",
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId,
        retryClass: "automatic",
        safeMessage: "DiffDash Core rejected a request for a different process identity.",
      })

    const shutdownIdentityMismatch = (requestId: HostRequestId) =>
      CoreShutdownIdentityMismatchFailure.make({
        code: "CORE_REQUEST_IDENTITY_MISMATCH",
        method: "Core.shutdown",
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId,
        retryClass: "automatic",
        safeMessage: "DiffDash Core rejected a request for a different process identity.",
      })

    const matchesIdentity = (request: HostRequestContext): boolean =>
      request.applicationInstanceId === identity.applicationInstanceId &&
      request.processEpoch === identity.processEpoch

    const authorizationLifecycleRejected = (requestId: HostRequestId, state: State) =>
      CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure.make({
        code: "CORE_LIFECYCLE_REJECTED",
        method: "Core.authorizeDatabaseOwnership",
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId,
        lifecycle: lifecycleOf(state),
        retryClass: "notRetryable",
        safeMessage: "DiffDash Core rejected a request in its current lifecycle state.",
      })

    const shutdownLifecycleRejected = (requestId: HostRequestId, state: State) =>
      CoreShutdownLifecycleRejectedFailure.make({
        code: "CORE_LIFECYCLE_REJECTED",
        method: "Core.shutdown",
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId,
        lifecycle: lifecycleOf(state),
        retryClass: "notRetryable",
        safeMessage: "DiffDash Core rejected a request in its current lifecycle state.",
      })

    const ownershipMismatch = (requestId: HostRequestId, state: State) =>
      CoreOwnershipAuthorizationMismatchFailure.make({
        code: "CORE_OWNERSHIP_AUTHORIZATION_MISMATCH",
        method: "Core.authorizeDatabaseOwnership",
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        requestId,
        lifecycle: lifecycleOf(state),
        retryClass: "notRetryable",
        safeMessage: "DiffDash Core rejected conflicting database ownership authorization.",
      })

    const health = Effect.fn("CoreLifecycle.health")(function* (request: HostRequestContext) {
      if (!matchesIdentity(request)) {
        return yield* Effect.fail(healthIdentityMismatch(request.requestId))
      }
      const state = yield* Ref.get(stateRef)
      return CoreHealth.make({
        applicationInstanceId: identity.applicationInstanceId,
        processEpoch: identity.processEpoch,
        lifecycle: lifecycleOf(state),
      })
    })

    const admitBusinessRequest = Effect.fn("CoreLifecycle.admitBusinessRequest")(function* (
      request: HostRequestContext,
    ) {
      if (!matchesIdentity(request)) {
        return yield* CoreBusinessIdentityMismatchError.make({
          applicationInstanceId: identity.applicationInstanceId,
          processEpoch: identity.processEpoch,
          requestId: request.requestId,
        })
      }
      const state = yield* Ref.get(stateRef)
      if (!State.$is("Ready")(state)) {
        return yield* CoreBusinessLifecycleRejectedError.make({
          requestId: request.requestId,
          lifecycle: lifecycleOf(state),
        })
      }
      return undefined
    })

    const authorizeDatabaseOwnership = Effect.fn("CoreLifecycle.authorizeDatabaseOwnership")(
      function* (request: AuthorizeDatabaseOwnershipRequest) {
        if (!matchesIdentity(request)) {
          return yield* Effect.fail(authorizationIdentityMismatch(request.requestId))
        }
        const decision = yield* Ref.modify(
          stateRef,
          (
            state,
          ): readonly [
            Result.Result<
              DatabaseOwnershipAuthorized,
              | CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure
              | CoreOwnershipAuthorizationMismatchFailure
            >,
            State,
          ] =>
            Match.value(state).pipe(
              Match.tag("AwaitingOwnership", () => {
                const next = State.Recovering({
                  authorizationId: request.authorizationId,
                })
                return [
                  Result.succeed(
                    DatabaseOwnershipAuthorized.make({
                      applicationInstanceId: identity.applicationInstanceId,
                      processEpoch: identity.processEpoch,
                      authorizationId: request.authorizationId,
                      lifecycle: "recovering",
                    }),
                  ),
                  next,
                ] as const
              }),
              Match.tag("Recovering", (current) =>
                current.authorizationId === request.authorizationId
                  ? ([
                      Result.succeed(
                        DatabaseOwnershipAuthorized.make({
                          applicationInstanceId: identity.applicationInstanceId,
                          processEpoch: identity.processEpoch,
                          authorizationId: current.authorizationId,
                          lifecycle: "recovering",
                        }),
                      ),
                      current,
                    ] as const)
                  : ([
                      Result.fail(ownershipMismatch(request.requestId, current)),
                      current,
                    ] as const),
              ),
              Match.tag("Ready", (current) =>
                current.authorizationId === request.authorizationId
                  ? ([
                      Result.succeed(
                        DatabaseOwnershipAuthorized.make({
                          applicationInstanceId: identity.applicationInstanceId,
                          processEpoch: identity.processEpoch,
                          authorizationId: current.authorizationId,
                          lifecycle: "ready",
                        }),
                      ),
                      current,
                    ] as const)
                  : ([
                      Result.fail(ownershipMismatch(request.requestId, current)),
                      current,
                    ] as const),
              ),
              Match.orElse(
                (current) =>
                  [
                    Result.fail(authorizationLifecycleRejected(request.requestId, current)),
                    current,
                  ] as const,
              ),
            ),
        )
        return yield* Effect.fromResult(decision)
      },
    )

    const shutdown = Effect.fn("CoreLifecycle.shutdown")(function* (request: HostRequestContext) {
      if (!matchesIdentity(request)) {
        return yield* Effect.fail(shutdownIdentityMismatch(request.requestId))
      }
      const decision = yield* Ref.modify(
        stateRef,
        (
          state,
        ): readonly [
          Result.Result<CoreShutdownAcknowledged, CoreShutdownLifecycleRejectedFailure>,
          State,
        ] =>
          Match.value(state).pipe(
            Match.tag(
              "Starting",
              (current) =>
                [
                  Result.fail(shutdownLifecycleRejected(request.requestId, current)),
                  current,
                ] as const,
            ),
            Match.tag(
              "Stopped",
              (current) =>
                [
                  Result.succeed(
                    CoreShutdownAcknowledged.make({
                      applicationInstanceId: identity.applicationInstanceId,
                      processEpoch: identity.processEpoch,
                      lifecycle: "stopped",
                    }),
                  ),
                  current,
                ] as const,
            ),
            Match.orElse(() => {
              const next = State.Draining()
              return [
                Result.succeed(
                  CoreShutdownAcknowledged.make({
                    applicationInstanceId: identity.applicationInstanceId,
                    processEpoch: identity.processEpoch,
                    lifecycle: "draining",
                  }),
                ),
                next,
              ] as const
            }),
          ),
      )
      const acknowledged = yield* Effect.fromResult(decision)
      if (acknowledged.lifecycle === "draining") {
        yield* Deferred.succeed(drainRequested, undefined)
      }
      return acknowledged
    }, Effect.uninterruptible)

    const interruptOnDrain = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.raceFirst(
        effect,
        Deferred.await(drainRequested).pipe(Effect.andThen(Effect.interrupt)),
      )

    const transition = (
      to: CoreLifecycleState,
      update: (state: State) => State | undefined,
    ): Effect.Effect<void, CoreLifecycleTransitionError> =>
      Ref.modify(
        stateRef,
        (state): readonly [Result.Result<void, CoreLifecycleTransitionError>, State] => {
          const next = update(state)
          return next === undefined
            ? [Result.fail(transitionError(state, to)), state]
            : [Result.succeed(undefined), next]
        },
      ).pipe(Effect.flatMap(Effect.fromResult))

    const awaitOwnershipAuthorization = transition("awaitingOwnership", (state) =>
      Match.value(state).pipe(
        Match.tag("Starting", () => State.AwaitingOwnership()),
        Match.tag("AwaitingOwnership", (current) => current),
        Match.orElse(() => undefined),
      ),
    )

    const completeRecovery = transition("ready", (state) =>
      Match.value(state).pipe(
        Match.tag("Recovering", (current) =>
          State.Ready({
            authorizationId: current.authorizationId,
          }),
        ),
        Match.tag("Ready", (current) => current),
        Match.orElse(() => undefined),
      ),
    )

    const completeShutdown = transition("stopped", (state) =>
      Match.value(state).pipe(
        Match.tag("Draining", () => State.Stopped()),
        Match.tag("Stopped", (current) => current),
        Match.orElse(() => undefined),
      ),
    )

    const markFailed = transition("failed", (state) =>
      Match.value(state).pipe(
        Match.tag("Starting", () => State.Failed()),
        Match.tag("AwaitingOwnership", () => State.Failed()),
        Match.tag("Recovering", () => State.Failed()),
        Match.tag("Ready", () => State.Failed()),
        Match.tag("Failed", (current) => current),
        Match.orElse(() => undefined),
      ),
    )

    return CoreLifecycle.of({
      admitBusinessRequest,
      health,
      authorizeDatabaseOwnership,
      shutdown,
      interruptOnDrain,
      awaitOwnershipAuthorization,
      completeRecovery,
      completeShutdown,
      fail: markFailed,
    })
  })

/** Provides one isolated Core lifecycle state machine for the supplied process identity. */
export const coreLifecycleLayer = (identity: CoreLifecycleIdentity) =>
  Layer.effect(CoreLifecycle, makeCoreLifecycle(identity))
