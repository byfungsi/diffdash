import { Array as EffectArray, Effect, Option, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"

/** Primitive values accepted as positional parameters by the SQLite adapters. */
export type SqlValue = string | number | bigint | boolean | Date | null | Int8Array | Uint8Array

/** Positional values bound to one raw SQL statement. */
export type SqlParams = ReadonlyArray<SqlValue>

/** Converts an infrastructure value into the concrete error type used by persistence failures. */
export const toError = <A>(cause: A): Error =>
  Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause))

/** Untrusted object row returned by a SQLite driver. */
export interface DatabaseRow {
  readonly [column: string]: SqlValue
}

/** Generic Effect SQL operations used by persistence adapters. */
export interface Database {
  /** Returns the first result row when the statement produces one. */
  readonly get: (
    statement: string,
    params?: SqlParams,
  ) => Effect.Effect<Option.Option<DatabaseRow>, SqlError>

  /** Returns every result row produced by the statement. */
  readonly all: (
    statement: string,
    params?: SqlParams,
  ) => Effect.Effect<ReadonlyArray<DatabaseRow>, SqlError>

  /** Executes a statement and discards driver-specific write metadata. */
  readonly run: (statement: string, params?: SqlParams) => Effect.Effect<void, SqlError>

  /** Runs an Effect program on the client's reserved transaction connection. */
  readonly transaction: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError | DatabaseError, R>
}

/** A typed SQLite startup or migration failure. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: DiagnosticOperation,
  cause: Schema.ErrorInstance(),
}) {}

class TransactionProgramDefect extends Schema.TaggedClass<TransactionProgramDefect>()(
  "TransactionProgramDefect",
  { cause: Schema.ErrorInstance() },
) {}

/** Adapts Effect's generic SQL client to DiffDash's raw-row persistence conventions. */
export const makeDatabase = (client: SqlClient.SqlClient): Database => ({
  get: (statement, params = []) =>
    client.unsafe<DatabaseRow>(statement, params).pipe(Effect.map(EffectArray.head)),
  all: (statement, params = []) => client.unsafe<DatabaseRow>(statement, params),
  run: (statement, params = []) =>
    client.unsafe<DatabaseRow>(statement, params).pipe(Effect.asVoid),
  transaction: (program) =>
    client
      .withTransaction(
        program.pipe(
          Effect.catchDefect((cause) =>
            Effect.die(TransactionProgramDefect.make({ cause: toError(cause) })),
          ),
        ),
      )
      .pipe(
        Effect.catchDefect((cause) =>
          Schema.is(TransactionProgramDefect)(cause)
            ? Effect.die(cause.cause)
            : Effect.fail(
                DatabaseError.make({
                  operation: DiagnosticOperation.make("transaction.finalize"),
                  cause: toError(cause),
                }),
              ),
        ),
      ),
})
