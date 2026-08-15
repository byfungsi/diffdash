import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "@diffdash/core-rpc/identity"
import {
  CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  CORE_RPC_MAX_CONCURRENCY,
} from "@diffdash/core-rpc/transport"
import {
  GetStoredWalkthroughRequest,
  GetWalkthroughOperationRequest,
  WalkthroughReviewGeneration,
} from "@diffdash/core-rpc/walkthrough"
import {
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  WalkthroughOperationId,
  WalkthroughOperationPromptVersion,
} from "@diffdash/domain/walkthrough-operation"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Match, Option, Queue, Ref, Schema } from "effect"
import * as RpcMessage from "effect/unstable/rpc/RpcMessage"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

import { makeBoundedWalkthroughProtocol } from "./core-rpc-socket-host"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-transport-policy"),
  processEpoch: CoreProcessEpoch.make("epoch-transport-policy"),
  requestId: HostRequestId.make("h:transport-policy"),
} as const
const operationId = WalkthroughOperationId.make("operation-transport-policy")
const reviewGeneration = WalkthroughReviewGeneration.make({
  kind: "local",
  projectId: ReviewProjectId.make("project-transport-policy"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:0123456789abcdef0123456789abcdef"),
  reviewKey: ReviewKey.make("local:project-transport-policy:working-tree"),
  baseRevision: ReviewRevision.make("base-transport-policy"),
  headRevision: ReviewRevision.make("head-transport-policy"),
})
const getOperationPayload = GetWalkthroughOperationRequest.make({ ...identity, operationId })
const getStoredPayload = GetStoredWalkthroughRequest.make({
  ...identity,
  reviewGeneration,
  promptVersion: WalkthroughOperationPromptVersion.make("walkthrough-v4"),
})
const makeParser = () => RpcSerialization.makeMsgPack({ useRecords: true }).makeUnsafe()

const request = (
  id: string | number,
  tag: "Walkthroughs.getOperation" | "Walkthroughs.getStored",
  payload: typeof getOperationPayload | typeof getStoredPayload,
): RpcMessage.RequestEncoded => ({
  _tag: "Request",
  id,
  tag,
  payload,
  headers: [],
})

const success = (requestId: string | number, value: string): RpcMessage.ResponseExitEncoded => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value },
})

const encodedRequestPayloadBytes = (value: RpcMessage.RequestEncoded) => {
  const encoded = makeParser().encode(value.payload)
  if (!(encoded instanceof Uint8Array)) throw new Error("MessagePack did not encode request bytes")
  return encoded.byteLength
}

const encodedResponseBytes = (value: RpcMessage.FromServerEncoded) => {
  const encoded = makeParser().encode(value)
  if (!(encoded instanceof Uint8Array)) throw new Error("MessagePack did not encode response bytes")
  return encoded.byteLength
}

const paddedRequest = (
  id: string,
  tag: "Walkthroughs.getOperation" | "Walkthroughs.getStored",
  payload: typeof getOperationPayload | typeof getStoredPayload,
  targetBytes: number,
) => {
  let lower = 0
  let upper = targetBytes
  while (lower <= upper) {
    const padding = "x".repeat(Math.floor((lower + upper) / 2))
    const candidate = { ...request(id, tag, payload), payload: { ...payload, padding } }
    const encodedBytes = encodedRequestPayloadBytes(candidate)
    if (encodedBytes === targetBytes) return candidate
    if (encodedBytes < targetBytes) lower = padding.length + 1
    else upper = padding.length - 1
  }
  throw new Error("Could not construct an exact MessagePack request boundary")
}

const stringAtEncodedBytes = (targetBytes: number) => {
  let lower = 0
  let upper = targetBytes
  while (lower <= upper) {
    const length = Math.floor((lower + upper) / 2)
    const value = "x".repeat(length)
    const encoded = makeParser().encode(value)
    if (!(encoded instanceof Uint8Array))
      throw new Error("MessagePack did not encode response bytes")
    if (encoded.byteLength === targetBytes) return value
    if (encoded.byteLength < targetBytes) lower = length + 1
    else upper = length - 1
  }
  throw new Error("Could not construct an exact MessagePack response boundary")
}

const FailureCode = Schema.Struct({ code: Schema.String })

const failureCode = (response: RpcMessage.FromServerEncoded) =>
  Match.valueTags(response, {
    Chunk: () => null,
    Exit: ({ exit }) =>
      Match.valueTags(exit, {
        Success: () => null,
        Failure: ({ cause }) => {
          const failure = cause.find((item) =>
            Match.valueTags(item, {
              Fail: () => true,
              Die: () => false,
              Interrupt: () => false,
            }),
          )
          if (failure === undefined) return null
          return Match.valueTags(failure, {
            Fail: ({ error }) =>
              Option.match(Schema.decodeUnknownOption(FailureCode)(error), {
                onNone: () => null,
                onSome: ({ code }) => code,
              }),
            Die: () => null,
            Interrupt: () => null,
          })
        },
      }),
    Defect: () => null,
    Pong: () => null,
    ClientProtocolError: () => null,
  })

const isExit = (response: RpcMessage.FromServerEncoded) =>
  Match.valueTags(response, {
    Chunk: () => false,
    Exit: () => true,
    Defect: () => false,
    Pong: () => false,
    ClientProtocolError: () => false,
  })

const makeProtocol = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<RpcMessage.FromClientEncoded>()
  const sent = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
  const disconnects = yield* Queue.unbounded<number>()
  const protocol = RpcServer.Protocol.of({
    run: (handler) =>
      Effect.forever(Queue.take(incoming).pipe(Effect.flatMap((message) => handler(1, message)))),
    disconnects,
    send: (_clientId, response) => Queue.offer(sent, response).pipe(Effect.asVoid),
    end: () => Effect.void,
    clientIds: Effect.succeed(new Set([1])),
    initialMessage: Effect.succeed(Option.none()),
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: false,
  })
  const bounded = yield* makeBoundedWalkthroughProtocol().pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provide(RpcSerialization.layerMsgPackWith({ useRecords: true })),
  )
  return { bounded, incoming, sent }
})

describe("Walkthrough RPC transport policy", () => {
  it.effect("enforces exact method-specific request boundaries before dispatch", () =>
    Effect.gen(function* () {
      const { bounded, incoming, sent } = yield* makeProtocol
      const entered = yield* Ref.make(0)
      yield* bounded
        .run((_clientId, message) =>
          Match.valueTags(message, {
            Request: ({ id }) =>
              Ref.update(entered, (count) => count + 1).pipe(
                Effect.andThen(bounded.send(1, success(id, "ok"))),
              ),
            Ack: () => Effect.void,
            Interrupt: () => Effect.void,
            Ping: () => Effect.void,
            Eof: () => Effect.void,
          }),
        )
        .pipe(Effect.forkScoped)

      yield* Queue.offer(
        incoming,
        paddedRequest("exact", "Walkthroughs.getOperation", getOperationPayload, 2 * 1_024),
      )
      expect(isExit(yield* Queue.take(sent))).toBe(true)
      expect(yield* Ref.get(entered)).toBe(1)

      yield* Queue.offer(
        incoming,
        paddedRequest("oversized", "Walkthroughs.getOperation", getOperationPayload, 2 * 1_024 + 1),
      )
      const overflow = yield* Queue.take(sent)
      expect(failureCode(overflow)).toBe("REQUEST_TOO_LARGE")
      expect(encodedResponseBytes(overflow)).toBeLessThanOrEqual(64 * 1_024)
      expect(encodedResponseBytes(overflow)).toBeLessThanOrEqual(CORE_RPC_INCOMPLETE_BUFFER_BYTES)
      expect(yield* Ref.get(entered)).toBe(1)

      yield* Queue.offer(
        incoming,
        paddedRequest("larger-read", "Walkthroughs.getStored", getStoredPayload, 3 * 1_024),
      )
      expect(isExit(yield* Queue.take(sent))).toBe(true)
      expect(yield* Ref.get(entered)).toBe(2)
    }),
  )

  it.effect("replaces an oversized method response and releases its reservation", () =>
    Effect.gen(function* () {
      const { bounded, incoming, sent } = yield* makeProtocol
      const entered = yield* Ref.make(0)
      const exactResponse = stringAtEncodedBytes(384 * 1_024)
      const oversizedResponse = stringAtEncodedBytes(384 * 1_024 + 1)
      yield* bounded
        .run((_clientId, message) =>
          Match.valueTags(message, {
            Request: ({ id }) =>
              Ref.update(entered, (count) => count + 1).pipe(
                Effect.andThen(
                  bounded.send(
                    1,
                    success(id, id === "exact-response" ? exactResponse : oversizedResponse),
                  ),
                ),
              ),
            Ack: () => Effect.void,
            Interrupt: () => Effect.void,
            Ping: () => Effect.void,
            Eof: () => Effect.void,
          }),
        )
        .pipe(Effect.forkScoped)

      yield* Queue.offer(
        incoming,
        request("exact-response", "Walkthroughs.getStored", getStoredPayload),
      )
      expect(failureCode(yield* Queue.take(sent))).toBe(null)

      yield* Queue.offer(
        incoming,
        request("oversized-response", "Walkthroughs.getStored", getStoredPayload),
      )
      const overflow = yield* Queue.take(sent)
      expect(failureCode(overflow)).toBe("RESPONSE_TOO_LARGE")
      expect(encodedResponseBytes(overflow)).toBeLessThanOrEqual(384 * 1_024)
      expect(encodedResponseBytes(overflow)).toBeLessThanOrEqual(CORE_RPC_INCOMPLETE_BUFFER_BYTES)

      yield* Queue.offer(
        incoming,
        request("after-overflow", "Walkthroughs.getOperation", getOperationPayload),
      )
      yield* Queue.take(sent)
      expect(yield* Ref.get(entered)).toBe(3)
      expect(384 * 1_024 + 1).toBeLessThan(CORE_RPC_INCOMPLETE_BUFFER_BYTES)
    }),
  )

  it.effect("rejects duplicate live request IDs without releasing the original reservation", () =>
    Effect.gen(function* () {
      const { bounded, incoming, sent } = yield* makeProtocol
      const entered = yield* Ref.make(0)
      const saturated = yield* Deferred.make<void>()
      yield* bounded
        .run(() =>
          Ref.updateAndGet(entered, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === CORE_RPC_MAX_CONCURRENCY
                ? Deferred.succeed(saturated, undefined)
                : Effect.void,
            ),
          ),
        )
        .pipe(Effect.forkScoped)

      yield* Queue.offer(
        incoming,
        request("duplicate", "Walkthroughs.getOperation", getOperationPayload),
      )
      yield* Queue.offer(
        incoming,
        request("duplicate", "Walkthroughs.getOperation", getOperationPayload),
      )
      expect(isExit(yield* Queue.take(sent))).toBe(true)

      yield* Effect.forEach(
        Array.from({ length: CORE_RPC_MAX_CONCURRENCY - 1 }, (_, index) => index),
        (index) =>
          Queue.offer(
            incoming,
            request(`unique-${String(index)}`, "Walkthroughs.getOperation", getOperationPayload),
          ),
        { discard: true },
      )
      yield* Deferred.await(saturated)
      expect(yield* Ref.get(entered)).toBe(CORE_RPC_MAX_CONCURRENCY)

      yield* Queue.offer(
        incoming,
        request("overflow", "Walkthroughs.getOperation", getOperationPayload),
      )
      expect(isExit(yield* Queue.take(sent))).toBe(true)
      expect(yield* Ref.get(entered)).toBe(CORE_RPC_MAX_CONCURRENCY)
    }),
  )
})
