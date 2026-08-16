import { CoreTransportAuthenticationMiddleware } from "@diffdash/core-rpc/admission"
import { CoreTransportAuthenticationFailure } from "@diffdash/core-rpc/failure"
import { CORE_TRANSPORT_TOKEN_HEADER } from "@diffdash/core-rpc/transport"
import { Context, Deferred, Effect, Layer, Option, Redacted, Ref } from "effect"
import * as Headers from "effect/unstable/http/Headers"
import { timingSafeEqual } from "node:crypto"

import { CoreLifecycle } from "./core-lifecycle"

interface AuthenticatedHostState {
  readonly clientId: Option.Option<number>
  readonly lastDisconnectedClientId: number
}

/** Process-local signal for the lifetime of the one authenticated host connection. */
export interface CoreAuthenticatedHostSessionOperations {
  /** Records the native RPC client accepted by transport authentication. */
  readonly authenticated: (clientId: number) => Effect.Effect<boolean>

  /** Returns whether this client currently owns the authenticated host slot. */
  readonly isAuthenticated: (clientId: number) => Effect.Effect<boolean>

  /** Records a native RPC disconnect without exposing socket details. */
  readonly disconnected: (clientId: number) => Effect.Effect<void>

  /** Completes only after the authenticated host connection dies. */
  readonly awaitDeath: Effect.Effect<void>
}

/** Shared authority connecting RPC authentication to native disconnect handling. */
export class CoreAuthenticatedHostSession extends Context.Service<
  CoreAuthenticatedHostSession,
  CoreAuthenticatedHostSessionOperations
>()("@diffdash/core/CoreAuthenticatedHostSession") {}

/** Provides one authenticated host lifetime signal for one Core transport. */
export const coreAuthenticatedHostSessionLayer = Layer.effect(
  CoreAuthenticatedHostSession,
  Effect.gen(function* () {
    const death = yield* Deferred.make<void>()
    const state = yield* Ref.make<AuthenticatedHostState>({
      clientId: Option.none(),
      lastDisconnectedClientId: -1,
    })
    const authenticated = Effect.fn("CoreAuthenticatedHostSession.authenticated")(function* (
      clientId: number,
    ) {
      return yield* Ref.modify(state, (current) => {
        const accepted =
          clientId > current.lastDisconnectedClientId &&
          Option.match(current.clientId, {
            onNone: () => true,
            onSome: (authenticatedClientId) => authenticatedClientId === clientId,
          })
        return [accepted, accepted ? { ...current, clientId: Option.some(clientId) } : current]
      })
    })
    const disconnected = Effect.fn("CoreAuthenticatedHostSession.disconnected")(function* (
      clientId: number,
    ) {
      const authenticatedClientDied = yield* Ref.modify(
        state,
        (current): readonly [boolean, AuthenticatedHostState] => {
          const died = Option.contains(current.clientId, clientId)
          return [
            died,
            {
              clientId: died ? Option.none() : current.clientId,
              lastDisconnectedClientId: Math.max(current.lastDisconnectedClientId, clientId),
            },
          ]
        },
      )
      if (authenticatedClientDied) yield* Deferred.succeed(death, undefined)
    })
    return CoreAuthenticatedHostSession.of({
      authenticated,
      disconnected,
      isAuthenticated: (clientId) =>
        Ref.get(state).pipe(
          Effect.map((current) => Option.contains(current.clientId, clientId)),
        ),
      awaitDeath: Deferred.await(death),
    })
  }),
)

/** Fixed bootstrap credential for one private Core transport lifetime. */
export interface CoreTransportAuthenticationOptions {
  readonly token: Redacted.Redacted
}

const authenticationFailure = CoreTransportAuthenticationFailure.make({
  code: "CORE_TRANSPORT_AUTHENTICATION_FAILED",
  retryClass: "notRetryable",
  safeMessage: "DiffDash Core rejected an unauthenticated host connection.",
})

const tokensEqual = (expected: string, presented: Option.Option<string>): boolean =>
  Option.match(presented, {
    onNone: () => false,
    onSome: (token) => {
      const expectedBytes = Buffer.from(expected)
      const presentedBytes = Buffer.from(token)
      return (
        expectedBytes.length === presentedBytes.length &&
        timingSafeEqual(expectedBytes, presentedBytes)
      )
    },
  })

/** Authenticates and permanently binds the first valid native RPC connection. */
export const coreTransportAuthenticationLayer = (options: CoreTransportAuthenticationOptions) =>
  Layer.effect(
    CoreTransportAuthenticationMiddleware,
    Effect.gen(function* () {
      const lifecycle = yield* CoreLifecycle
      const hostSession = yield* CoreAuthenticatedHostSession
      const healthCompleted = yield* Ref.make<ReadonlySet<number>>(new Set())

      return (effect, request) => {
        const isHealth = request.rpc._tag === "Core.health"
        const authenticate = Effect.gen(function* () {
          if (!isHealth) {
            const bound = yield* hostSession.isAuthenticated(request.client.id)
            const completed = yield* Ref.get(healthCompleted)
            return bound && completed.has(request.client.id)
          }

          const alreadyAuthenticated = yield* hostSession.isAuthenticated(request.client.id)
          const presentedToken = Headers.get(request.headers, CORE_TRANSPORT_TOKEN_HEADER)
          if (
            !alreadyAuthenticated &&
            !tokensEqual(Redacted.value(options.token), presentedToken)
          ) {
            return false
          }
          const accepted = yield* hostSession.authenticated(request.client.id)
          if (!accepted) return false
          yield* lifecycle.awaitOwnershipAuthorization.pipe(
            Effect.catchTag("CoreLifecycleTransitionError", (error) =>
              error.from === "recovering" || error.from === "ready" || error.from === "failed"
                ? Effect.void
                : Effect.die(error),
            ),
          )
          return true
        })

        const admitted = authenticate.pipe(
          Effect.flatMap((authenticated) =>
            authenticated ? effect : Effect.fail(authenticationFailure),
          ),
        )
        return isHealth
          ? admitted.pipe(
              Effect.tap(() =>
                Ref.update(healthCompleted, (current) => new Set(current).add(request.client.id)),
              ),
            )
          : admitted
      }
    }),
  )
