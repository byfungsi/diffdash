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
import { Context, Data, Deferred, Effect, Layer, Match, Option, Ref, Result, Schema } from "effect"

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
  Match.valueTags(state, {
    Starting: () => "starting" as const,
    AwaitingOwnership: () => "awaitingOwnership" as const,
    Recovering: () => "recovering" as const,
    Ready: () => "ready" as const,
    Draining: () => "draining" as const,
    Stopped: () => "stopped" as const,
    Failed: () => "failed" as const,
  })

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

    const matchesIdentity = (request: HostRequestContext): boolean =>
      request.applicationInstanceId === identity.applicationInstanceId &&
      request.processEpoch === identity.processEpoch

    const admitIdentity = <E>(
      request: HostRequestContext,
      onMismatch: () => E,
    ): Effect.Effect<void, E> =>
      matchesIdentity(request) ? Effect.void : Effect.fail(onMismatch())

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
      yield* admitIdentity(request, () =>
        CoreHealthIdentityMismatchFailure.make({
          code: "CORE_REQUEST_IDENTITY_MISMATCH",
          method: "Core.health",
          applicationInstanceId: identity.applicationInstanceId,
          processEpoch: identity.processEpoch,
          requestId: request.requestId,
          retryClass: "automatic",
          safeMessage: "DiffDash Core rejected a request for a different process identity.",
        }),
      )
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
      yield* admitIdentity(request, () =>
        CoreBusinessIdentityMismatchError.make({
          applicationInstanceId: identity.applicationInstanceId,
          processEpoch: identity.processEpoch,
          requestId: request.requestId,
        }),
      )
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
        yield* admitIdentity(request, () =>
          CoreAuthorizeDatabaseOwnershipIdentityMismatchFailure.make({
            code: "CORE_REQUEST_IDENTITY_MISMATCH",
            method: "Core.authorizeDatabaseOwnership",
            applicationInstanceId: identity.applicationInstanceId,
            processEpoch: identity.processEpoch,
            requestId: request.requestId,
            retryClass: "automatic",
            safeMessage: "DiffDash Core rejected a request for a different process identity.",
          }),
        )
        const authorizationRejected = (state: State) =>
          CoreAuthorizeDatabaseOwnershipLifecycleRejectedFailure.make({
            code: "CORE_LIFECYCLE_REJECTED",
            method: "Core.authorizeDatabaseOwnership",
            applicationInstanceId: identity.applicationInstanceId,
            processEpoch: identity.processEpoch,
            requestId: request.requestId,
            lifecycle: lifecycleOf(state),
            retryClass: "notRetryable",
            safeMessage: "DiffDash Core rejected a request in its current lifecycle state.",
          })
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
            Match.valueTags(state, {
              AwaitingOwnership: () => {
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
              },
              Recovering: (current) =>
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
              Ready: (current) =>
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
              Starting: (current) =>
                [Result.fail(authorizationRejected(current)), current] as const,
              Draining: (current) =>
                [Result.fail(authorizationRejected(current)), current] as const,
              Stopped: (current) => [Result.fail(authorizationRejected(current)), current] as const,
              Failed: (current) => [Result.fail(authorizationRejected(current)), current] as const,
            }),
        )
        return yield* Effect.fromResult(decision)
      },
    )

    const shutdown = Effect.fn("CoreLifecycle.shutdown")(function* (request: HostRequestContext) {
      yield* admitIdentity(request, () =>
        CoreShutdownIdentityMismatchFailure.make({
          code: "CORE_REQUEST_IDENTITY_MISMATCH",
          method: "Core.shutdown",
          applicationInstanceId: identity.applicationInstanceId,
          processEpoch: identity.processEpoch,
          requestId: request.requestId,
          retryClass: "automatic",
          safeMessage: "DiffDash Core rejected a request for a different process identity.",
        }),
      )
      const decision = yield* Ref.modify(
        stateRef,
        (
          state,
        ): readonly [
          Result.Result<CoreShutdownAcknowledged, CoreShutdownLifecycleRejectedFailure>,
          State,
        ] =>
          Match.valueTags(state, {
            Starting: (current) =>
              [
                Result.fail(
                  CoreShutdownLifecycleRejectedFailure.make({
                    code: "CORE_LIFECYCLE_REJECTED",
                    method: "Core.shutdown",
                    applicationInstanceId: identity.applicationInstanceId,
                    processEpoch: identity.processEpoch,
                    requestId: request.requestId,
                    lifecycle: lifecycleOf(current),
                    retryClass: "notRetryable",
                    safeMessage: "DiffDash Core rejected a request in its current lifecycle state.",
                  }),
                ),
                current,
              ] as const,
            Stopped: (current) =>
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
            AwaitingOwnership: () => beginDraining(),
            Recovering: () => beginDraining(),
            Ready: () => beginDraining(),
            Draining: () => beginDraining(),
            Failed: () => beginDraining(),
          }),
      )
      const acknowledged = yield* Effect.fromResult(decision)
      if (acknowledged.lifecycle === "draining") {
        yield* Deferred.succeed(drainRequested, undefined)
      }
      return acknowledged

      function beginDraining() {
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
      }
    }, Effect.uninterruptible)

    const interruptOnDrain = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.raceFirst(
        effect,
        Deferred.await(drainRequested).pipe(Effect.andThen(Effect.interrupt)),
      )

    const transition = (
      to: CoreLifecycleState,
      update: (state: State) => Option.Option<State>,
    ): Effect.Effect<void, CoreLifecycleTransitionError> =>
      Ref.modify(
        stateRef,
        (state): readonly [Result.Result<void, CoreLifecycleTransitionError>, State] => {
          const next = update(state)
          return Option.match(next, {
            onNone: () => [Result.fail(transitionError(state, to)), state] as const,
            onSome: (value) => [Result.succeed(undefined), value] as const,
          })
        },
      ).pipe(Effect.flatMap(Effect.fromResult))

    const awaitOwnershipAuthorization = transition("awaitingOwnership", (state) =>
      Match.valueTags(state, {
        Starting: () => Option.some(State.AwaitingOwnership()),
        AwaitingOwnership: (current) => Option.some<State>(current),
        Recovering: () => Option.none<State>(),
        Ready: () => Option.none<State>(),
        Draining: () => Option.none<State>(),
        Stopped: () => Option.none<State>(),
        Failed: () => Option.none<State>(),
      }),
    )

    const completeRecovery = transition("ready", (state) =>
      Match.valueTags(state, {
        Recovering: (current) =>
          Option.some(
            State.Ready({
              authorizationId: current.authorizationId,
            }),
          ),
        Ready: (current) => Option.some<State>(current),
        Starting: () => Option.none<State>(),
        AwaitingOwnership: () => Option.none<State>(),
        Draining: () => Option.none<State>(),
        Stopped: () => Option.none<State>(),
        Failed: () => Option.none<State>(),
      }),
    )

    const completeShutdown = transition("stopped", (state) =>
      Match.valueTags(state, {
        Draining: () => Option.some(State.Stopped()),
        Stopped: (current) => Option.some<State>(current),
        Starting: () => Option.none<State>(),
        AwaitingOwnership: () => Option.none<State>(),
        Recovering: () => Option.none<State>(),
        Ready: () => Option.none<State>(),
        Failed: () => Option.none<State>(),
      }),
    )

    const markFailed = transition("failed", (state) =>
      Match.valueTags(state, {
        Starting: () => Option.some(State.Failed()),
        AwaitingOwnership: () => Option.some(State.Failed()),
        Recovering: () => Option.some(State.Failed()),
        Ready: () => Option.some(State.Failed()),
        Failed: (current) => Option.some<State>(current),
        Draining: () => Option.none<State>(),
        Stopped: () => Option.none<State>(),
      }),
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
