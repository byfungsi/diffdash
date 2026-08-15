import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import {
  CoreCommandAcknowledgeAdmissionMiddleware,
  CoreCommandGetAdmissionMiddleware,
  CoreCommandListAdmissionMiddleware,
  CoreEventReplayAdmissionMiddleware,
} from "./admission"
import {
  CoreCommandAcknowledgement,
  CoreCommandSnapshot,
  CoreEventReplayRequest,
  CoreStateVersion,
} from "./event"
import { CoreStateDeliveryRpcs } from "./event-rpc"
import {
  ApplicationInstanceId,
  CoreCommandId,
  CoreProcessEpoch,
  HostRequestContext,
  HostRequestId,
} from "./identity"

const context = HostRequestContext.make({
  applicationInstanceId: ApplicationInstanceId.make("app-events"),
  processEpoch: CoreProcessEpoch.make("epoch-events"),
  requestId: HostRequestId.make("h:event-request"),
})
const command = Schema.decodeUnknownSync(CoreCommandSnapshot)({
  commandId: "command-events",
  processEpoch: context.processEpoch,
  metadata: { name: "refresh", scope: null },
  state: "acknowledged",
  stateVersion: 3,
  acceptedAt: "2026-08-16T00:00:00.000Z",
  terminalAt: "2026-08-16T00:00:01.000Z",
  acknowledgedAt: "2026-08-16T00:00:02.000Z",
})
const passAdmissionLayer = Layer.mergeAll(
  Layer.succeed(CoreEventReplayAdmissionMiddleware, (effect) => effect),
  Layer.succeed(CoreCommandGetAdmissionMiddleware, (effect) => effect),
  Layer.succeed(CoreCommandListAdmissionMiddleware, (effect) => effect),
  Layer.succeed(CoreCommandAcknowledgeAdmissionMiddleware, (effect) => effect),
)

describe("Core state delivery RPC declarations", () => {
  it.effect("roundtrips reconnect replay and authoritative command acknowledgement", () => {
    const handlers = CoreStateDeliveryRpcs.toLayer({
      "CoreEvents.replay": () =>
        Effect.succeed({
          kind: "resyncRequired",
          processEpoch: context.processEpoch,
          reason: "firstConnection",
        }),
      "CoreCommands.get": () => Effect.succeed({ kind: "found", command }),
      "CoreCommands.listUnacknowledged": () => Effect.succeed([]),
      "CoreCommands.acknowledge": () => Effect.succeed(command),
    })
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoreStateDeliveryRpcs)
      const replay = yield* client["CoreEvents.replay"](
        CoreEventReplayRequest.make({ context, afterSequence: null }),
      )
      const acknowledged = yield* client["CoreCommands.acknowledge"](
        CoreCommandAcknowledgement.make({
          context,
          commandId: CoreCommandId.make("command-events"),
          stateVersion: CoreStateVersion.make(2),
        }),
      )

      expect(replay).toMatchObject({ kind: "resyncRequired", reason: "firstConnection" })
      expect(acknowledged).toEqual(command)
    }).pipe(Effect.provide(handlers), Effect.provide(passAdmissionLayer))
  })

  it("roundtrips bounded state values through native MessagePack", () => {
    const parser = RpcSerialization.makeMsgPack({
      useRecords: true,
      maxBufferSize: 512 * 1_024,
    }).makeUnsafe()
    const values = [
      Schema.encodeSync(CoreEventReplayRequest)({ context, afterSequence: null }),
      Schema.encodeSync(CoreCommandSnapshot)(command),
    ]
    const decoded = values.flatMap((value) => {
      const bytes = parser.encode(value)
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected MessagePack bytes")
      return parser.decode(bytes)
    })

    expect(Schema.decodeUnknownSync(CoreEventReplayRequest)(decoded[0])).toEqual({
      context,
      afterSequence: null,
    })
    expect(Schema.decodeUnknownSync(CoreCommandSnapshot)(decoded[1])).toEqual(command)
  })
})
