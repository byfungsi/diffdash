import BetterSqlite3, { type Database as BetterSqliteDatabase } from "better-sqlite3"
import { Context, Effect, Layer, Schema } from "effect"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

import { AppConfig } from "./app-config"
import { runDatabaseMigrations } from "./database-migrations"

type SqlParams = readonly unknown[] | Record<string, unknown>

/** Synchronous statements available inside one SQLite transaction callback. */
export interface DatabaseTransaction {
  readonly get: <A>(sql: string, params?: SqlParams) => A | undefined
  readonly all: <A>(sql: string, params?: SqlParams) => readonly A[]
  readonly run: (sql: string, params?: SqlParams) => void
}

/** A typed SQLite persistence failure. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

/** Main-process SQLite service with typed Effect errors. */
export class DatabaseService extends Context.Tag("@diffdash/DatabaseService")<
  DatabaseService,
  {
    readonly get: <A>(
      sql: string,
      params?: SqlParams,
    ) => Effect.Effect<A | undefined, DatabaseError>
    readonly all: <A>(sql: string, params?: SqlParams) => Effect.Effect<readonly A[], DatabaseError>
    readonly run: (sql: string, params?: SqlParams) => Effect.Effect<void, DatabaseError>
    readonly transaction: <A>(
      operation: string,
      execute: (transaction: DatabaseTransaction) => A,
    ) => Effect.Effect<A, DatabaseError>
  }
>() {
  static readonly layer = Layer.scoped(
    DatabaseService,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            mkdirSync(dirname(config.databasePath), { recursive: true })
            const database = new BetterSqlite3(config.databasePath)
            try {
              database.pragma("journal_mode = WAL")
              database.pragma("foreign_keys = ON")
              runDatabaseMigrations(database)
              return database
            } catch (cause) {
              database.close()
              throw cause
            }
          },
          catch: (cause) => DatabaseError.make({ operation: "open", cause }),
        }),
        (database) => Effect.sync(() => database.close()),
      )

      return DatabaseService.of({
        get: <A>(sql: string, params: SqlParams = []) =>
          runStatement(db, "get", () => {
            // SAFETY: Callers choose `A` at repository boundaries immediately before parsing rows into domain types.
            return db.prepare(sql).get(params) as A | undefined
          }),
        all: <A>(sql: string, params: SqlParams = []) =>
          runStatement(db, "all", () => {
            // SAFETY: Callers choose `A` at repository boundaries immediately before parsing rows into domain types.
            return db.prepare(sql).all(params) as readonly A[]
          }),
        run: (sql: string, params: SqlParams = []) =>
          runStatement(db, "run", () => {
            db.prepare(sql).run(params)
          }),
        transaction: <A>(operation: string, execute: (transaction: DatabaseTransaction) => A) =>
          runStatement(
            db,
            operation,
            db.transaction(() => executeTransaction(db, execute)),
          ),
      })
    }),
  )
}

const runStatement = <A>(_db: BetterSqliteDatabase, operation: string, execute: () => A) =>
  Effect.try({
    try: execute,
    catch: (cause) => DatabaseError.make({ operation, cause }),
  })

const executeTransaction = <A>(
  database: BetterSqliteDatabase,
  execute: (transaction: DatabaseTransaction) => A,
) => {
  let active = true
  try {
    const result = execute(makeTransaction(database, () => active))
    if (Effect.isEffect(result) || isPromiseLike(result)) {
      throw new Error("Database transaction callbacks must complete synchronously")
    }
    return result
  } finally {
    active = false
  }
}

const makeTransaction = (
  database: BetterSqliteDatabase,
  isActive: () => boolean,
): DatabaseTransaction => ({
  get: <A>(sql: string, params: SqlParams = []) => {
    assertTransactionActive(isActive)
    // SAFETY: Transaction callers parse rows at their repository boundary before returning domain values.
    return database.prepare(sql).get(params) as A | undefined
  },
  all: <A>(sql: string, params: SqlParams = []) => {
    assertTransactionActive(isActive)
    // SAFETY: Transaction callers parse rows at their repository boundary before returning domain values.
    return database.prepare(sql).all(params) as readonly A[]
  },
  run: (sql: string, params: SqlParams = []) => {
    assertTransactionActive(isActive)
    database.prepare(sql).run(params)
  },
})

const assertTransactionActive = (isActive: () => boolean) => {
  if (!isActive()) throw new Error("Database transaction handle used after its callback completed")
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && "then" in value && typeof value.then === "function"
