import { CoreTransportAuthenticationMiddleware } from "@diffdash/core-rpc/admission"
import { CoreTransportAuthenticationFailure } from "@diffdash/core-rpc/failure"
import { CORE_TRANSPORT_TOKEN_HEADER } from "@diffdash/core-rpc/transport"
import { Effect, Layer, Option, Redacted, Ref, Semaphore } from "effect"
import { Match } from "effect"
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

const tokensEqual = (expected: string, presented: string | undefined): boolean => {
  if (presented === undefined) return false
  const expectedBytes = Buffer.from(expected)
  const presentedBytes = Buffer.from(presented)
  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  )
}

/** Authenticates and permanently binds the first valid native RPC connection. */
export const coreTransportAuthenticationLayer = (options: CoreTransportAuthenticationOptions) =>
  Layer.effect(
    CoreTransportAuthenticationMiddleware,
    Effect.gen(function* () {
      const lifecycle = yield* CoreLifecycle
      const boundClient = yield* Ref.make<BoundClient | undefined>(undefined)
      const authenticationLock = yield* Semaphore.make(1)

      return (effect, request) => {
        const isHealth = Match.value(request.rpc).pipe(
          Match.tag("Core.health", () => true),
          Match.orElse(() => false),
        )
        const authenticate = authenticationLock.withPermits(1)(
          Effect.gen(function* () {
            const currentClient = yield* Ref.get(boundClient)
            if (currentClient?.clientId === request.client.id) {
              return currentClient.healthCompleted || isHealth
            }
            if (currentClient !== undefined) return false
            if (!isHealth) return false

            const presentedToken = Option.getOrUndefined(
              Headers.get(request.headers, CORE_TRANSPORT_TOKEN_HEADER),
            )
            if (!tokensEqual(Redacted.value(options.token), presentedToken)) return false

            yield* lifecycle.awaitOwnershipAuthorization.pipe(
              Effect.catchTag("CoreLifecycleTransitionError", (error) =>
                error.from === "failed" ? Effect.void : Effect.die(error),
              ),
            )
            yield* Ref.set(boundClient, {
              clientId: request.client.id,
              healthCompleted: false,
            })
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
                  current?.clientId === request.client.id
                    ? { ...current, healthCompleted: true }
                    : current,
                ),
              ),
            )
          : admitted
      }
    }),
  )
