import { AppState } from "@diffdash/domain/app-state"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { AppStateGetRpc, CoreBusinessRpcs } from "./business"
import { CoreAuthorizeDatabaseOwnershipRpc, CoreHealthRpc, CoreShutdownRpc } from "./control"
import {
  AppStateGetDefect,
  AppStateReadFailure,
  CoreHealthDefect,
  CoreHealthIdentityMismatchFailure,
  CoreRpcSafeMessage,
} from "./failure"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "./identity"
import {
  AuthorizeDatabaseOwnershipRequest,
  CoreHealth,
  CoreShutdownAcknowledged,
  DatabaseOwnershipAuthorized,
} from "./lifecycle"

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

const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...request,
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-1"),
})

const authorized = DatabaseOwnershipAuthorized.make({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  authorizationId: authorizationRequest.authorizationId,
  lifecycle: "recovering",
})

const shutdownAcknowledged = CoreShutdownAcknowledged.make({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  lifecycle: "draining",
})

const identityFailure = CoreHealthIdentityMismatchFailure.make({
  code: "CORE_REQUEST_IDENTITY_MISMATCH",
  method: "Core.health",
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  retryClass: "automatic",
  safeMessage: "DiffDash Core rejected a request for a different process identity.",
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

const appStateDefect = AppStateGetDefect.make({
  code: "APP_STATE_INTERNAL_ERROR",
  method: "AppState.get",
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  retryClass: "notRetryable",
  safeMessage: "DiffDash Core encountered an internal application-state error.",
})

const healthDefect = CoreHealthDefect.make({
  _tag: "CoreControlDefect",
  code: "CORE_INTERNAL_ERROR",
  method: "Core.health",
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  retryClass: "notRetryable",
  safeMessage: "DiffDash Core encountered an internal control-plane error.",
})

describe("Core RPC declarations", () => {
  it.effect("executes health through the native in-memory RPC client and server", () => {
    const healthRpcs = RpcGroup.make(CoreHealthRpc)
    const handlers = healthRpcs.toLayerHandler("Core.health", (input) =>
      Effect.succeed(
        CoreHealth.make({
          applicationInstanceId: input.applicationInstanceId,
          processEpoch: input.processEpoch,
          lifecycle: "awaitingOwnership",
        }),
      ),
    )

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(healthRpcs)
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
      Schema.encodeSync(CoreHealthRpc.errorSchema)(identityFailure),
      Schema.encodeSync(CoreAuthorizeDatabaseOwnershipRpc.payloadSchema)(authorizationRequest),
      Schema.encodeSync(CoreAuthorizeDatabaseOwnershipRpc.successSchema)(authorized),
      Schema.encodeSync(CoreShutdownRpc.successSchema)(shutdownAcknowledged),
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
    expect(Schema.decodeUnknownSync(CoreHealthRpc.errorSchema)(decodedValues[1])).toEqual(
      identityFailure,
    )
    expect(
      Schema.decodeUnknownSync(CoreAuthorizeDatabaseOwnershipRpc.payloadSchema)(decodedValues[2]),
    ).toEqual(authorizationRequest)
    expect(
      Schema.decodeUnknownSync(CoreAuthorizeDatabaseOwnershipRpc.successSchema)(decodedValues[3]),
    ).toEqual(authorized)
    expect(Schema.decodeUnknownSync(CoreShutdownRpc.successSchema)(decodedValues[4])).toEqual(
      shutdownAcknowledged,
    )
    expect(Schema.decodeUnknownSync(CoreRequestContext)(decodedValues[5])).toEqual(
      hostCapabilityRequest,
    )
    expect(Schema.decodeUnknownSync(AppStateGetRpc.successSchema)(decodedValues[6])).toEqual(state)
    const decodedFailure = Schema.decodeUnknownSync(AppStateGetRpc.errorSchema)(decodedValues[7])
    expect(decodedFailure).toEqual(failure)
    expect(decodedFailure).not.toBeInstanceOf(Error)
    expect(decodedFailure).not.toHaveProperty("cause")
    expect(decodedFailure).not.toHaveProperty("stack")
    expect(decodedFailure).not.toHaveProperty("path")
  })

  it("roundtrips a sanitized control defect without private diagnostics", () => {
    const schema = Rpc.exitSchema(CoreHealthRpc)
    const encoded = Schema.encodeSync(schema)(Exit.die(healthDefect))
    const decoded = Schema.decodeSync(schema)(encoded)

    expect(Exit.isFailure(decoded)).toBe(true)
    if (Exit.isSuccess(decoded)) throw new Error("Expected a defect exit")

    const defect = Cause.squash(decoded.cause)
    expect(defect).toEqual(healthDefect)
    expect(defect).not.toHaveProperty("cause")
    expect(defect).not.toHaveProperty("stack")
    expect(defect).not.toHaveProperty("path")
  })

  it("roundtrips a sanitized AppState defect without private diagnostics", () => {
    const schema = Rpc.exitSchema(AppStateGetRpc)
    const encoded = Schema.encodeSync(schema)(Exit.die(appStateDefect))
    const decoded = Schema.decodeSync(schema)(encoded)

    expect(Exit.isFailure(decoded)).toBe(true)
    if (Exit.isSuccess(decoded)) throw new Error("Expected a defect exit")

    const defect = Cause.squash(decoded.cause)
    expect(defect).toEqual(appStateDefect)
    expect(defect).not.toHaveProperty("cause")
    expect(defect).not.toHaveProperty("stack")
    expect(defect).not.toHaveProperty("path")
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
