import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  CoreHostCapabilityAllowlist,
  CoreHostCapabilityFailure,
  CoreHostCapabilityRpcs,
  HostOpenExternalRequest,
  HostOpenPathRequest,
} from "./host-capability"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
} from "./identity"

const context = CoreRequestContext.make({
  applicationInstanceId: ApplicationInstanceId.make("app-host"),
  processEpoch: CoreProcessEpoch.make("epoch-host"),
  requestId: CoreRequestId.make("c:open-external"),
})

describe("Core host capability RPCs", () => {
  it("publishes a closed reverse-only allowlist with Core request identities", () => {
    expect([...CoreHostCapabilityRpcs.requests.keys()]).toEqual([
      "Host.openExternal",
      "Host.openPath",
    ])
    expect([...CoreHostCapabilityAllowlist]).toEqual([...CoreHostCapabilityRpcs.requests.keys()])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(HostOpenExternalRequest)({
          context: { ...context, requestId: "h:not-core-originated" },
          url: "https://usediffdash.com",
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(HostOpenPathRequest)({ context, path: "relative/path" }),
      ),
    ).toBe(true)
  })

  it.effect("executes an allowlisted native capability through Effect RPC", () => {
    const handlers = CoreHostCapabilityRpcs.toLayer({
      "Host.openExternal": ({ url }) => Effect.succeed(expect(url).toBe("https://usediffdash.com")),
      "Host.openPath": () => Effect.void,
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreHostCapabilityRpcs)
      yield* client["Host.openExternal"]({ context, url: "https://usediffdash.com" })
    }).pipe(Effect.provide(handlers))
  })

  it.effect("preserves reverse failures as plain data", () => {
    const failure = CoreHostCapabilityFailure.make({
      _tag: "CoreHostCapabilityFailure",
      method: "Host.openExternal",
      applicationInstanceId: context.applicationInstanceId,
      processEpoch: context.processEpoch,
      requestId: context.requestId,
      code: "HOST_CAPABILITY_FAILED",
      retryClass: "notRetryable",
      safeMessage: "DiffDash could not open the requested URL.",
    })
    const handlers = CoreHostCapabilityRpcs.toLayer({
      "Host.openExternal": () => Effect.fail(failure),
      "Host.openPath": () => Effect.void,
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreHostCapabilityRpcs)
      const result = yield* client["Host.openExternal"]({
        context,
        url: "https://usediffdash.com",
      }).pipe(Effect.flip)

      expect(result).toEqual(failure)
      expect(result).not.toBeInstanceOf(Error)
      expect(result).not.toHaveProperty("stack")
      expect(result).not.toHaveProperty("cause")
    }).pipe(Effect.provide(handlers))
  })
})
