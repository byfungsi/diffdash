import { CoreHostCapabilityRpcs } from "@diffdash/core-rpc/host-capability"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
} from "@diffdash/core-rpc/identity"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  coreHostCapabilityGatewayLayer,
  CoreHostNativeCapabilitySet,
} from "./core-host-capability-gateway"

const applicationInstanceId = ApplicationInstanceId.make("app-gateway")
const processEpoch = CoreProcessEpoch.make("epoch-gateway")
const context = CoreRequestContext.make({
  applicationInstanceId,
  processEpoch,
  requestId: CoreRequestId.make("c:gateway-request"),
})

const options = {
  applicationInstanceId,
  processEpoch,
  authorizedScopes: new Set(["application"] as const),
  availableCapabilities: CoreHostNativeCapabilitySet,
  native: {
    openExternal: () => Effect.void,
    openPath: () => Effect.void,
  },
} as const

describe("Core host capability gateway", () => {
  it.effect("executes only an allowlisted capability for the current Core identity", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreHostCapabilityRpcs)
      yield* client["Host.openExternal"]({ context, url: "https://usediffdash.com" })
    }).pipe(Effect.provide(coreHostCapabilityGatewayLayer(options))),
  )

  it.effect("rejects stale epochs, missing scopes, and unavailable capabilities", () =>
    Effect.gen(function* () {
      const staleClient = yield* RpcTest.makeClient(CoreHostCapabilityRpcs).pipe(
        Effect.provide(
          coreHostCapabilityGatewayLayer({
            ...options,
            processEpoch: CoreProcessEpoch.make("epoch-new"),
          }),
        ),
      )
      const stale = yield* staleClient["Host.openExternal"]({
        context,
        url: "https://usediffdash.com",
      }).pipe(Effect.flip)
      expect(stale).toMatchObject({
        code: "HOST_CAPABILITY_REJECTED",
        requestId: "c:gateway-request",
      })

      const noScopeClient = yield* RpcTest.makeClient(CoreHostCapabilityRpcs).pipe(
        Effect.provide(coreHostCapabilityGatewayLayer({ ...options, authorizedScopes: new Set() })),
      )
      const noScope = yield* noScopeClient["Host.openPath"]({
        context,
        path: "/tmp/review.txt",
      }).pipe(Effect.flip)
      expect(noScope).toMatchObject({ code: "HOST_CAPABILITY_REJECTED" })

      const unavailableClient = yield* RpcTest.makeClient(CoreHostCapabilityRpcs).pipe(
        Effect.provide(
          coreHostCapabilityGatewayLayer({ ...options, availableCapabilities: new Set() }),
        ),
      )
      const unavailable = yield* unavailableClient["Host.openPath"]({
        context,
        path: "/tmp/review.txt",
      }).pipe(Effect.flip)
      expect(unavailable).toMatchObject({ code: "HOST_CAPABILITY_REJECTED" })
    }),
  )

  it.effect("enforces the declared deadline and interrupts native work", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const client = yield* RpcTest.makeClient(CoreHostCapabilityRpcs).pipe(
        Effect.provide(
          coreHostCapabilityGatewayLayer({
            ...options,
            native: {
              ...options.native,
              openExternal: () =>
                Effect.never.pipe(
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
            },
          }),
        ),
      )
      const fiber = yield* client["Host.openExternal"]({
        context,
        url: "https://usediffdash.com",
      }).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      const failure = yield* Fiber.join(fiber)

      expect(failure).toMatchObject({ code: "HOST_CAPABILITY_DEADLINE_EXCEEDED" })
      expect(yield* Deferred.await(interrupted)).toBeUndefined()
    }),
  )

  it.effect("projects native defects to source-safe capability failures", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreHostCapabilityRpcs).pipe(
        Effect.provide(
          coreHostCapabilityGatewayLayer({
            ...options,
            native: {
              ...options.native,
              openPath: () => Effect.die(new Error("private /Users/example/repository")),
            },
          }),
        ),
      )
      const failure = yield* client["Host.openPath"]({
        context,
        path: "/tmp/review.txt",
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({ code: "HOST_CAPABILITY_FAILED" })
      expect(JSON.stringify(failure)).not.toContain("/Users/example")
    }),
  )
})
