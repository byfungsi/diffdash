import { describe, expect, it } from "@effect/vitest"
import type * as Rpc from "effect/unstable/rpc/Rpc"

import { CoreBusinessRpcs } from "./business"
import { CoreControlRpcs } from "./control"
import { CoreHostCapabilityRpcs } from "./host-capability"
import { getCoreRpcMethodPolicy } from "./method-policy"

describe("Core RPC method policy", () => {
  it("attaches one complete policy to every declared RPC", () => {
    const declarations: Array<readonly [string, Rpc.Any]> = []
    declarations.push(...CoreControlRpcs.requests.entries())
    declarations.push(...CoreBusinessRpcs.requests.entries())
    declarations.push(...CoreHostCapabilityRpcs.requests.entries())
    const retryablePolicies: Array<
      readonly [string, NonNullable<ReturnType<typeof getCoreRpcMethodPolicy>>]
    > = []

    expect(CoreControlRpcs.requests.has("Core.health")).toBe(true)
    expect(CoreBusinessRpcs.requests.has("AppState.get")).toBe(true)
    expect(new Set(declarations.map(([tag]) => tag)).size).toBe(declarations.length)
    for (const [tag, declaration] of declarations) {
      const policy = getCoreRpcMethodPolicy(declaration)
      expect(policy, `${tag} must declare a complete method policy`).toBeDefined()
      if (policy === undefined) continue
      expect(policy.deadlineMs).toBeGreaterThan(0)
      expect(policy.maxRequestBytes).toBeGreaterThan(0)
      expect(policy.maxResponseBytes).toBeGreaterThan(0)
      if (policy.restartBehavior === "retryInNewEpoch") retryablePolicies.push([tag, policy])
    }

    for (const [tag, policy] of retryablePolicies) {
      expect(policy.mutationClass, `${tag} retries only reads in a new epoch`).toBe("read")
      expect(policy.idempotency, `${tag} retries only idempotent requests`).toBe("idempotent")
    }
  })
})
