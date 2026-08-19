import { randomUUID } from "node:crypto"

import { ResourceRecoveryToken } from "@diffdash/persistence/resource-catalog"
import { Clock, Effect } from "effect"

import { CoreMethod } from "../core-contract"
import { DisposableResourceLifecycle } from "../disposable-resource-lifecycle"
import type { OperationHandlersFor } from "./operation-handlers"

type ResourceMethod =
  | typeof CoreMethod.resourceDiagnostics
  | typeof CoreMethod.clearDisposableResources

/** Acquires privacy-safe resource diagnostics and policy-driven collection handlers. */
export const makeResourceOperationHandlers: Effect.Effect<
  OperationHandlersFor<ResourceMethod>,
  never,
  DisposableResourceLifecycle
> = Effect.gen(function* () {
  const resources = yield* DisposableResourceLifecycle

  return {
    [CoreMethod.resourceDiagnostics]: () =>
      Clock.currentTimeMillis.pipe(Effect.flatMap(resources.diagnostics)),
    [CoreMethod.clearDisposableResources]: () =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        return yield* resources.clearCache({
          nowMs,
          retryAtMs: nowMs + 60_000,
          recoveryToken: () => ResourceRecoveryToken.make(randomUUID()),
        })
      }),
  } satisfies OperationHandlersFor<ResourceMethod>
})
