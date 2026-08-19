import {
  CoreCommandSnapshot,
  type CoreCommandQueryResult,
  CoreStateDeliveryFailure,
  type CoreStateDeliveryFailure as CoreStateDeliveryFailureType,
} from "@diffdash/core-rpc/event"
import { CoreStateDeliveryRpcs } from "@diffdash/core-rpc/event-rpc"
import {
  CoreCommandStoreError,
  type StoredCoreCommand,
} from "@diffdash/persistence/core-command-store"
import { Effect, Layer, Option, Schema } from "effect"

import { CoreRuntimeServices } from "./core-runtime-services"
import { coreRuntimeStateDeliveryLayer } from "./core-runtime-services"

/** Native handlers backed by the Core event hub and durable command authority. */
export const coreStateDeliveryRpcHandlersWithRuntimeLayer = CoreStateDeliveryRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    const commands = runtime.commands
    const events = runtime.events

    return {
      "CoreEvents.replay": (request) =>
        events.pipe(
          Effect.flatMap((hub) =>
            hub.replay(
              request.cursor?.processEpoch ?? request.context.processEpoch,
              request.cursor?.sequence ?? null,
            ),
          ),
        ),
      "CoreCommands.get": (request) =>
        Effect.gen(function* () {
          const store = yield* commands
          const command = yield* store.get(request.commandId)
          if (Option.isNone(command)) {
            const result: CoreCommandQueryResult = {
              kind: "notFound",
              commandId: request.commandId,
            }
            return result
          }
          const snapshot = yield* parseCommandSnapshot(
            command.value,
            request.context,
            "CoreCommands.get",
          )
          const result: CoreCommandQueryResult = { kind: "found", command: snapshot }
          return result
        }).pipe(
          Effect.mapError(() =>
            deliveryFailure(
              request.context,
              "CoreCommands.get",
              request.commandId,
              "CORE_STATE_DELIVERY_FAILED",
              "DiffDash Core could not query the durable command.",
            ),
          ),
        ),
      "CoreCommands.listUnacknowledged": (request) =>
        commands.pipe(
          Effect.flatMap((store) => store.queryUnacknowledgedTerminal(request.limit)),
          Effect.flatMap((stored) =>
            Effect.forEach(stored, (command) =>
              parseCommandSnapshot(command, request.context, "CoreCommands.listUnacknowledged"),
            ),
          ),
          Effect.mapError(() =>
            deliveryFailure(
              request.context,
              "CoreCommands.listUnacknowledged",
              null,
              "CORE_STATE_DELIVERY_FAILED",
              "DiffDash Core could not query unacknowledged commands.",
            ),
          ),
        ),
      "CoreCommands.acknowledge": (request) =>
        commands.pipe(
          Effect.flatMap((store) =>
            store.acknowledge(request.commandId, request.stateVersion).pipe(
              Effect.catchTag("CoreCommandAcknowledgementRejectedError", (error) =>
                error.reason === "alreadyAcknowledged" &&
                error.currentStateVersion === error.acknowledgedVersion + 1
                  ? store.get(request.commandId).pipe(
                      Effect.flatMap((command) =>
                        Option.match(command, {
                          onNone: () => Effect.fail(error),
                          onSome: (current) =>
                            current.state === "acknowledged"
                              ? Effect.succeed(current)
                              : Effect.fail(error),
                        }),
                      ),
                    )
                  : Effect.fail(error),
              ),
            ),
          ),
          Effect.flatMap((command) =>
            parseCommandSnapshot(command, request.context, "CoreCommands.acknowledge"),
          ),
          Effect.mapError((error) =>
            deliveryFailure(
              request.context,
              "CoreCommands.acknowledge",
              request.commandId,
              Schema.is(CoreCommandStoreError)(error)
                ? "CORE_STATE_DELIVERY_FAILED"
                : "CORE_COMMAND_ACKNOWLEDGEMENT_REJECTED",
              Schema.is(CoreCommandStoreError)(error)
                ? "DiffDash Core could not persist the command acknowledgement."
                : "The command acknowledgement did not match the current terminal state.",
            ),
          ),
        ),
    }
  }),
)

/** State-delivery handlers backed directly by already-composed event and command services. */
export const coreStateDeliveryRpcHandlersLayer = coreStateDeliveryRpcHandlersWithRuntimeLayer.pipe(
  Layer.provide(coreRuntimeStateDeliveryLayer),
)

const parseCommandSnapshot = (
  command: StoredCoreCommand,
  context: Parameters<typeof deliveryFailure>[0],
  method: CoreStateDeliveryFailureType["method"],
) =>
  Schema.decodeUnknownEffect(CoreCommandSnapshot)(command).pipe(
    Effect.mapError(() =>
      deliveryFailure(
        context,
        method,
        null,
        "CORE_STATE_DELIVERY_FAILED",
        "DiffDash Core could not decode authoritative command state.",
      ),
    ),
  )

const deliveryFailure = (
  context: {
    readonly applicationInstanceId: CoreStateDeliveryFailureType["applicationInstanceId"]
    readonly processEpoch: CoreStateDeliveryFailureType["processEpoch"]
    readonly requestId: CoreStateDeliveryFailureType["requestId"]
  },
  method: CoreStateDeliveryFailureType["method"],
  commandId: CoreStateDeliveryFailureType["commandId"],
  code: CoreStateDeliveryFailureType["code"],
  safeMessage: string,
): CoreStateDeliveryFailureType =>
  CoreStateDeliveryFailure.make({
    method,
    applicationInstanceId: context.applicationInstanceId,
    processEpoch: context.processEpoch,
    requestId: context.requestId,
    commandId,
    code,
    retryClass: code === "CORE_COMMAND_ACKNOWLEDGEMENT_REJECTED" ? "userAction" : "automatic",
    safeMessage,
  })
