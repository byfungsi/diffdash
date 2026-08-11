import { AppState } from "@diffdash/domain/app-state"
import { Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

import { AppStateGetRpc } from "../src/business"
import { CoreHealthRpc } from "../src/control"
import { AppStateReadFailure } from "../src/failure"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
  CoreRequestId,
  HostRequestContext,
  HostRequestId,
} from "../src/identity"

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
const failure = AppStateReadFailure.make({
  code: "APP_STATE_READ_FAILED",
  method: "AppState.get",
  applicationInstanceId: request.applicationInstanceId,
  processEpoch: request.processEpoch,
  requestId: request.requestId,
  retryClass: "userAction",
  safeMessage: "DiffDash could not read application state.",
})

const parser = RpcSerialization.makeMsgPack({ maxBufferSize: 4_096 }).makeUnsafe()
const encodedValues = [
  Schema.encodeSync(CoreHealthRpc.payloadSchema)(request),
  Schema.encodeSync(CoreRequestContext)(hostCapabilityRequest),
  Schema.encodeSync(AppStateGetRpc.successSchema)(state),
  Schema.encodeSync(AppStateGetRpc.errorSchema)(failure),
]
const decodedValues = encodedValues.flatMap((value) => {
  const bytes = parser.encode(value)
  assert(bytes instanceof Uint8Array, "Native MessagePack must encode binary frames under Bun")
  return parser.decode(bytes)
})

const decodedRequest = Schema.decodeUnknownSync(CoreHealthRpc.payloadSchema)(decodedValues[0])
const decodedHostCapabilityRequest = Schema.decodeUnknownSync(CoreRequestContext)(decodedValues[1])
const decodedState = Schema.decodeUnknownSync(AppStateGetRpc.successSchema)(decodedValues[2])
const decodedFailure = Schema.decodeUnknownSync(AppStateGetRpc.errorSchema)(decodedValues[3])

assert(decodedRequest.requestId === request.requestId, "Bun request identity roundtrip failed")
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
