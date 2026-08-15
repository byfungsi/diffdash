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
import { Effect, Option, Schema } from "effect"

import { CoreDurableCommandService } from "./core-durable-command-coordinator"
import { CoreEventHub } from "./core-event-hub"

/** Native handlers backed by the Core event hub and durable command authority. */
export const coreStateDeliveryRpcHandlersLayer = CoreStateDeliveryRpcs.toLayer(
  Effect.gen(function* () {
    const events = yield* CoreEventHub
    const commands = yield* CoreDurableCommandService

    return {
      "CoreEvents.replay": (request) =>
        events.replay(request.context.processEpoch, request.afterSequence),
      "CoreCommands.get": (request) =>
        Effect.gen(function* () {
          const command = yield* commands.get(request.commandId)
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
        commands.queryUnacknowledgedTerminal(request.limit).pipe(
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
        commands.acknowledge(request.commandId, request.stateVersion).pipe(
          Effect.catchTag("CoreCommandAcknowledgementRejectedError", (error) =>
            error.reason === "alreadyAcknowledged" &&
            error.currentStateVersion === error.acknowledgedVersion + 1
              ? commands.get(request.commandId).pipe(
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
