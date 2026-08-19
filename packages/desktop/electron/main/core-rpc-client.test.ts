import { CoreHealth } from "@diffdash/core-rpc/lifecycle"
import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc/identity"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { verifyCoreHealth } from "./core-rpc-client"

const expected = {
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
} as const

describe("Core RPC client", () => {
  it.effect("accepts the exact launched Core identity", () => {
    const health = CoreHealth.make({ ...expected, lifecycle: "awaitingOwnership" })
    return Effect.gen(function* () {
      expect(yield* verifyCoreHealth(expected, health)).toEqual(health)
    })
  })

  it.effect("rejects a stale health epoch before ownership authorization", () => {
    const health = CoreHealth.make({
      ...expected,
      processEpoch: CoreProcessEpoch.make("epoch-stale"),
      lifecycle: "awaitingOwnership",
    })
    return Effect.gen(function* () {
      const failure = yield* verifyCoreHealth(expected, health).pipe(Effect.flip)
      expect(failure).toMatchObject({
        _tag: "CoreRpcHealthVerificationError",
        expectedProcessEpoch: "epoch-1",
        actualProcessEpoch: "epoch-stale",
      })
    })
  })
})
