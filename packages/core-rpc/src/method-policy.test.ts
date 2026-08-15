import { describe, expect, it } from "@effect/vitest"
import type * as Rpc from "effect/unstable/rpc/Rpc"

import {
  AppStateGetAdmissionMiddleware,
  CoreTransportAuthenticationMiddleware,
  WalkthroughCancelAdmissionMiddleware,
  WalkthroughGetOperationAdmissionMiddleware,
  WalkthroughGetStoredAdmissionMiddleware,
  WalkthroughStartAdmissionMiddleware,
} from "./admission"
import { CoreBusinessRpcs } from "./business"
import { CoreControlRpcs } from "./control"
import { CoreHostCapabilityRpcs } from "./host-capability"
import { getCoreRpcMethodPolicy } from "./method-policy"
import {
  AuthenticatedCoreBusinessRpcs,
  AuthenticatedCoreServerRpcs,
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
} from "./transport"

describe("Core RPC method policy", () => {
  it("attaches one complete policy to every declared RPC", () => {
    const declarations: Array<readonly [string, Rpc.Any]> = []
    declarations.push(...CoreControlRpcs.requests.entries())
    declarations.push(...CoreBusinessRpcs.requests.entries())
    declarations.push(...CoreHostCapabilityRpcs.requests.entries())
    const retryablePolicies: Array<
      readonly [string, NonNullable<ReturnType<typeof getCoreRpcMethodPolicy>>]
    > = []
    const keyedRetryPolicies: Array<
      readonly [string, NonNullable<ReturnType<typeof getCoreRpcMethodPolicy>>]
    > = []

    expect(CoreControlRpcs.requests.has("Core.health")).toBe(true)
    expect(CoreControlRpcs.requests.has("Core.authorizeDatabaseOwnership")).toBe(true)
    expect(CoreControlRpcs.requests.has("Core.shutdown")).toBe(true)
    expect(CoreBusinessRpcs.requests.has("AppState.get")).toBe(true)
    expect(CoreBusinessRpcs.requests.get("AppState.get")?.middlewares).toEqual(
      new Set([AppStateGetAdmissionMiddleware]),
    )
    expect(CoreBusinessRpcs.requests.get("Walkthroughs.start")?.middlewares).toEqual(
      new Set([WalkthroughStartAdmissionMiddleware]),
    )
    expect(CoreBusinessRpcs.requests.get("Walkthroughs.getOperation")?.middlewares).toEqual(
      new Set([WalkthroughGetOperationAdmissionMiddleware]),
    )
    expect(CoreBusinessRpcs.requests.get("Walkthroughs.cancel")?.middlewares).toEqual(
      new Set([WalkthroughCancelAdmissionMiddleware]),
    )
    expect(CoreBusinessRpcs.requests.get("Walkthroughs.getStored")?.middlewares).toEqual(
      new Set([WalkthroughGetStoredAdmissionMiddleware]),
    )
    expect(new Set(declarations.map(([tag]) => tag)).size).toBe(declarations.length)
    for (const [tag, declaration] of declarations) {
      const policy = getCoreRpcMethodPolicy(declaration)
      expect(policy, `${tag} must declare a complete method policy`).toBeDefined()
      if (policy === undefined) continue
      expect(policy.deadlineMs).toBeGreaterThan(0)
      expect(policy.maxRequestBytes).toBeGreaterThan(0)
      expect(policy.maxResponseBytes).toBeGreaterThan(0)
      expect(policy.maxRequestBytes, `${tag} request must fit one native RPC frame`).toBeLessThan(
        CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      )
      expect(policy.maxResponseBytes, `${tag} response must fit one native RPC frame`).toBeLessThan(
        CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      )
      if (policy.restartBehavior === "retryInNewEpoch") retryablePolicies.push([tag, policy])
      if (policy.restartBehavior === "retryByIdempotencyKey") {
        keyedRetryPolicies.push([tag, policy])
      }
    }

    for (const [tag, policy] of retryablePolicies) {
      expect(policy.mutationClass, `${tag} retries only reads in a new epoch`).toBe("read")
      expect(policy.idempotency, `${tag} retries only idempotent requests`).toBe("idempotent")
    }
    for (const [tag, policy] of keyedRetryPolicies) {
      expect(policy.mutationClass, `${tag} keyed retries only idempotent mutations`).toBe(
        "idempotentMutation",
      )
      expect(policy.idempotency, `${tag} keyed retries require an idempotency key`).toBe(
        "idempotencyKeyRequired",
      )
    }
  })

  it("publishes the complete business audience without activating unimplemented handlers", () => {
    expect([...CoreBusinessRpcs.requests.keys()]).toEqual([
      "AppState.get",
      "Walkthroughs.start",
      "Walkthroughs.getOperation",
      "Walkthroughs.cancel",
      "Walkthroughs.getStored",
    ])
    expect([...AuthenticatedCoreBusinessRpcs.requests.keys()]).toEqual([
      ...CoreBusinessRpcs.requests.keys(),
    ])
    for (const declaration of AuthenticatedCoreBusinessRpcs.requests.values()) {
      expect(declaration.middlewares.has(CoreTransportAuthenticationMiddleware)).toBe(true)
    }

    expect([...AuthenticatedCoreServerRpcs.requests.keys()]).toEqual([
      "Core.health",
      "Core.authorizeDatabaseOwnership",
      "Core.shutdown",
      "AppState.get",
    ])
  })
})
