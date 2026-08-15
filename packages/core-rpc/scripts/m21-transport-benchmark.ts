import {
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_RPC_IN_FLIGHT_BYTES,
  CORE_RPC_MAX_CONCURRENCY,
  CORE_RPC_STREAM_ACK_WINDOW,
  CORE_RPC_STREAM_CHUNK_BYTES,
} from "../src/transport"
import { Deferred, Effect, Fiber } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

const RESPONSE_PAYLOAD_BYTES = 384 * 1_024
const CANCELLATION_WORK_MILLISECONDS = 25

declare const process: {
  readonly stdout: { readonly write: (value: string) => boolean }
}

const round = (value: number) => Math.round(value * 100) / 100
const milliseconds = (startedAt: number) => round(performance.now() - startedAt)
const parser = RpcSerialization.makeMsgPack({
  maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
}).makeUnsafe()

const malformedHeader = Uint8Array.of(0xdb, 0x7f, 0xff, 0xff, 0xff)
const malformedChunk = new Uint8Array(64 * 1_024)
const malformedStartedAt = performance.now()
let malformedBytes = malformedHeader.byteLength
let malformedRejected = false
parser.decode(malformedHeader)
while (!malformedRejected) {
  try {
    parser.decode(malformedChunk)
    malformedBytes += malformedChunk.byteLength
  } catch (error) {
    if (!(error instanceof RpcSerialization.MaxBufferSizeExceeded)) throw error
    malformedRejected = true
  }
}

const responseParser = RpcSerialization.makeMsgPack({
  maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
}).makeUnsafe()
const responsePayload = { payload: "x".repeat(RESPONSE_PAYLOAD_BYTES) }
const responseFrame = responseParser.encode(responsePayload)
if (!(responseFrame instanceof Uint8Array)) throw new Error("MessagePack did not encode bytes")
const slowConsumerStartedAt = performance.now()
const retainedFrames = Array.from({ length: CORE_RPC_MAX_CONCURRENCY }, () => responseFrame.slice())
const retainedBytes = retainedFrames.reduce((total, frame) => total + frame.byteLength, 0)
for (const frame of retainedFrames) responseParser.decode(frame)
const slowConsumerMilliseconds = milliseconds(slowConsumerStartedAt)

const cancellation = await Effect.runPromise(
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>()
    const interruptibleFiber = yield* Effect.never.pipe(
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    const interruptibleStartedAt = performance.now()
    yield* Fiber.interrupt(interruptibleFiber)
    yield* Deferred.await(interrupted)

    const uninterruptibleStarted = yield* Deferred.make<void>()
    const uninterruptibleFiber = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* Deferred.succeed(uninterruptibleStarted, undefined)
        yield* Effect.sleep(`${CANCELLATION_WORK_MILLISECONDS} millis`)
      }),
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(uninterruptibleStarted)
    const uninterruptibleStartedAt = performance.now()
    yield* Fiber.interrupt(uninterruptibleFiber)

    const detachedCompleted = yield* Deferred.make<void>()
    const detachedStartedAt = performance.now()
    yield* Effect.sleep(`${CANCELLATION_WORK_MILLISECONDS} millis`).pipe(
      Effect.andThen(Deferred.succeed(detachedCompleted, undefined)),
      Effect.forkDetach,
    )
    const detachedAcceptanceMilliseconds = milliseconds(detachedStartedAt)
    yield* Deferred.await(detachedCompleted)

    return {
      interruptibleLatencyMs: milliseconds(interruptibleStartedAt),
      uninterruptibleCompletionMs: milliseconds(uninterruptibleStartedAt),
      detachedAcceptanceMs: detachedAcceptanceMilliseconds,
      detachedCompletionMs: milliseconds(detachedStartedAt),
    }
  }).pipe(Effect.scoped),
)

const result = {
  fixtureId: "m21-walkthrough-unary-v1",
  limits: {
    frameBytes: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
    inFlightBytes: CORE_RPC_IN_FLIGHT_BYTES,
    concurrency: CORE_RPC_MAX_CONCURRENCY,
    streamChunkBytes: CORE_RPC_STREAM_CHUNK_BYTES,
    acknowledgementWindow: CORE_RPC_STREAM_ACK_WINDOW,
    walkthroughResponseBytes: RESPONSE_PAYLOAD_BYTES,
  },
  measurements: {
    malformed: {
      offeredBytesAtRejection: malformedBytes + malformedChunk.byteLength,
      rejectionMs: milliseconds(malformedStartedAt),
      rejectedWithTypedLimit: malformedRejected,
    },
    retentionModel: {
      retainedFrames: retainedFrames.length,
      encodedFrameBytes: responseFrame.byteLength,
      retainedBytes,
      encodeDecodeMs: slowConsumerMilliseconds,
    },
    cancellation,
  },
  pass: {
    malformedInputBounded: malformedRejected,
    retentionModelWithinInFlightBudget: retainedBytes <= CORE_RPC_IN_FLIGHT_BYTES,
    unaryHasNoChunkOrAckState:
      CORE_RPC_STREAM_CHUNK_BYTES === 0 && CORE_RPC_STREAM_ACK_WINDOW === 0,
    cancellationCompletes:
      cancellation.interruptibleLatencyMs < 250 &&
      cancellation.uninterruptibleCompletionMs >= CANCELLATION_WORK_MILLISECONDS - 2 &&
      cancellation.detachedCompletionMs >= CANCELLATION_WORK_MILLISECONDS - 2,
  },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (Object.values(result.pass).some((passed) => !passed)) throw new Error("M21 benchmark failed")
