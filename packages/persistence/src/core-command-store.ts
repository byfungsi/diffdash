import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { PositiveInteger, UtcIsoTimestamp } from "@diffdash/domain/domain-scalar"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { type Database, type DatabaseRow, makeDatabase, toError } from "./database"

const BoundedCommandMetadata = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
)
const BoundedCommandScopeId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)
const BoundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)),
)
/** Durable command identity stored without depending on the Core RPC package. */
export const CoreCommandId = BoundedIdentity.pipe(Schema.brand("CoreCommandId"))
type CoreCommandIdType = typeof CoreCommandId.Type
/** Core process epoch persisted with a command acceptance record. */
export const CoreProcessEpoch = BoundedIdentity.pipe(Schema.brand("CoreProcessEpoch"))
type CoreProcessEpochType = typeof CoreProcessEpoch.Type
/** Monotonic durable command state version. */
export const CoreStateVersion = PositiveInteger.pipe(Schema.brand("CoreStateVersion"))
type CoreStateVersionType = typeof CoreStateVersion.Type
const CoreCommandState = Schema.Literals(["accepted", "committed", "failed", "acknowledged"])
type CoreCommandStateType = typeof CoreCommandState.Type

/** Privacy-safe metadata retained with a durable Core command. */
export const CoreCommandMetadata = Schema.Struct({
  name: BoundedCommandMetadata,
  scope: Schema.NullOr(
    Schema.Struct({
      name: BoundedCommandMetadata,
      id: BoundedCommandScopeId,
    }),
  ),
})

/** Privacy-safe metadata retained with a durable Core command. */
export type CoreCommandMetadata = typeof CoreCommandMetadata.Type

/** Authoritative durable Core command state. */
export const StoredCoreCommand = Schema.Struct({
  commandId: CoreCommandId,
  processEpoch: CoreProcessEpoch,
  metadata: CoreCommandMetadata,
  state: CoreCommandState,
  stateVersion: CoreStateVersion,
  acceptedAt: UtcIsoTimestamp,
  terminalAt: Schema.NullOr(UtcIsoTimestamp),
  acknowledgedAt: Schema.NullOr(UtcIsoTimestamp),
})

/** Authoritative durable Core command state. */
export type StoredCoreCommand = typeof StoredCoreCommand.Type

/** Input that durably accepts a Core command before its effect starts. */
export interface AcceptCoreCommandInput {
  readonly commandId: CoreCommandIdType
  readonly processEpoch: CoreProcessEpochType
  readonly metadata: CoreCommandMetadata
}

/** Result of idempotently accepting a Core command. */
export interface CoreCommandAcceptance {
  readonly created: boolean
  readonly command: StoredCoreCommand
}

/** Optimistic guard for a Core command terminal transition. */
export interface CoreCommandVersionGuard {
  readonly commandId: CoreCommandIdType
  readonly expectedStateVersion: CoreStateVersionType
}

/** Result of racing a terminal Core command transition. */
export interface CoreCommandTransition {
  readonly won: boolean
  readonly command: StoredCoreCommand
}

/** A requested durable Core command does not exist. */
export class CoreCommandNotFoundError extends Schema.TaggedError<CoreCommandNotFoundError>()(
  "CoreCommandNotFoundError",
  { commandId: CoreCommandId, message: Schema.String },
) {}

/** A Core command ID was reused with different immutable acceptance metadata. */
export class CoreCommandConflictError extends Schema.TaggedError<CoreCommandConflictError>()(
  "CoreCommandConflictError",
  { commandId: CoreCommandId, message: Schema.String },
) {}

/** An acknowledgement did not identify the current unacknowledged terminal version. */
export class CoreCommandAcknowledgementRejectedError extends Schema.TaggedError<CoreCommandAcknowledgementRejectedError>()(
  "CoreCommandAcknowledgementRejectedError",
  {
    commandId: CoreCommandId,
    acknowledgedVersion: CoreStateVersion,
    currentState: CoreCommandState,
    currentStateVersion: CoreStateVersion,
    reason: Schema.Literals(["notTerminal", "staleVersion", "alreadyAcknowledged"]),
    message: Schema.String,
  },
) {}

/** A database or row-decoding failure prevented a durable command operation. */
export class CoreCommandStoreError extends Schema.TaggedError<CoreCommandStoreError>()(
  "CoreCommandStoreError",
  {
    operation: DiagnosticOperation,
    message: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

type CoreCommandOperationError = CoreCommandNotFoundError | CoreCommandStoreError

const CoreCommandRow = Schema.Struct({
  id: CoreCommandId,
  process_epoch: CoreProcessEpoch,
  command_name: BoundedCommandMetadata,
  scope_name: Schema.NullOr(BoundedCommandMetadata),
  scope_id: Schema.NullOr(BoundedCommandScopeId),
  state: CoreCommandState,
  state_version: CoreStateVersion,
  accepted_at: UtcIsoTimestamp,
  terminal_at: Schema.NullOr(UtcIsoTimestamp),
  acknowledged_at: Schema.NullOr(UtcIsoTimestamp),
})

/** Durable acceptance, terminal-state, recovery, query, and acknowledgement authority for Core commands. */
export class CoreCommandStore extends Context.Service<
  CoreCommandStore,
  {
    readonly acceptOrGet: (
      input: AcceptCoreCommandInput,
    ) => Effect.Effect<CoreCommandAcceptance, CoreCommandConflictError | CoreCommandStoreError>
    readonly get: (
      commandId: CoreCommandIdType,
    ) => Effect.Effect<Option.Option<StoredCoreCommand>, CoreCommandStoreError>
    readonly commit: (
      guard: CoreCommandVersionGuard,
    ) => Effect.Effect<CoreCommandTransition, CoreCommandOperationError>
    readonly fail: (
      guard: CoreCommandVersionGuard,
    ) => Effect.Effect<CoreCommandTransition, CoreCommandOperationError>
    readonly acknowledge: (
      guard: CoreCommandVersionGuard,
    ) => Effect.Effect<
      StoredCoreCommand,
      CoreCommandOperationError | CoreCommandAcknowledgementRejectedError
    >
    readonly listUnacknowledgedTerminal: (
      limit?: number,
    ) => Effect.Effect<readonly StoredCoreCommand[], CoreCommandStoreError>
    readonly recoverAcceptedAsFailed: () => Effect.Effect<
      readonly StoredCoreCommand[],
      CoreCommandStoreError
    >
  }
>()("@diffdash/CoreCommandStore") {
  /** SQLite implementation backed by the shared migrated Core database. */
  static readonly layer = Layer.effect(
    CoreCommandStore,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)

      const get = Effect.fn("CoreCommandStore.get")((commandId: CoreCommandIdType) =>
        database.get(`${commandSelectSql} WHERE id = ?`, [commandId]).pipe(
          Effect.flatMap((row) => Option.map(row, decodeCommandRow).pipe(Effect.transposeOption)),
          Effect.mapError((cause) => storeError("get", cause)),
        ),
      )

      const transition = Effect.fn("CoreCommandStore.transition")(function* (
        operation: "commit" | "fail",
        guard: CoreCommandVersionGuard,
      ) {
        const now = timestamp(yield* DateTime.now)
        const target: CoreCommandStateType = operation === "commit" ? "committed" : "failed"
        return yield* database
          .transaction(
            Effect.gen(function* () {
              const current = yield* requireCommand(database, guard.commandId)
              if (
                current.state !== "accepted" ||
                current.stateVersion !== guard.expectedStateVersion
              )
                return { won: false, command: current }
              const row = yield* database.get(
                `UPDATE core_commands
                 SET state = ?, state_version = state_version + 1, terminal_at = ?
                 WHERE id = ? AND state = 'accepted' AND state_version = ?
                 RETURNING *`,
                [target, now, guard.commandId, guard.expectedStateVersion],
              )
              if (Option.isNone(row))
                return { won: false, command: yield* requireCommand(database, guard.commandId) }
              return { won: true, command: yield* decodeCommandRow(row.value) }
            }),
          )
          .pipe(mapOperationError(operation))
      })

      return CoreCommandStore.of({
        acceptOrGet: Effect.fn("CoreCommandStore.acceptOrGet")(
          function* (input) {
            const commandId = yield* Schema.decodeUnknownEffect(CoreCommandId)(input.commandId)
            const processEpoch = yield* Schema.decodeUnknownEffect(CoreProcessEpoch)(
              input.processEpoch,
            )
            const metadata = yield* Schema.decodeUnknownEffect(CoreCommandMetadata)(input.metadata)
            const now = timestamp(yield* DateTime.now)
            return yield* database.transaction(
              Effect.gen(function* () {
                const existing = yield* findCommand(database, commandId)
                if (Option.isSome(existing)) {
                  if (!sameAcceptance(existing.value, processEpoch, metadata))
                    return yield* CoreCommandConflictError.make({
                      commandId,
                      message: "Core command ID was reused with different acceptance metadata.",
                    })
                  return { created: false, command: existing.value }
                }
                const inserted = yield* database.get(
                  `INSERT INTO core_commands (
                     id, process_epoch, command_name, scope_name, scope_id,
                     state, state_version, accepted_at
                   ) VALUES (?, ?, ?, ?, ?, 'accepted', 1, ?)
                   ON CONFLICT(id) DO NOTHING
                   RETURNING *`,
                  [
                    commandId,
                    processEpoch,
                    metadata.name,
                    metadata.scope?.name ?? null,
                    metadata.scope?.id ?? null,
                    now,
                  ],
                )
                if (Option.isSome(inserted)) {
                  return { created: true, command: yield* decodeCommandRow(inserted.value) }
                }
                const concurrentlyAccepted = yield* requireCommand(database, commandId)
                if (!sameAcceptance(concurrentlyAccepted, processEpoch, metadata))
                  return yield* CoreCommandConflictError.make({
                    commandId,
                    message: "Core command ID was reused with different acceptance metadata.",
                  })
                return { created: false, command: concurrentlyAccepted }
              }),
            )
          },
          Effect.mapError((cause) =>
            Schema.is(CoreCommandConflictError)(cause) ? cause : storeError("acceptOrGet", cause),
          ),
        ),
        get,
        commit: (guard) => transition("commit", guard),
        fail: (guard) => transition("fail", guard),
        acknowledge: Effect.fn("CoreCommandStore.acknowledge")(function* (guard) {
          const now = timestamp(yield* DateTime.now)
          return yield* database
            .transaction(
              Effect.gen(function* () {
                const current = yield* requireCommand(database, guard.commandId)
                if (current.state !== "committed" && current.state !== "failed") {
                  return yield* acknowledgementRejected(
                    current,
                    guard.expectedStateVersion,
                    current.state === "acknowledged" ? "alreadyAcknowledged" : "notTerminal",
                  )
                }
                if (current.stateVersion !== guard.expectedStateVersion)
                  return yield* acknowledgementRejected(
                    current,
                    guard.expectedStateVersion,
                    "staleVersion",
                  )
                const row = yield* database.get(
                  `UPDATE core_commands
                   SET state = 'acknowledged', state_version = state_version + 1,
                       acknowledged_at = ?
                   WHERE id = ? AND state IN ('committed', 'failed') AND state_version = ?
                   RETURNING *`,
                  [now, guard.commandId, guard.expectedStateVersion],
                )
                if (Option.isSome(row)) return yield* decodeCommandRow(row.value)
                const latest = yield* requireCommand(database, guard.commandId)
                return yield* acknowledgementRejected(
                  latest,
                  guard.expectedStateVersion,
                  latest.state === "acknowledged" ? "alreadyAcknowledged" : "staleVersion",
                )
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                Schema.is(CoreCommandAcknowledgementRejectedError)(cause) ||
                Schema.is(CoreCommandNotFoundError)(cause)
                  ? cause
                  : storeError("acknowledge", cause),
              ),
            )
        }),
        listUnacknowledgedTerminal: Effect.fn("CoreCommandStore.listUnacknowledgedTerminal")(
          function* (requestedLimit = 256) {
            const limit = Math.max(1, Math.min(256, Math.trunc(requestedLimit)))
            return yield* database
              .all(
                `${commandSelectSql}
                 WHERE state IN ('committed', 'failed')
                 ORDER BY terminal_at, id LIMIT ?`,
                [limit],
              )
              .pipe(
                Effect.flatMap(decodeCommandRows),
                Effect.mapError((cause) => storeError("listUnacknowledgedTerminal", cause)),
              )
          },
        ),
        recoverAcceptedAsFailed: Effect.fn("CoreCommandStore.recoverAcceptedAsFailed")(
          function* () {
            const now = timestamp(yield* DateTime.now)
            return yield* database
              .transaction(
                Effect.gen(function* () {
                  const accepted = yield* database
                    .all(`${commandSelectSql} WHERE state = 'accepted' ORDER BY accepted_at, id`)
                    .pipe(Effect.flatMap(decodeCommandRows))
                  yield* database.run(
                    `UPDATE core_commands
                   SET state = 'failed', state_version = state_version + 1, terminal_at = ?
                   WHERE state = 'accepted'`,
                    [now],
                  )
                  return yield* Effect.forEach(accepted, ({ commandId }) =>
                    requireCommand(database, commandId),
                  )
                }),
              )
              .pipe(Effect.mapError((cause) => storeError("recoverAcceptedAsFailed", cause)))
          },
        ),
      })
    }),
  )
}

const commandSelectSql = `SELECT id, process_epoch, command_name, scope_name, scope_id,
  state, state_version, accepted_at, terminal_at, acknowledged_at FROM core_commands`

const findCommand = Effect.fn("CoreCommandStore.findCommand")(function* (
  database: Database,
  commandId: CoreCommandIdType,
) {
  const row = yield* database.get(`${commandSelectSql} WHERE id = ?`, [commandId])
  return yield* Option.map(row, decodeCommandRow).pipe(Effect.transposeOption)
})

const requireCommand = Effect.fn("CoreCommandStore.requireCommand")(function* (
  database: Database,
  commandId: CoreCommandIdType,
) {
  const command = yield* findCommand(database, commandId)
  return yield* Effect.fromOption(command, () =>
    CoreCommandNotFoundError.make({ commandId, message: "Durable Core command was not found." }),
  )
})

const decodeCommandRow = Effect.fn("CoreCommandStore.decodeCommandRow")(function* (
  input: DatabaseRow,
) {
  const row = yield* Schema.decodeUnknownEffect(CoreCommandRow)(input)
  return yield* Schema.decodeUnknownEffect(StoredCoreCommand)({
    commandId: row.id,
    processEpoch: row.process_epoch,
    metadata: {
      name: row.command_name,
      scope:
        row.scope_name === null || row.scope_id === null
          ? null
          : { name: row.scope_name, id: row.scope_id },
    },
    state: row.state,
    stateVersion: row.state_version,
    acceptedAt: row.accepted_at,
    terminalAt: row.terminal_at,
    acknowledgedAt: row.acknowledged_at,
  })
})

const decodeCommandRows = (rows: readonly DatabaseRow[]) => Effect.forEach(rows, decodeCommandRow)

const sameAcceptance = (
  command: StoredCoreCommand,
  processEpoch: CoreProcessEpochType,
  metadata: CoreCommandMetadata,
) =>
  command.processEpoch === processEpoch &&
  command.metadata.name === metadata.name &&
  command.metadata.scope?.name === metadata.scope?.name &&
  command.metadata.scope?.id === metadata.scope?.id

const acknowledgementRejected = (
  command: StoredCoreCommand,
  acknowledgedVersion: CoreStateVersionType,
  reason: CoreCommandAcknowledgementRejectedError["reason"],
) =>
  CoreCommandAcknowledgementRejectedError.make({
    commandId: command.commandId,
    acknowledgedVersion,
    currentState: command.state,
    currentStateVersion: command.stateVersion,
    reason,
    message: "Core command acknowledgement did not match the current terminal version.",
  })

const timestamp = (dateTime: DateTime.Utc) => UtcIsoTimestamp.make(DateTime.formatIso(dateTime))

const mapOperationError = (operation: string) =>
  Effect.mapError((cause) =>
    Schema.is(CoreCommandNotFoundError)(cause) ? cause : storeError(operation, cause),
  )

const storeError = <Cause>(
  operation: string,
  cause: Cause,
  normalize: (cause: Cause) => Error = toError,
) =>
  CoreCommandStoreError.make({
    operation: DiagnosticOperation.make(operation),
    message: `Core command persistence failed during ${operation}.`,
    cause: normalize(cause),
  })
