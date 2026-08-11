import { AppState } from "@diffdash/domain/app-state"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { AppStateGetRpc, CoreBusinessRpcs } from "./business"
import { CoreControlRpcs, CoreHealthRpc } from "./control"
import { AppStateReadFailure, CoreRpcSafeMessage } from "./failure"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
  HostRequestContext,
  HostRequestId,
} from "./identity"
import { CoreHealth } from "./lifecycle"

const request = HostRequestContext.make({
  applicationInstanceId: ApplicationInstanceId.make("app-1"),
  processEpoch: CoreProcessEpoch.make("epoch-1"),
  requestId: HostRequestId.make("h:request-1"),
})

const hostCapabilityRequest = CoreRequestContext.make({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: CoreRequestId.make("c:request-1"),
})

const state = AppState.make({ onboardingCompleted: true })

const failure = AppStateReadFailure.make({
  code: "APP_STATE_READ_FAILED",
  method: "AppState.get",
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  retryClass: "userAction",
  safeMessage: "DiffDash could not read application state.",
})

describe("Core RPC declarations", () => {
  it.effect("executes health through the native in-memory RPC client and server", () => {
    const handlers = CoreControlRpcs.toLayer({
      "Core.health": (input) =>
        Effect.succeed(
          CoreHealth.make({
            applicationInstanceId: input.applicationInstanceId,
            processEpoch: input.processEpoch,
            lifecycle: "awaitingOwnership",
          }),
        ),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreControlRpcs)
      const health = yield* client["Core.health"](request)

      expect(health).toEqual({
        applicationInstanceId: "app-1",
        processEpoch: "epoch-1",
        lifecycle: "awaitingOwnership",
      })
    }).pipe(Effect.provide(handlers))
  })

  it.effect("preserves AppState success through the native in-memory RPC client and server", () => {
    const handlers = CoreBusinessRpcs.toLayer({
      "AppState.get": () => Effect.succeed(state),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreBusinessRpcs)
      const result = yield* client["AppState.get"](request)

      expect(result).toEqual(state)
    }).pipe(Effect.provide(handlers))
  })

  it.effect("preserves a stable plain AppState failure through native in-memory RPC", () => {
    const handlers = CoreBusinessRpcs.toLayer({
      "AppState.get": () => Effect.fail(failure),
    })

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreBusinessRpcs)
      const result = yield* client["AppState.get"](request).pipe(Effect.flip)

      expect(result).toEqual(failure)
      expect(result).not.toBeInstanceOf(Error)
      expect(result).not.toHaveProperty("cause")
      expect(result).not.toHaveProperty("stack")
      expect(result).not.toHaveProperty("path")
    }).pipe(Effect.provide(handlers))
  })

  it("roundtrips request, success, and expected failure schemas through native MessagePack", () => {
    const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 4_096 }).makeUnsafe()
    const encodedValues = [
      Schema.encodeSync(CoreHealthRpc.payloadSchema)(request),
      Schema.encodeSync(CoreRequestContext)(hostCapabilityRequest),
      Schema.encodeSync(AppStateGetRpc.successSchema)(state),
      Schema.encodeSync(AppStateGetRpc.errorSchema)(failure),
    ]

    const decodedValues = encodedValues.flatMap((value) => {
      const bytes = parser.encode(value)
      if (bytes === undefined || typeof bytes === "string") {
        throw new Error("Native MessagePack did not encode a binary frame")
      }
      return parser.decode(bytes)
    })

    expect(Schema.decodeUnknownSync(CoreHealthRpc.payloadSchema)(decodedValues[0])).toEqual(request)
    expect(Schema.decodeUnknownSync(CoreRequestContext)(decodedValues[1])).toEqual(
      hostCapabilityRequest,
    )
    expect(Schema.decodeUnknownSync(AppStateGetRpc.successSchema)(decodedValues[2])).toEqual(state)
    const decodedFailure = Schema.decodeUnknownSync(AppStateGetRpc.errorSchema)(decodedValues[3])
    expect(decodedFailure).toEqual(failure)
    expect(decodedFailure).not.toBeInstanceOf(Error)
    expect(decodedFailure).not.toHaveProperty("cause")
    expect(decodedFailure).not.toHaveProperty("stack")
    expect(decodedFailure).not.toHaveProperty("path")
  })

  it("rejects control characters and Unicode line separators in safe messages", () => {
    for (const unsafe of ["line\nbreak", "line\u0085break", "line\u2028break", "line\u2029break"]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(CoreRpcSafeMessage)(unsafe))).toBe(true)
    }
  })

  it("bounds incomplete native MessagePack input", () => {
    const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 2 }).makeUnsafe()
    const incompleteFrame = Uint8Array.of(0xd9)

    expect(parser.decode(incompleteFrame)).toEqual([])
    expect(parser.decode(incompleteFrame)).toEqual([])
    expect(() => parser.decode(incompleteFrame)).toThrow(RpcSerialization.MaxBufferSizeExceeded)
  })
})
