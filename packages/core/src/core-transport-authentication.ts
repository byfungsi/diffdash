import { CoreTransportAuthenticationMiddleware } from "@diffdash/core-rpc/admission"
import { CoreTransportAuthenticationFailure } from "@diffdash/core-rpc/failure"
import { CORE_TRANSPORT_TOKEN_HEADER } from "@diffdash/core-rpc/transport"
import { Effect, Layer, Match, Option, Redacted, Ref, Semaphore } from "effect"
import * as Headers from "effect/unstable/http/Headers"
import { timingSafeEqual } from "node:crypto"

import { CoreLifecycle } from "./core-lifecycle"

interface BoundClient {
  readonly clientId: number
  readonly healthCompleted: boolean
}

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
      const boundClient = yield* Ref.make<Option.Option<BoundClient>>(Option.none())
      const authenticationLock = yield* Semaphore.make(1)

      return (effect, request) => {
        const isHealth = Match.valueTags(request.rpc, {
          "Core.health": () => true,
          "Core.authorizeDatabaseOwnership": () => false,
          "Core.shutdown": () => false,
          "AppState.get": () => false,
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
