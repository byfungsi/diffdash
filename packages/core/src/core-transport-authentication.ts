import { CoreTransportAuthenticationMiddleware } from "@diffdash/core-rpc/admission"
import { CoreTransportAuthenticationFailure } from "@diffdash/core-rpc/failure"
import { CORE_TRANSPORT_TOKEN_HEADER } from "@diffdash/core-rpc/transport"
import { Context, Deferred, Effect, Layer, Match, Option, Redacted, Ref, Semaphore } from "effect"
import * as Headers from "effect/unstable/http/Headers"
import { timingSafeEqual } from "node:crypto"

import { CoreLifecycle } from "./core-lifecycle"

interface BoundClient {
  readonly clientId: number
  readonly healthCompleted: boolean
}

interface AuthenticatedHostState {
  readonly clientId: Option.Option<number>
  readonly lastDisconnectedClientId: number
}

/** Process-local signal for the lifetime of the one authenticated host connection. */
export interface CoreAuthenticatedHostSessionOperations {
  /** Records the native RPC client accepted by transport authentication. */
  readonly authenticated: (clientId: number) => Effect.Effect<void>

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
      const alreadyDisconnected = yield* Ref.modify(state, (current) => [
        clientId <= current.lastDisconnectedClientId,
        { ...current, clientId: Option.some(clientId) },
      ])
      if (alreadyDisconnected) yield* Deferred.succeed(death, undefined)
    })
    const disconnected = Effect.fn("CoreAuthenticatedHostSession.disconnected")(function* (
      clientId: number,
    ) {
      const authenticatedClientDied = yield* Ref.modify(state, (current) => [
        Option.exists(
          current.clientId,
          (authenticatedClientId) => authenticatedClientId === clientId,
        ),
        {
          ...current,
          lastDisconnectedClientId: Math.max(current.lastDisconnectedClientId, clientId),
        },
      ])
      if (authenticatedClientDied) yield* Deferred.succeed(death, undefined)
    })
    return CoreAuthenticatedHostSession.of({
      authenticated,
      disconnected,
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
      const boundClient = yield* Ref.make<Option.Option<BoundClient>>(Option.none())
      const authenticationLock = yield* Semaphore.make(1)

      return (effect, request) => {
        const isHealth = Match.valueTags(request.rpc, {
          "Core.health": () => true,
          "Core.authorizeDatabaseOwnership": () => false,
          "Core.shutdown": () => false,
          "AppState.get": () => false,
          "Walkthroughs.start": () => false,
          "Walkthroughs.getOperation": () => false,
          "Walkthroughs.cancel": () => false,
          "Walkthroughs.getStored": () => false,
        })
        const authenticate = authenticationLock.withPermits(1)(
          Effect.gen(function* () {
            const currentClient = yield* Ref.get(boundClient)
            if (Option.isSome(currentClient)) {
              return currentClient.value.clientId === request.client.id
                ? currentClient.value.healthCompleted || isHealth
                : false
            }
            if (!isHealth) return false

            const presentedToken = Headers.get(request.headers, CORE_TRANSPORT_TOKEN_HEADER)
            if (!tokensEqual(Redacted.value(options.token), presentedToken)) return false

            yield* lifecycle.awaitOwnershipAuthorization.pipe(
              Effect.catchTag("CoreLifecycleTransitionError", (error) =>
                error.from === "failed" ? Effect.void : Effect.die(error),
              ),
            )
            yield* Ref.set(
              boundClient,
              Option.some({
                clientId: request.client.id,
                healthCompleted: false,
              }),
            )
            yield* hostSession.authenticated(request.client.id)
            return true
          }),
        )

        const admitted = authenticate.pipe(
          Effect.flatMap((authenticated) =>
            authenticated ? effect : Effect.fail(authenticationFailure),
          ),
        )
        return isHealth
          ? admitted.pipe(
              Effect.tap(() =>
                Ref.update(boundClient, (current) =>
                  Option.map(current, (client) =>
                    client.clientId === request.client.id
                      ? { ...client, healthCompleted: true }
                      : client,
                  ),
                ),
              ),
            )
          : admitted
      }
    }),
  )
