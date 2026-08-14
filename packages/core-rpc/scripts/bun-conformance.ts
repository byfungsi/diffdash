import { AppState } from "@diffdash/domain/app-state"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  AppStateGetAdmissionMiddleware,
  CoreTransportAuthenticationMiddleware,
} from "../src/admission"
import { AppStateGetRpc, CoreBusinessRpcs } from "../src/business"
import { CoreAuthorizeDatabaseOwnershipRpc, CoreHealthRpc, CoreShutdownRpc } from "../src/control"
import {
  AppStateGetDefect,
  AppStateGetAdmissionFailure,
  AppStateGetDefectSchema,
  AppStateGetLifecycleRejectedFailure,
  AppStateReadFailure,
  CoreHealthIdentityMismatchFailure,
} from "../src/failure"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "../src/identity"
import {
  AuthorizeDatabaseOwnershipRequest,
  CoreHealth,
  CoreShutdownAcknowledged,
  DatabaseOwnershipAuthorized,
} from "../src/lifecycle"

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const request = HostRequestContext.make({
  applicationInstanceId: ApplicationInstanceId.make("app-bun"),
  processEpoch: CoreProcessEpoch.make("epoch-bun"),
  requestId: HostRequestId.make("h:request-bun"),
})
const state = AppState.make({ onboardingCompleted: true })
const hostCapabilityRequest = CoreRequestContext.make({
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: CoreRequestId.make("c:request-bun"),
})
const authorizationRequest = AuthorizeDatabaseOwnershipRequest.make({
  ...request,
  authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-bun"),
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
const admissionFailure = AppStateGetLifecycleRejectedFailure.make({
  code: "CORE_LIFECYCLE_REJECTED",
  method: "AppState.get",
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  lifecycle: "recovering",
  retryClass: "automatic",
  safeMessage: "DiffDash Core is not ready to serve application requests.",
})

const passAppStateAdmissionLayer = Layer.succeed(AppStateGetAdmissionMiddleware, (effect) => effect)
const passTransportAuthenticationLayer = Layer.succeed(
  CoreTransportAuthenticationMiddleware,
  (effect) => effect,
)

const nativeRpcConformance = Effect.gen(function* () {
  const healthRpcs = RpcGroup.make(CoreHealthRpc)
  const healthHandlers = healthRpcs.toLayerHandler("Core.health", (input) =>
    Effect.succeed(
      CoreHealth.make({
        applicationInstanceId: input.applicationInstanceId,
        processEpoch: input.processEpoch,
        lifecycle: "awaitingOwnership",
      }),
    ),
  )
  const healthClient = yield* RpcTest.makeClient(healthRpcs).pipe(Effect.provide(healthHandlers))
  const health = yield* healthClient["Core.health"](request)
  assert(health.processEpoch === request.processEpoch, "Bun native RPC health identity failed")

  const successHandlers = CoreBusinessRpcs.toLayer({
    "AppState.get": () => Effect.succeed(state),
  })
  const successClient = yield* RpcTest.makeClient(CoreBusinessRpcs).pipe(
    Effect.provide(successHandlers),
  )
  const successfulState = yield* successClient["AppState.get"](request)
  assert(successfulState.onboardingCompleted, "Bun native RPC success failed")

  const failureHandlers = CoreBusinessRpcs.toLayer({
    "AppState.get": () => Effect.fail(failure),
  })
  const failureClient = yield* RpcTest.makeClient(CoreBusinessRpcs).pipe(
    Effect.provide(failureHandlers),
  )
  const expectedFailure = yield* failureClient["AppState.get"](request).pipe(Effect.flip)
  assert(expectedFailure.code === failure.code, "Bun native RPC expected failure failed")
  assert(!(expectedFailure instanceof Error), "Bun native RPC returned an Error instance")
  assert(!("cause" in expectedFailure), "Bun native RPC failure exposed a cause")
  assert(!("stack" in expectedFailure), "Bun native RPC failure exposed a stack")
  assert(!("path" in expectedFailure), "Bun native RPC failure exposed a path")

  const defectHandlers = CoreBusinessRpcs.toLayer({
    "AppState.get": () => Effect.die(appStateDefect),
  })
  const defectClient = yield* RpcTest.makeClient(CoreBusinessRpcs).pipe(
    Effect.provide(defectHandlers),
  )
  const projectedDefect = yield* defectClient["AppState.get"](request).pipe(
    Effect.catchDefect(Effect.succeed),
  )
  assert(
    typeof projectedDefect === "object" &&
      projectedDefect !== null &&
      "code" in projectedDefect &&
      projectedDefect.code === appStateDefect.code,
    "Bun native RPC sanitized defect projection failed",
  )
  assert(!("cause" in projectedDefect), "Bun native RPC defect exposed a cause")
  assert(!("stack" in projectedDefect), "Bun native RPC defect exposed a stack")
  assert(!("path" in projectedDefect), "Bun native RPC defect exposed a path")

  const started = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()
  const interruptHandlers = CoreBusinessRpcs.toLayer({
    "AppState.get": () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
  })
  const interruptClient = yield* RpcTest.makeClient(CoreBusinessRpcs).pipe(
    Effect.provide(interruptHandlers),
  )
  const requestFiber = yield* interruptClient["AppState.get"](request).pipe(Effect.forkScoped)
  yield* Deferred.await(started)
  yield* Fiber.interrupt(requestFiber)
  yield* Deferred.await(interrupted)
}).pipe(
  Effect.provide(passAppStateAdmissionLayer),
  Effect.provide(passTransportAuthenticationLayer),
  Effect.scoped,
)

await Effect.runPromise(nativeRpcConformance)

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
  Schema.encodeSync(AppStateGetDefectSchema)(appStateDefect),
  Schema.encodeSync(AppStateGetAdmissionFailure)(admissionFailure),
]
const decodedValues = encodedValues.flatMap((value) => {
  const bytes = parser.encode(value)
  assert(bytes instanceof Uint8Array, "Native MessagePack must encode binary frames under Bun")
  return parser.decode(bytes)
})

const decodedRequest = Schema.decodeUnknownSync(CoreHealthRpc.payloadSchema)(decodedValues[0])
const decodedIdentityFailure = Schema.decodeUnknownSync(CoreHealthRpc.errorSchema)(decodedValues[1])
const decodedAuthorizationRequest = Schema.decodeUnknownSync(
  CoreAuthorizeDatabaseOwnershipRpc.payloadSchema,
)(decodedValues[2])
const decodedAuthorized = Schema.decodeUnknownSync(CoreAuthorizeDatabaseOwnershipRpc.successSchema)(
  decodedValues[3],
)
const decodedShutdown = Schema.decodeUnknownSync(CoreShutdownRpc.successSchema)(decodedValues[4])
const decodedHostCapabilityRequest = Schema.decodeUnknownSync(CoreRequestContext)(decodedValues[5])
const decodedState = Schema.decodeUnknownSync(AppStateGetRpc.successSchema)(decodedValues[6])
const decodedFailure = Schema.decodeUnknownSync(AppStateGetRpc.errorSchema)(decodedValues[7])
const decodedAppStateDefect = Schema.decodeUnknownSync(AppStateGetDefectSchema)(decodedValues[8])
const decodedAdmissionFailure = Schema.decodeUnknownSync(AppStateGetAdmissionFailure)(
  decodedValues[9],
)

assert(decodedRequest.requestId === request.requestId, "Bun request identity roundtrip failed")
assert(
  decodedIdentityFailure.code === identityFailure.code,
  "Bun identity failure roundtrip failed",
)
assert(
  decodedAuthorizationRequest.authorizationId === authorizationRequest.authorizationId,
  "Bun ownership authorization request roundtrip failed",
)
assert(
  decodedAuthorized.authorizationId === authorized.authorizationId,
  "Bun ownership authorization acknowledgement roundtrip failed",
)
assert(decodedShutdown.lifecycle === "draining", "Bun shutdown acknowledgement roundtrip failed")
assert(
  decodedHostCapabilityRequest.requestId === hostCapabilityRequest.requestId,
  "Bun host-capability request identity roundtrip failed",
)
assert(decodedState.onboardingCompleted, "Bun AppState roundtrip failed")
assert(decodedFailure.code === failure.code, "Bun AppState failure roundtrip failed")
assert(!(decodedFailure instanceof Error), "Bun decoded a public failure as an Error instance")
assert(!("cause" in decodedFailure), "Bun public failure exposed a cause")
assert(!("stack" in decodedFailure), "Bun public failure exposed a stack")
assert(!("path" in decodedFailure), "Bun public failure exposed a path")
assert(
  typeof decodedAppStateDefect === "object" &&
    decodedAppStateDefect !== null &&
    "code" in decodedAppStateDefect &&
    decodedAppStateDefect.code === appStateDefect.code,
  "Bun AppState defect roundtrip failed",
)
assert(!("cause" in decodedAppStateDefect), "Bun AppState defect exposed a cause")
assert(!("stack" in decodedAppStateDefect), "Bun AppState defect exposed a stack")
assert(!("path" in decodedAppStateDefect), "Bun AppState defect exposed a path")
assert(
  decodedAdmissionFailure.code === admissionFailure.code,
  "Bun AppState admission failure roundtrip failed",
)

const boundedParser = RpcSerialization.makeMsgPack({ maxBufferSize: 2 }).makeUnsafe()
const incompleteFrame = Uint8Array.of(0xd9)
assert(
  boundedParser.decode(incompleteFrame).length === 0,
  "First incomplete frame must be buffered",
)
assert(
  boundedParser.decode(incompleteFrame).length === 0,
  "Second incomplete frame must be buffered",
)
let bounded = false
try {
  boundedParser.decode(incompleteFrame)
} catch (error) {
  bounded = error instanceof RpcSerialization.MaxBufferSizeExceeded
}
assert(bounded, "Bun native MessagePack must bound incomplete input")
