import { AppState } from "@diffdash/domain/app-state"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
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
import {
  CancelWalkthroughRequest,
  GetStoredWalkthroughRequest,
  GetStoredWalkthroughResult,
  GetWalkthroughOperationRequest,
  StartWalkthroughRequest,
  WalkthroughAttemptSummaries,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughPublicFailure,
  WalkthroughReviewGeneration,
  WalkthroughSafeDiagnostic,
} from "../src/walkthrough"

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
const mapPrivateAppStateDefectLayer = Layer.succeed(
  AppStateGetAdmissionMiddleware,
  (effect, options) =>
    Effect.gen(function* () {
      const context = yield* Schema.decodeUnknownEffect(HostRequestContext)(options.payload).pipe(
        Effect.orDie,
      )
      return yield* effect.pipe(
        Effect.catchDefect(() =>
          Effect.die(
            AppStateGetDefect.make({
              code: "APP_STATE_INTERNAL_ERROR",
              method: "AppState.get",
              applicationInstanceId: context.applicationInstanceId,
              processEpoch: context.processEpoch,
              requestId: context.requestId,
              retryClass: "notRetryable",
              safeMessage: "DiffDash Core encountered an internal application-state error.",
            }),
          ),
        ),
      )
    }),
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
    "AppState.get": () => Effect.die(new Error("private /Users/example/repository/path")),
  })
  const defectClient = yield* RpcTest.makeClient(CoreBusinessRpcs).pipe(
    Effect.provide(defectHandlers),
    Effect.provide(mapPrivateAppStateDefectLayer),
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
const appStateExitCodec = Schema.toCodecJson(Rpc.exitSchema(AppStateGetRpc))
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
  Schema.encodeSync(appStateExitCodec)(Exit.die(appStateDefect)),
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
const decodedDefectExit = Schema.decodeUnknownSync(appStateExitCodec)(decodedValues[10])

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
assert(Exit.isFailure(decodedDefectExit), "Bun AppState defect exit roundtrip failed")
if (Exit.isSuccess(decodedDefectExit)) throw new Error("Expected Bun AppState defect exit")
const decodedExitDefect = Cause.squash(decodedDefectExit.cause)
assert(
  typeof decodedExitDefect === "object" &&
    decodedExitDefect !== null &&
    "code" in decodedExitDefect &&
    decodedExitDefect.code === appStateDefect.code,
  "Bun AppState defect exit identity roundtrip failed",
)
assert(!("cause" in decodedExitDefect), "Bun AppState defect exit exposed a cause")
assert(!("stack" in decodedExitDefect), "Bun AppState defect exit exposed a stack")
assert(!("path" in decodedExitDefect), "Bun AppState defect exit exposed a path")

const walkthroughReviewGeneration = Schema.decodeUnknownSync(WalkthroughReviewGeneration)({
  kind: "local",
  projectId: "project-bun",
  snapshotId: "snapshot:v1:0123456789abcdef0123456789abcdef",
  reviewKey: "local:project-bun:working-tree",
  baseRevision: "base-bun",
  headRevision: "head-bun",
})
const walkthroughAttempts = Schema.decodeUnknownSync(WalkthroughAttemptSummaries)([
  {
    stage: "execute",
    outcome: "provider-exit",
    providerId: "claude",
    modelId: "claude-opus-5",
    attempt: 1,
  },
])
const walkthroughStart = Schema.decodeUnknownSync(StartWalkthroughRequest)({
  ...request,
  reviewGeneration: walkthroughReviewGeneration,
  regenerate: false,
  idempotencyKey: "w:bun-intent",
})
const walkthroughAccepted = Schema.decodeUnknownSync(WalkthroughOperationAccepted)({
  ...request,
  operationId: "walkthrough-operation-bun",
  stateVersion: 1,
  created: true,
})
const walkthroughGetOperation = GetWalkthroughOperationRequest.make({
  ...request,
  operationId: walkthroughAccepted.operationId,
})
const walkthroughCancel = CancelWalkthroughRequest.make({
  ...request,
  operationId: walkthroughAccepted.operationId,
})
const walkthroughGetStored = GetStoredWalkthroughRequest.make({
  ...request,
  reviewGeneration: walkthroughReviewGeneration,
  promptVersion: "walkthrough-v4",
})
const walkthroughStoredResult = Schema.decodeUnknownSync(GetStoredWalkthroughResult)({
  status: "notFound",
  reviewGeneration: walkthroughReviewGeneration,
  promptVersion: "walkthrough-v4",
})
const walkthroughOperation = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
  acceptedRequest: request,
  operationId: walkthroughAccepted.operationId,
  stateVersion: walkthroughAccepted.stateVersion,
  idempotencyKey: walkthroughStart.idempotencyKey,
  reviewGeneration: walkthroughReviewGeneration,
  promptVersion: "walkthrough-v4",
  configuredRoute: { mode: "auto", quality: "balanced" },
  candidatePlanFingerprint: `walkthrough-plan:v1:${"a".repeat(64)}`,
  attempts: walkthroughAttempts,
  acceptedAt: "2026-08-14T12:00:00.000Z",
  updatedAt: "2026-08-14T12:00:01.000Z",
  state: "active",
  phase: "falling-back",
})
const walkthroughFailure = Schema.decodeUnknownSync(WalkthroughPublicFailure)({
  _tag: "WalkthroughPublicFailure",
  ...request,
  method: "Walkthroughs.start",
  operationId: walkthroughAccepted.operationId,
  code: "AGENT_PROVIDER_EXIT",
  providerId: "claude",
  modelId: "claude-opus-5",
  retryClass: "userAction",
  remediation: "reauthenticateProvider",
  safeMessage: "Provider Claude exited before completing walkthrough generation.",
  attempts: walkthroughAttempts,
  diagnostic: {
    causeTags: ["AgentProviderOperationError", "ProcessExitError"],
    exitCode: 1,
    signal: null,
    providerExcerpt: "Authentication required.\nRun Claude and sign in.",
    internalFrames: ["WalkthroughService.generate", "executeWalkthroughCandidate"],
    truncated: false,
  },
})
const encodedWalkthroughValues = [
  Schema.encodeSync(StartWalkthroughRequest)(walkthroughStart),
  Schema.encodeSync(WalkthroughOperationAccepted)(walkthroughAccepted),
  Schema.encodeSync(GetWalkthroughOperationRequest)(walkthroughGetOperation),
  Schema.encodeSync(CancelWalkthroughRequest)(walkthroughCancel),
  Schema.encodeSync(GetStoredWalkthroughRequest)(walkthroughGetStored),
  Schema.encodeSync(GetStoredWalkthroughResult)(walkthroughStoredResult),
  Schema.encodeSync(WalkthroughOperationSnapshot)(walkthroughOperation),
  Schema.encodeSync(WalkthroughPublicFailure)(walkthroughFailure),
]
const decodedWalkthroughValues = encodedWalkthroughValues.flatMap((value) => {
  const bytes = parser.encode(value)
  assert(bytes instanceof Uint8Array, "Bun walkthrough MessagePack must encode binary frames")
  return parser.decode(bytes)
})
const decodedWalkthroughStart = Schema.decodeUnknownSync(StartWalkthroughRequest)(
  decodedWalkthroughValues[0],
)
const decodedWalkthroughAccepted = Schema.decodeUnknownSync(WalkthroughOperationAccepted)(
  decodedWalkthroughValues[1],
)
const decodedWalkthroughGetOperation = Schema.decodeUnknownSync(GetWalkthroughOperationRequest)(
  decodedWalkthroughValues[2],
)
const decodedWalkthroughCancel = Schema.decodeUnknownSync(CancelWalkthroughRequest)(
  decodedWalkthroughValues[3],
)
const decodedWalkthroughGetStored = Schema.decodeUnknownSync(GetStoredWalkthroughRequest)(
  decodedWalkthroughValues[4],
)
const decodedWalkthroughStoredResult = Schema.decodeUnknownSync(GetStoredWalkthroughResult)(
  decodedWalkthroughValues[5],
)
const decodedWalkthroughOperation = Schema.decodeUnknownSync(WalkthroughOperationSnapshot)(
  decodedWalkthroughValues[6],
)
const decodedWalkthroughFailure = Schema.decodeUnknownSync(WalkthroughPublicFailure)(
  decodedWalkthroughValues[7],
)
assert(
  decodedWalkthroughStart.idempotencyKey === walkthroughStart.idempotencyKey,
  "Bun walkthrough idempotency identity roundtrip failed",
)
assert(
  decodedWalkthroughAccepted.operationId === walkthroughAccepted.operationId,
  "Bun walkthrough operation identity roundtrip failed",
)
assert(
  decodedWalkthroughGetOperation.operationId === walkthroughAccepted.operationId &&
    decodedWalkthroughCancel.operationId === walkthroughAccepted.operationId,
  "Bun walkthrough operation request roundtrip failed",
)
assert(
  decodedWalkthroughGetStored.promptVersion === "walkthrough-v4" &&
    decodedWalkthroughStoredResult.status === "notFound",
  "Bun walkthrough stored lookup roundtrip failed",
)
assert(
  decodedWalkthroughOperation.state === "active" &&
    decodedWalkthroughOperation.phase === "falling-back",
  "Bun walkthrough operation state roundtrip failed",
)
assert(
  decodedWalkthroughFailure.code === "AGENT_PROVIDER_EXIT",
  "Bun walkthrough failure roundtrip failed",
)
assert(!(decodedWalkthroughFailure instanceof Error), "Bun walkthrough failure became an Error")
assert(!("cause" in decodedWalkthroughFailure), "Bun walkthrough failure exposed a cause")
assert(!("stack" in decodedWalkthroughFailure), "Bun walkthrough failure exposed a stack")
assert(!("path" in decodedWalkthroughFailure), "Bun walkthrough failure exposed a path")
assert(
  Result.isFailure(
    Schema.decodeUnknownResult(WalkthroughPublicFailure)({
      ...walkthroughFailure,
      code: "UNKNOWN_RENDERER_ERROR",
    }),
  ),
  "Bun walkthrough failure accepted an unknown code",
)
assert(
  Result.isFailure(
    Schema.decodeUnknownResult(WalkthroughAttemptSummaries)(
      Array.from({ length: 33 }, () => ({
        stage: "probe",
        outcome: "ready",
        providerId: "claude",
        modelId: null,
        attempt: 1,
      })),
    ),
  ),
  "Bun walkthrough attempts exceeded their bound",
)
assert(
  Result.isFailure(
    Schema.decodeUnknownResult(WalkthroughSafeDiagnostic)({
      ...walkthroughFailure.diagnostic,
      providerExcerpt: "/Users/example/private/repository",
    }),
  ),
  "Bun walkthrough diagnostic accepted a private path",
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
