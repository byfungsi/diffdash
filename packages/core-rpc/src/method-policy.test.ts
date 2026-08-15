import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
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
import { type CoreRpcMethodPolicy, getCoreRpcMethodPolicy } from "./method-policy"
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
    const retryablePolicies: Array<readonly [string, CoreRpcMethodPolicy]> = []
    const keyedRetryPolicies: Array<readonly [string, CoreRpcMethodPolicy]> = []

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
    expect([...CoreHostCapabilityRpcs.requests.keys()]).toEqual([
      "Host.openExternal",
      "Host.openPath",
    ])
    expect(new Set(declarations.map(([tag]) => tag)).size).toBe(declarations.length)
    for (const [tag, declaration] of declarations) {
      const policy = getCoreRpcMethodPolicy(declaration)
      expect(Option.isSome(policy), `${tag} must declare a complete method policy`).toBe(true)
      if (Option.isNone(policy)) continue
      const { value } = policy
      expect(value.deadlineMs).toBeGreaterThan(0)
      expect(value.maxRequestBytes).toBeGreaterThan(0)
      expect(value.maxResponseBytes).toBeGreaterThan(0)
      expect(value.maxRequestBytes, `${tag} request must fit one native RPC frame`).toBeLessThan(
        CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      )
      expect(value.maxResponseBytes, `${tag} response must fit one native RPC frame`).toBeLessThan(
        CORE_RPC_INCOMPLETE_BUFFER_BYTES,
      )
      if (value.restartBehavior === "retryInNewEpoch") retryablePolicies.push([tag, value])
      if (value.restartBehavior === "retryByIdempotencyKey") {
        keyedRetryPolicies.push([tag, value])
      }
      if (tag.startsWith("Host.")) {
        expect(
          value.requiredHostCapabilities,
          `${tag} must name exactly one native capability`,
        ).toHaveLength(1)
        expect(value.requiredScope).toBe("application")
        expect(value.mutationClass).toBe("uncertainMutation")
        expect(value.idempotency).toBe("nonIdempotent")
        expect(value.restartBehavior).toBe("failOnRestart")
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
      "ReviewAgents.start",
      "ReviewAgents.getOperation",
      "ReviewAgents.cancel",
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
