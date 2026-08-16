import { AppState } from "@diffdash/domain/app-state"
import { AgentModelId, AgentProviderId } from "@diffdash/domain/agent-provider"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  AppStateGetAdmissionMiddleware,
  CoreCommandAcknowledgeAdmissionMiddleware,
  CoreCommandGetAdmissionMiddleware,
  CoreCommandListAdmissionMiddleware,
  CoreEventReplayAdmissionMiddleware,
  CoreTransportAuthenticationMiddleware,
  WalkthroughCancelAdmissionMiddleware,
  WalkthroughGetOperationAdmissionMiddleware,
  WalkthroughGetStoredAdmissionMiddleware,
  WalkthroughStartAdmissionMiddleware,
} from "../src/admission"
import { AppStateBusinessRpcs, AppStateGetRpc } from "../src/business"
import { CoreAuthorizeDatabaseOwnershipRpc, CoreHealthRpc, CoreShutdownRpc } from "../src/control"
import {
  CoreEventGenerationId,
  CoreCommandAcknowledgement,
  CoreCommandListRequest,
  CoreCommandSnapshot,
  CoreEventMetadata,
  CoreEventOperationId,
  CoreEventReason,
  CoreEventSchemaVersion,
  CoreEventScopeId,
  CoreEventScopeName,
  CoreEventSequence,
  CoreEventSource,
  CoreEventTopic,
  CoreStateVersion,
} from "../src/event"
import { CoreStateDeliveryRpcs } from "../src/event-rpc"
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
  CoreCommandId,
  CoreEventId,
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
  WalkthroughAttemptSummary,
  WalkthroughCancelAdmissionFailure,
  WalkthroughCancelFailure,
  WalkthroughCancelResult,
  WalkthroughGetOperationAdmissionFailure,
  WalkthroughGetOperationFailure,
  WalkthroughGetStoredAdmissionFailure,
  WalkthroughGetStoredFailure,
  WalkthroughFailureCode,
  WalkthroughOperationAccepted,
  WalkthroughOperationSnapshot,
  WalkthroughPublicFailure,
  WalkthroughReviewGeneration,
  WalkthroughSafeDiagnostic,
  WalkthroughStartAdmissionFailure,
} from "../src/walkthrough"
import {
  WalkthroughBusinessRpcs,
  WalkthroughCancelDefect,
  WalkthroughCancelRpc,
  WalkthroughGetOperationDefect,
  WalkthroughGetOperationRpc,
  WalkthroughGetStoredDefect,
  WalkthroughGetStoredRpc,
  WalkthroughStartDefect,
  WalkthroughStartRpc,
} from "../src/walkthrough-rpc"

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
const eventOperationId = CoreEventOperationId.make("operation-bun")
const eventMetadata = CoreEventMetadata.make({
  eventId: CoreEventId.make("event-bun"),
  topic: CoreEventTopic.make("walkthrough.operation.progress"),
  schemaVersion: CoreEventSchemaVersion.make(1),
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  sequence: CoreEventSequence.make(1),
  timestamp: "2026-08-15T20:00:00.000Z",
  scopes: [
    {
      name: CoreEventScopeName.make("project"),
      id: CoreEventScopeId.make("project-bun"),
    },
  ],
  source: CoreEventSource.make("walkthrough-operation"),
  reason: CoreEventReason.make("state-transition"),
  subject: {
    kind: "generationOperation",
    generationId: CoreEventGenerationId.make("generation-bun"),
    operationId: eventOperationId,
  },
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

  const successHandlers = AppStateBusinessRpcs.toLayer({
    "AppState.get": () => Effect.succeed(state),
  })
  const successClient = yield* RpcTest.makeClient(AppStateBusinessRpcs).pipe(
    Effect.provide(successHandlers),
  )
  const successfulState = yield* successClient["AppState.get"](request)
  assert(successfulState.onboardingCompleted, "Bun native RPC success failed")

  const failureHandlers = AppStateBusinessRpcs.toLayer({
    "AppState.get": () => Effect.fail(failure),
  })
  const failureClient = yield* RpcTest.makeClient(AppStateBusinessRpcs).pipe(
    Effect.provide(failureHandlers),
  )
  const expectedFailure = yield* failureClient["AppState.get"](request).pipe(Effect.flip)
  assert(expectedFailure.code === failure.code, "Bun native RPC expected failure failed")
  assert(!(expectedFailure instanceof Error), "Bun native RPC returned an Error instance")
  assert(!("cause" in expectedFailure), "Bun native RPC failure exposed a cause")
  assert(!("stack" in expectedFailure), "Bun native RPC failure exposed a stack")
  assert(!("path" in expectedFailure), "Bun native RPC failure exposed a path")

  const defectHandlers = AppStateBusinessRpcs.toLayer({
    "AppState.get": () => Effect.die(new Error("private /Users/example/repository/path")),
  })
  const defectClient = yield* RpcTest.makeClient(AppStateBusinessRpcs).pipe(
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
  const interruptHandlers = AppStateBusinessRpcs.toLayer({
    "AppState.get": () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
  })
  const interruptClient = yield* RpcTest.makeClient(AppStateBusinessRpcs).pipe(
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
const eventMetadataBytes = parser.encode(Schema.encodeSync(CoreEventMetadata)(eventMetadata))
assert(
  eventMetadataBytes instanceof Uint8Array,
  "Bun Core event metadata must encode as MessagePack bytes",
)
const [decodedEventMetadataValue] = parser.decode(eventMetadataBytes)
const decodedEventMetadata = Schema.decodeUnknownSync(CoreEventMetadata)(decodedEventMetadataValue)
assert(
  JSON.stringify(decodedEventMetadata) === JSON.stringify(eventMetadata),
  "Bun Core event metadata roundtrip failed",
)
assert(
  Result.isFailure(
    Schema.decodeUnknownResult(CoreEventMetadata)({ ...eventMetadata, sequence: 0 }),
  ),
  "Bun Core event metadata accepted an invalid sequence",
)
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
    providerId: AgentProviderId.make("claude"),
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
const walkthroughCancelResult = Schema.decodeUnknownSync(WalkthroughCancelResult)({
  status: "alreadyCompleted",
  operation: Schema.decodeUnknownSync(WalkthroughOperationSnapshot)({
    ...walkthroughOperation,
    state: "interrupted",
    terminalAt: "2026-08-14T12:00:02.000Z",
  }),
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
const walkthroughStartFailure = Schema.decodeUnknownSync(WalkthroughStartRpc.errorSchema)(
  walkthroughFailure,
)
const walkthroughGetOperationFailure = Schema.decodeUnknownSync(WalkthroughGetOperationFailure)({
  _tag: "WalkthroughPublicFailure",
  ...request,
  method: "Walkthroughs.getOperation",
  operationId: walkthroughAccepted.operationId,
  code: "WALKTHROUGH_OPERATION_NOT_FOUND",
  providerId: null,
  modelId: null,
  retryClass: "notRetryable",
  remediation: "none",
  safeMessage: "The walkthrough operation was not found.",
  attempts: [],
  diagnostic: null,
})
const walkthroughCancelFailure = Schema.decodeUnknownSync(WalkthroughCancelFailure)({
  _tag: "WalkthroughPublicFailure",
  ...request,
  method: "Walkthroughs.cancel",
  operationId: walkthroughAccepted.operationId,
  code: "WALKTHROUGH_OPERATION_STORE",
  providerId: null,
  modelId: null,
  retryClass: "userAction",
  remediation: "retry",
  safeMessage: "DiffDash could not persist walkthrough cancellation.",
  attempts: [],
  diagnostic: null,
})
const walkthroughGetStoredFailure = Schema.decodeUnknownSync(WalkthroughGetStoredFailure)({
  _tag: "WalkthroughPublicFailure",
  ...request,
  method: "Walkthroughs.getStored",
  operationId: null,
  code: "WALKTHROUGH_STORE",
  providerId: null,
  modelId: null,
  retryClass: "userAction",
  remediation: "retry",
  safeMessage: "DiffDash could not read the stored walkthrough.",
  attempts: [],
  diagnostic: null,
})
const walkthroughStartAdmissionFailure = Schema.decodeUnknownSync(WalkthroughStartAdmissionFailure)(
  {
    _tag: "WalkthroughPublicFailure",
    ...request,
    method: "Walkthroughs.start",
    operationId: null,
    code: "CORE_DRAINING",
    providerId: null,
    modelId: null,
    retryClass: "automatic",
    remediation: "retry",
    safeMessage: "DiffDash Core is draining.",
    attempts: [],
    diagnostic: null,
  },
)
const walkthroughGetOperationAdmissionFailure = Schema.decodeUnknownSync(
  WalkthroughGetOperationAdmissionFailure,
)({
  ...walkthroughStartAdmissionFailure,
  method: "Walkthroughs.getOperation",
  operationId: walkthroughAccepted.operationId,
})
const walkthroughCancelAdmissionFailure = Schema.decodeUnknownSync(
  WalkthroughCancelAdmissionFailure,
)({
  ...walkthroughStartAdmissionFailure,
  method: "Walkthroughs.cancel",
  operationId: walkthroughAccepted.operationId,
})
const walkthroughGetStoredAdmissionFailure = Schema.decodeUnknownSync(
  WalkthroughGetStoredAdmissionFailure,
)({
  ...walkthroughStartAdmissionFailure,
  method: "Walkthroughs.getStored",
  operationId: null,
})
const walkthroughDefect = WalkthroughStartDefect.make({
  _tag: "WalkthroughPublicFailure",
  ...request,
  method: "Walkthroughs.start",
  operationId: walkthroughAccepted.operationId,
  code: "WALKTHROUGH_INTERNAL_ERROR",
  providerId: null,
  modelId: null,
  retryClass: "notRetryable",
  remediation: "contactSupport",
  safeMessage: "DiffDash Core encountered an internal walkthrough error.",
  attempts: walkthroughAttempts,
  diagnostic: null,
})
const walkthroughGetOperationDefect = WalkthroughGetOperationDefect.make({
  ...walkthroughDefect,
  method: "Walkthroughs.getOperation",
  operationId: walkthroughAccepted.operationId,
})
const walkthroughCancelDefect = WalkthroughCancelDefect.make({
  ...walkthroughDefect,
  method: "Walkthroughs.cancel",
  operationId: walkthroughAccepted.operationId,
})
const walkthroughGetStoredDefect = WalkthroughGetStoredDefect.make({
  ...walkthroughDefect,
  method: "Walkthroughs.getStored",
  operationId: null,
})
const passWalkthroughAdmissionLayer = Layer.mergeAll(
  Layer.succeed(WalkthroughStartAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughCancelAdmissionMiddleware, (effect) => effect),
  Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, (effect) => effect),
)

const walkthroughNativeRpcConformance = Effect.gen(function* () {
  const successHandlers = WalkthroughBusinessRpcs.toLayer({
    "Walkthroughs.start": () => Effect.succeed(walkthroughAccepted),
    "Walkthroughs.getOperation": () => Effect.succeed(walkthroughOperation),
    "Walkthroughs.cancel": () => Effect.succeed(walkthroughCancelResult),
    "Walkthroughs.getStored": () => Effect.succeed(walkthroughStoredResult),
  })
  const successClient = yield* RpcTest.makeClient(WalkthroughBusinessRpcs).pipe(
    Effect.provide(successHandlers),
  )
  const acceptedResult = yield* successClient["Walkthroughs.start"](walkthroughStart)
  const operationResult = yield* successClient["Walkthroughs.getOperation"](walkthroughGetOperation)
  const cancelResult = yield* successClient["Walkthroughs.cancel"](walkthroughCancel)
  const storedResult = yield* successClient["Walkthroughs.getStored"](walkthroughGetStored)
  assert(
    acceptedResult.operationId === walkthroughAccepted.operationId,
    "Bun walkthrough native RPC acceptance failed",
  )
  assert(
    operationResult.state === "active" && cancelResult.status === "alreadyCompleted",
    "Bun walkthrough native RPC operation result failed",
  )
  assert(storedResult.status === "notFound", "Bun walkthrough native RPC stored lookup failed")

  const failureHandlers = WalkthroughBusinessRpcs.toLayer({
    "Walkthroughs.start": () => Effect.fail(walkthroughStartFailure),
    "Walkthroughs.getOperation": () => Effect.fail(walkthroughGetOperationFailure),
    "Walkthroughs.cancel": () => Effect.fail(walkthroughCancelFailure),
    "Walkthroughs.getStored": () => Effect.fail(walkthroughGetStoredFailure),
  })
  const failureClient = yield* RpcTest.makeClient(WalkthroughBusinessRpcs).pipe(
    Effect.provide(failureHandlers),
  )
  const expectedStartFailure = yield* failureClient["Walkthroughs.start"](walkthroughStart).pipe(
    Effect.flip,
  )
  const expectedGetOperationFailure = yield* failureClient["Walkthroughs.getOperation"](
    walkthroughGetOperation,
  ).pipe(Effect.flip)
  const expectedCancelFailure = yield* failureClient["Walkthroughs.cancel"](walkthroughCancel).pipe(
    Effect.flip,
  )
  const expectedGetStoredFailure = yield* failureClient["Walkthroughs.getStored"](
    walkthroughGetStored,
  ).pipe(Effect.flip)
  assert(
    expectedStartFailure.code === "AGENT_PROVIDER_EXIT" &&
      expectedGetOperationFailure.code === "WALKTHROUGH_OPERATION_NOT_FOUND" &&
      expectedCancelFailure.code === "WALKTHROUGH_OPERATION_STORE" &&
      expectedGetStoredFailure.code === "WALKTHROUGH_STORE",
    "Bun walkthrough native RPC expected failures failed",
  )
  for (const expectedFailure of [
    expectedStartFailure,
    expectedGetOperationFailure,
    expectedCancelFailure,
    expectedGetStoredFailure,
  ]) {
    assert(!(expectedFailure instanceof Error), "Bun walkthrough expected failure became an Error")
  }

  const rejectAdmissionLayer = Layer.mergeAll(
    Layer.succeed(WalkthroughStartAdmissionMiddleware, () =>
      Effect.fail(walkthroughStartAdmissionFailure),
    ),
    Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, () =>
      Effect.fail(walkthroughGetOperationAdmissionFailure),
    ),
    Layer.succeed(WalkthroughCancelAdmissionMiddleware, () =>
      Effect.fail(walkthroughCancelAdmissionFailure),
    ),
    Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, () =>
      Effect.fail(walkthroughGetStoredAdmissionFailure),
    ),
  )
  const admissionClient = yield* RpcTest.makeClient(WalkthroughBusinessRpcs).pipe(
    Effect.provide(successHandlers),
    Effect.provide(rejectAdmissionLayer),
  )
  const admissionFailures = [
    yield* admissionClient["Walkthroughs.start"](walkthroughStart).pipe(Effect.flip),
    yield* admissionClient["Walkthroughs.getOperation"](walkthroughGetOperation).pipe(Effect.flip),
    yield* admissionClient["Walkthroughs.cancel"](walkthroughCancel).pipe(Effect.flip),
    yield* admissionClient["Walkthroughs.getStored"](walkthroughGetStored).pipe(Effect.flip),
  ]
  assert(
    admissionFailures.every((candidate) => candidate.code === "CORE_DRAINING"),
    "Bun walkthrough native RPC admission failures failed",
  )

  const defectHandlers = WalkthroughBusinessRpcs.toLayer({
    "Walkthroughs.start": () => Effect.die(new Error("private /Users/example/repository")),
    "Walkthroughs.getOperation": () => Effect.die(new Error("private operation defect")),
    "Walkthroughs.cancel": () => Effect.die(new Error("private cancellation defect")),
    "Walkthroughs.getStored": () => Effect.die(new Error("private stored defect")),
  })
  const defectAdmissionLayer = Layer.mergeAll(
    Layer.succeed(WalkthroughStartAdmissionMiddleware, (effect) =>
      effect.pipe(Effect.catchDefect(() => Effect.die(walkthroughDefect))),
    ),
    Layer.succeed(WalkthroughGetOperationAdmissionMiddleware, (effect) =>
      effect.pipe(Effect.catchDefect(() => Effect.die(walkthroughGetOperationDefect))),
    ),
    Layer.succeed(WalkthroughCancelAdmissionMiddleware, (effect) =>
      effect.pipe(Effect.catchDefect(() => Effect.die(walkthroughCancelDefect))),
    ),
    Layer.succeed(WalkthroughGetStoredAdmissionMiddleware, (effect) =>
      effect.pipe(Effect.catchDefect(() => Effect.die(walkthroughGetStoredDefect))),
    ),
  )
  const defectClient = yield* RpcTest.makeClient(WalkthroughBusinessRpcs).pipe(
    Effect.provide(defectHandlers),
    Effect.provide(defectAdmissionLayer),
  )
  const projectedStartDefect = yield* defectClient["Walkthroughs.start"](walkthroughStart).pipe(
    Effect.catchDefect(Effect.succeed),
  )
  const projectedGetOperationDefect = yield* defectClient["Walkthroughs.getOperation"](
    walkthroughGetOperation,
  ).pipe(Effect.catchDefect(Effect.succeed))
  const projectedCancelDefect = yield* defectClient["Walkthroughs.cancel"](walkthroughCancel).pipe(
    Effect.catchDefect(Effect.succeed),
  )
  const projectedGetStoredDefect = yield* defectClient["Walkthroughs.getStored"](
    walkthroughGetStored,
  ).pipe(Effect.catchDefect(Effect.succeed))
  assert(
    typeof projectedStartDefect === "object" &&
      projectedStartDefect !== null &&
      "method" in projectedStartDefect &&
      projectedStartDefect.method === "Walkthroughs.start" &&
      typeof projectedGetOperationDefect === "object" &&
      projectedGetOperationDefect !== null &&
      "method" in projectedGetOperationDefect &&
      projectedGetOperationDefect.method === "Walkthroughs.getOperation" &&
      typeof projectedCancelDefect === "object" &&
      projectedCancelDefect !== null &&
      "method" in projectedCancelDefect &&
      projectedCancelDefect.method === "Walkthroughs.cancel" &&
      typeof projectedGetStoredDefect === "object" &&
      projectedGetStoredDefect !== null &&
      "method" in projectedGetStoredDefect &&
      projectedGetStoredDefect.method === "Walkthroughs.getStored",
    "Bun walkthrough native RPC defect projections failed",
  )
  for (const projectedDefect of [
    projectedStartDefect,
    projectedGetOperationDefect,
    projectedCancelDefect,
    projectedGetStoredDefect,
  ]) {
    assert(typeof projectedDefect === "object" && projectedDefect !== null, "Expected defect")
    assert(!("cause" in projectedDefect), "Bun walkthrough defect exposed a cause")
    assert(!("stack" in projectedDefect), "Bun walkthrough defect exposed a stack")
    assert(!("path" in projectedDefect), "Bun walkthrough defect exposed a path")
  }
}).pipe(Effect.provide(passWalkthroughAdmissionLayer), Effect.scoped)

await Effect.runPromise(walkthroughNativeRpcConformance)

const bunCommand = Schema.decodeUnknownSync(CoreCommandSnapshot)({
  commandId: "command-bun",
  processEpoch: request.processEpoch,
  metadata: { name: "refresh", scope: null },
  state: "acknowledged",
  stateVersion: 3,
  acceptedAt: "2026-08-16T00:00:00.000Z",
  terminalAt: "2026-08-16T00:00:01.000Z",
  acknowledgedAt: "2026-08-16T00:00:02.000Z",
})
const passStateDeliveryAdmissionLayer = Layer.mergeAll(
  Layer.succeed(CoreEventReplayAdmissionMiddleware, (effect) => effect),
  Layer.succeed(CoreCommandGetAdmissionMiddleware, (effect) => effect),
  Layer.succeed(CoreCommandListAdmissionMiddleware, (effect) => effect),
  Layer.succeed(CoreCommandAcknowledgeAdmissionMiddleware, (effect) => effect),
)
const stateDeliveryConformance = Effect.gen(function* () {
  const handlers = CoreStateDeliveryRpcs.toLayer({
    "CoreEvents.replay": () =>
      Effect.succeed({
        kind: "resyncRequired",
        processEpoch: request.processEpoch,
        reason: "firstConnection",
      }),
    "CoreCommands.get": () => Effect.succeed({ kind: "found", command: bunCommand }),
    "CoreCommands.listUnacknowledged": () => Effect.succeed([bunCommand]),
    "CoreCommands.acknowledge": () => Effect.succeed(bunCommand),
  })
  const client = yield* RpcTest.makeClient(CoreStateDeliveryRpcs).pipe(Effect.provide(handlers))
  const replay = yield* client["CoreEvents.replay"]({ context: request, cursor: null })
  const listed = yield* client["CoreCommands.listUnacknowledged"](
    CoreCommandListRequest.make({ context: request, limit: 10 }),
  )
  const acknowledged = yield* client["CoreCommands.acknowledge"](
    CoreCommandAcknowledgement.make({
      context: request,
      commandId: CoreCommandId.make("command-bun"),
      stateVersion: CoreStateVersion.make(2),
    }),
  )
  assert(replay.kind === "resyncRequired", "Bun event replay RPC failed")
  assert(listed.length === 1, "Bun command query RPC failed")
  assert(acknowledged.state === "acknowledged", "Bun command acknowledgement RPC failed")
}).pipe(Effect.provide(passStateDeliveryAdmissionLayer), Effect.scoped)

await Effect.runPromise(stateDeliveryConformance)

const walkthroughExits = [
  [WalkthroughStartRpc, Exit.fail(walkthroughStartFailure)],
  [WalkthroughStartRpc, Exit.fail(walkthroughStartAdmissionFailure)],
  [WalkthroughStartRpc, Exit.die(walkthroughDefect)],
  [WalkthroughGetOperationRpc, Exit.fail(walkthroughGetOperationFailure)],
  [WalkthroughGetOperationRpc, Exit.fail(walkthroughGetOperationAdmissionFailure)],
  [WalkthroughGetOperationRpc, Exit.die(walkthroughGetOperationDefect)],
  [WalkthroughCancelRpc, Exit.fail(walkthroughCancelFailure)],
  [WalkthroughCancelRpc, Exit.fail(walkthroughCancelAdmissionFailure)],
  [WalkthroughCancelRpc, Exit.die(walkthroughCancelDefect)],
  [WalkthroughGetStoredRpc, Exit.fail(walkthroughGetStoredFailure)],
  [WalkthroughGetStoredRpc, Exit.fail(walkthroughGetStoredAdmissionFailure)],
  [WalkthroughGetStoredRpc, Exit.die(walkthroughGetStoredDefect)],
] as const
for (const [rpc, exit] of walkthroughExits) {
  const codec = Schema.toCodecJson(Rpc.exitSchema(rpc))
  const encoded = Schema.encodeSync(codec)(exit)
  const bytes = parser.encode(encoded)
  assert(bytes instanceof Uint8Array, "Bun walkthrough exit must encode as MessagePack bytes")
  const [decodedValue] = parser.decode(bytes)
  const decodedExit = Schema.decodeUnknownSync(codec)(decodedValue)
  assert(Exit.isFailure(decodedExit), "Bun walkthrough exit roundtrip failed")
  if (Exit.isSuccess(decodedExit)) throw new Error("Expected Bun walkthrough failure exit")
  const decodedCause = Cause.squash(decodedExit.cause)
  assert(!(decodedCause instanceof Error), "Bun walkthrough exit decoded an Error")
  assert(
    typeof decodedCause === "object" && decodedCause !== null,
    "Bun walkthrough exit did not decode a plain object",
  )
  assert(!("cause" in decodedCause), "Bun walkthrough exit exposed a cause")
  assert(!("stack" in decodedCause), "Bun walkthrough exit exposed a stack")
  assert(!("path" in decodedCause), "Bun walkthrough exit exposed a path")
}

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
const classifiedWalkthroughValues = [
  Schema.encodeSync(WalkthroughAttemptSummary)({
    stage: "probe",
    outcome: "probe-failed",
    providerId: AgentProviderId.make("claude"),
    modelId: null,
    attempt: 1,
  }),
  Schema.encodeSync(WalkthroughAttemptSummary)({
    stage: "execute",
    outcome: "usage-limited",
    providerId: AgentProviderId.make("claude"),
    modelId: AgentModelId.make("claude-opus-5"),
    attempt: 1,
  }),
  Schema.encodeSync(WalkthroughAttemptSummary)({
    stage: "execute",
    outcome: "output-too-large",
    providerId: AgentProviderId.make("claude"),
    modelId: AgentModelId.make("claude-opus-5"),
    attempt: 1,
  }),
]
for (const value of classifiedWalkthroughValues) {
  const bytes = parser.encode(value)
  assert(bytes instanceof Uint8Array, "Bun classified attempt must encode as MessagePack bytes")
  const [decoded] = parser.decode(bytes)
  Schema.decodeUnknownSync(WalkthroughAttemptSummary)(decoded)
}
for (const code of [
  "AGENT_PROVIDER_USAGE_LIMITED",
  "AGENT_PROVIDER_CONFIGURATION",
  "AGENT_PROVIDER_FAILURE",
  "WALKTHROUGH_REVIEW_RESOLUTION",
  "WALKTHROUGH_OPERATION_STATE_UNAVAILABLE",
] as const) {
  const bytes = parser.encode(Schema.encodeSync(WalkthroughFailureCode)(code))
  assert(
    bytes instanceof Uint8Array,
    "Bun walkthrough failure code must encode as MessagePack bytes",
  )
  const [decoded] = parser.decode(bytes)
  assert(
    Schema.decodeUnknownSync(WalkthroughFailureCode)(decoded) === code,
    "Bun walkthrough failure code roundtrip failed",
  )
}
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
