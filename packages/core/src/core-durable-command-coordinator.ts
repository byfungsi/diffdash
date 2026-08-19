import { type CoreCommandId, type CoreCommandReceipt, CoreStateVersion } from "@diffdash/core-rpc"
import {
  type AcceptCoreCommandInput,
  type CoreCommandAcknowledgementRejectedError,
  type CoreCommandConflictError,
  type CoreCommandNotFoundError,
  CoreCommandStore,
  type CoreCommandStoreError,
  type StoredCoreCommand,
} from "@diffdash/persistence/core-command-store"
import { Context, Effect, Exit, FiberMap, Layer, Option, type Scope } from "effect"

import { CoreEventHub } from "./core-event-hub"

/** Expected acceptance failure returned before a command execution fiber starts. */
export type CoreDurableCommandAcceptanceError = CoreCommandConflictError | CoreCommandStoreError

/** Expected acknowledgement failure for a durable Core command. */
export type CoreDurableCommandAcknowledgementError =
  | CoreCommandAcknowledgementRejectedError
  | CoreCommandNotFoundError
  | CoreCommandStoreError

/** Durable command lifecycle exposed to Core RPC adapters. */
export interface CoreDurableCommandCoordinator {
  readonly execute: <E, R>(
    input: AcceptCoreCommandInput,
    command: Effect.Effect<void, E, R>,
  ) => Effect.Effect<CoreCommandReceipt, CoreDurableCommandAcceptanceError, R>
  readonly get: (
    commandId: CoreCommandId,
  ) => Effect.Effect<Option.Option<StoredCoreCommand>, CoreCommandStoreError>
  readonly queryUnacknowledgedTerminal: (
    limit?: number,
  ) => Effect.Effect<readonly StoredCoreCommand[], CoreCommandStoreError>
  readonly acknowledge: (
    commandId: CoreCommandId,
    stateVersion: CoreStateVersion,
  ) => Effect.Effect<StoredCoreCommand, CoreDurableCommandAcknowledgementError>
  readonly recoverInterrupted: () => Effect.Effect<
    readonly StoredCoreCommand[],
    CoreCommandStoreError
  >
}

/** Core authority for durable command execution, recovery, query, and acknowledgement. */
export class CoreDurableCommandService extends Context.Service<
  CoreDurableCommandService,
  CoreDurableCommandCoordinator
>()("@diffdash/core/CoreDurableCommandService") {}

/** Dependencies used to build a scoped durable command coordinator. */
export interface CoreDurableCommandCoordinatorOptions<HintError> {
  readonly store: CoreCommandStore["Service"]
  readonly publishCommittedHint: (command: StoredCoreCommand) => Effect.Effect<void, HintError>
}

/** Builds a scoped coordinator that commits command state before best-effort notification. */
export const makeCoreDurableCommandCoordinator = <HintError>(
  options: CoreDurableCommandCoordinatorOptions<HintError>,
): Effect.Effect<CoreDurableCommandCoordinator, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = yield* FiberMap.make<
      CoreCommandId,
      void,
      CoreCommandNotFoundError | CoreCommandStoreError
    >()

    const publishIsolated = Effect.fn("CoreDurableCommands.publishIsolated")(
      (command: StoredCoreCommand) =>
        Effect.exit(options.publishCommittedHint(command)).pipe(Effect.asVoid),
    )

    const executeWorker = Effect.fn("CoreDurableCommands.executeWorker")(
      <E, R>(accepted: StoredCoreCommand, command: Effect.Effect<void, E, R>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const execution = yield* Effect.exit(restore(command))
            const transition = Exit.isSuccess(execution)
              ? yield* options.store.commit({
                  commandId: accepted.commandId,
                  expectedStateVersion: accepted.stateVersion,
                })
              : yield* options.store.fail({
                  commandId: accepted.commandId,
                  expectedStateVersion: accepted.stateVersion,
                })
            if (transition.won) yield* publishIsolated(transition.command)
          }),
        ),
    )

    const recoverInterrupted = Effect.fn("CoreDurableCommands.recoverInterrupted")(function* () {
      const recovered = yield* options.store.recoverAcceptedAsFailed()
      yield* Effect.forEach(recovered, publishIsolated, { discard: true })
      return recovered
    })

    return {
      execute: Effect.fn("CoreDurableCommands.execute")(
        <E, R>(input: AcceptCoreCommandInput, command: Effect.Effect<void, E, R>) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const acceptance = yield* options.store.acceptOrGet(input)
              if (acceptance.command.state === "accepted") {
                yield* FiberMap.run(
                  active,
                  acceptance.command.commandId,
                  executeWorker(acceptance.command, command),
                  { onlyIfMissing: true },
                )
              }
              return toReceipt(acceptance.command)
            }),
          ),
      ),
      get: options.store.get,
      queryUnacknowledgedTerminal: options.store.listUnacknowledgedTerminal,
      acknowledge: Effect.fn("CoreDurableCommands.acknowledge")((commandId, stateVersion) =>
        options.store.acknowledge({ commandId, expectedStateVersion: stateVersion }),
      ),
      recoverInterrupted,
    }
  })

/** Production coordinator layer using SQLite authority and the Core hint hub. */
export const coreDurableCommandLayer = Layer.effect(
  CoreDurableCommandService,
  Effect.gen(function* () {
    const store = yield* CoreCommandStore
    const events = yield* CoreEventHub
    const coordinator = yield* makeCoreDurableCommandCoordinator({
      store,
      publishCommittedHint: (command) =>
        events
          .publish({
            topic: "core.command.committed",
            schemaVersion: 1,
            scopes: command.metadata.scope === null ? [] : [command.metadata.scope],
            source: "core-command",
            reason: "terminal-state-committed",
            subject: { kind: "none" },
            kind: "commandCommitted",
            stateVersion: command.stateVersion,
          })
          .pipe(Effect.asVoid),
    })
    yield* coordinator.recoverInterrupted()
    return CoreDurableCommandService.of(coordinator)
  }),
)

const toReceipt = (command: StoredCoreCommand): CoreCommandReceipt => ({
  commandId: command.commandId,
  processEpoch: command.processEpoch,
  state: command.state,
  stateVersion: command.stateVersion,
  acceptedAt: command.acceptedAt,
})
