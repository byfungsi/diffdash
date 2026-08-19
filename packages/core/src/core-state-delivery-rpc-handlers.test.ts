import {
  CoreCommandAcknowledgement,
  CoreCommandListRequest,
  CoreEventReplayRequest,
  CoreEventSequence,
  CoreStateVersion,
} from "@diffdash/core-rpc/event"
import { CoreStateDeliveryRpcs } from "@diffdash/core-rpc/event-rpc"
import {
  ApplicationInstanceId,
  CoreCommandId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import {
  CoreCommandAcknowledgementRejectedError,
  StoredCoreCommand,
} from "@diffdash/persistence/core-command-store"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { CoreDurableCommandService } from "./core-durable-command-coordinator"
import { CoreEventHub, makeCoreEventHubLayer } from "./core-event-hub"
import { CoreLifecycle, coreLifecycleLayer } from "./core-lifecycle"
import { coreRpcAdmissionLayer } from "./core-rpc-admission"
import { coreStateDeliveryRpcHandlersLayer } from "./core-state-delivery-rpc-handlers"

const identity = {
  applicationInstanceId: ApplicationInstanceId.make("app-state-delivery"),
  processEpoch: CoreProcessEpoch.make("epoch-state-delivery"),
} as const
const context = HostRequestContext.make({
  ...identity,
  requestId: HostRequestId.make("h:state-delivery"),
})
const storedCommand = Schema.decodeUnknownSync(StoredCoreCommand)({
  commandId: "command-state-delivery",
  processEpoch: identity.processEpoch,
  metadata: { name: "refresh", scope: null },
  state: "committed",
  stateVersion: 2,
  acceptedAt: "2026-08-16T00:00:00.000Z",
  terminalAt: "2026-08-16T00:00:01.000Z",
  acknowledgedAt: null,
})

const ready = Effect.gen(function* () {
  const lifecycle = yield* CoreLifecycle
  yield* lifecycle.awaitOwnershipAuthorization
  yield* lifecycle.authorizeDatabaseOwnership(
    AuthorizeDatabaseOwnershipRequest.make({
      ...context,
      authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-state-delivery"),
    }),
  )
  yield* lifecycle.completeRecovery
})

const makeTestLayer = (command: Ref.Ref<StoredCoreCommand>) => {
  const commandLayer = Layer.succeed(
    CoreDurableCommandService,
    CoreDurableCommandService.of({
      execute: () => Effect.die("not used"),
      get: (commandId) =>
        Ref.get(command).pipe(
          Effect.map((current) =>
            current.commandId === commandId ? Option.some(current) : Option.none(),
          ),
        ),
      queryUnacknowledgedTerminal: () => Ref.get(command).pipe(Effect.map((current) => [current])),
      acknowledge: (commandId, stateVersion) =>
        Ref.get(command).pipe(
          Effect.flatMap((current) => {
            if (
              current.commandId === commandId &&
              current.state === "acknowledged" &&
              current.stateVersion === stateVersion + 1
            ) {
              return Effect.fail(
                CoreCommandAcknowledgementRejectedError.make({
                  commandId,
                  acknowledgedVersion: stateVersion,
                  currentState: current.state,
                  currentStateVersion: current.stateVersion,
                  reason: "alreadyAcknowledged",
                  message: "The command was already acknowledged.",
                }),
              )
            }
            if (current.commandId !== commandId || current.stateVersion !== stateVersion)
              return Effect.die("invalid acknowledgement fixture")
            return Ref.set(
              command,
              Schema.decodeUnknownSync(StoredCoreCommand)({
                ...current,
                state: "acknowledged",
                stateVersion: 3,
                acknowledgedAt: "2026-08-16T00:00:02.000Z",
              }),
            ).pipe(Effect.andThen(Ref.get(command)))
          }),
        ),
      recoverInterrupted: () => Effect.succeed([]),
    }),
  )
  const dependencies = Layer.mergeAll(
    coreLifecycleLayer(identity),
    makeCoreEventHubLayer(identity),
    commandLayer,
  )
  return Layer.merge(coreStateDeliveryRpcHandlersLayer, coreRpcAdmissionLayer).pipe(
    Layer.provideMerge(dependencies),
  )
}

describe("Core state delivery RPC handlers", () => {
  it.effect("replays after reconnect and acknowledges authoritative terminal state", () =>
    Effect.gen(function* () {
      const command = yield* Ref.make(storedCommand)
      return yield* Effect.gen(function* () {
        yield* ready
        const client = yield* RpcTest.makeClient(CoreStateDeliveryRpcs)
        const events = yield* CoreEventHub
        yield* events.publish({
          topic: "review.operation.progress",
          schemaVersion: 1,
          scopes: [],
          source: "review-agent",
          reason: "state-transition",
          subject: { kind: "operation", operationId: "operation-1" },
          kind: "operationProgress",
          stateVersion: 1,
        })
        yield* events.publish({
          topic: "review.operation.terminal",
          schemaVersion: 1,
          scopes: [],
          source: "review-agent",
          reason: "terminal-state-committed",
          subject: { kind: "operation", operationId: "operation-1" },
          kind: "operationTerminal",
          stateVersion: 2,
        })

        const replay = yield* client["CoreEvents.replay"](
          CoreEventReplayRequest.make({
            context,
            cursor: {
              processEpoch: context.processEpoch,
              sequence: CoreEventSequence.make(1),
            },
          }),
        )
        expect(replay).toMatchObject({ kind: "replay", events: [{ kind: "operationTerminal" }] })

        const pending = yield* client["CoreCommands.listUnacknowledged"](
          CoreCommandListRequest.make({ context, limit: 10 }),
        )
        expect(pending[0]).toMatchObject({ state: "committed", stateVersion: 2 })
        const acknowledged = yield* client["CoreCommands.acknowledge"](
          CoreCommandAcknowledgement.make({
            context,
            commandId: CoreCommandId.make("command-state-delivery"),
            stateVersion: CoreStateVersion.make(2),
          }),
        )
        expect(acknowledged).toMatchObject({ state: "acknowledged", stateVersion: 3 })
        const retried = yield* client["CoreCommands.acknowledge"](
          CoreCommandAcknowledgement.make({
            context,
            commandId: CoreCommandId.make("command-state-delivery"),
            stateVersion: CoreStateVersion.make(2),
          }),
        )
        expect(retried).toEqual(acknowledged)
      }).pipe(Effect.provide(makeTestLayer(command)))
    }),
  )

  it.effect("rejects a stale reconnect epoch before event replay", () =>
    Effect.gen(function* () {
      const command = yield* Ref.make(storedCommand)
      return yield* Effect.gen(function* () {
        yield* ready
        const client = yield* RpcTest.makeClient(CoreStateDeliveryRpcs)
        const restarted = yield* client["CoreEvents.replay"](
          CoreEventReplayRequest.make({
            context,
            cursor: {
              processEpoch: CoreProcessEpoch.make("epoch-before-restart"),
              sequence: CoreEventSequence.make(1),
            },
          }),
        )
        expect(restarted).toMatchObject({ kind: "resyncRequired", reason: "epochChanged" })
        const stale = yield* client["CoreEvents.replay"](
          CoreEventReplayRequest.make({
            context: HostRequestContext.make({
              ...context,
              processEpoch: CoreProcessEpoch.make("epoch-stale"),
            }),
            cursor: null,
          }),
        ).pipe(Effect.flip)
        expect(stale).toMatchObject({ code: "CORE_REQUEST_IDENTITY_MISMATCH" })
      }).pipe(Effect.provide(makeTestLayer(command)))
    }),
  )
})
