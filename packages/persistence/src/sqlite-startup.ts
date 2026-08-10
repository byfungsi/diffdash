import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { DatabaseError, makeDatabase, toError } from "./database"
import {
  databaseRequiresMigration,
  readDatabaseUserVersion,
  runDatabaseMigrations,
} from "./database-migrations"
import {
  checkpointDatabase,
  cleanupSqliteBackup,
  makeSqliteBackupPaths,
  publishSqliteBackup,
} from "./sqlite-backup"

type SqliteRuntime = "DatabaseNode" | "DatabaseBun"

interface SqliteStartupOptions<Client extends SqlClient.SqlClient, E, R> {
  readonly runtime: SqliteRuntime
  readonly acquire: (databasePath: string) => Effect.Effect<Client, E, R>
  readonly createBackup: (client: Client, backupPath: string) => Effect.Effect<void, E, R>
  readonly verifyBackup: (backupPath: string, expectedVersion: number) => Effect.Effect<void, E, R>
}

/** Runs runtime-independent SQLite initialization around runtime-owned resources and backup operations. */
export const startupSqlite = <Client extends SqlClient.SqlClient, E, R>(
  databasePath: string,
  options: SqliteStartupOptions<Client, E, R>,
) =>
  Effect.fn(`${options.runtime}.startup`)(function* () {
    const existedBeforeOpen = existsSync(databasePath)
    mkdirSync(dirname(databasePath), { recursive: true })
    const client = yield* options.acquire(databasePath)
    const database = makeDatabase(client)

    yield* database.run("PRAGMA foreign_keys = ON")
    yield* database.run("PRAGMA busy_timeout = 5000")
    yield* backupBeforeMigration(client, databasePath, existedBeforeOpen, options)
    yield* runDatabaseMigrations(database)
    return client
  })()

const backupBeforeMigration = <Client extends SqlClient.SqlClient, E, R>(
  client: Client,
  databasePath: string,
  existedBeforeOpen: boolean,
  options: SqliteStartupOptions<Client, E, R>,
) =>
  Effect.fn(`${options.runtime}.backupBeforeMigration`)(function* () {
    const database = makeDatabase(client)
    if (!(yield* shouldBackup(database, existedBeforeOpen, options.runtime))) return

    const currentVersion = yield* readDatabaseUserVersion(database)
    const paths = makeSqliteBackupPaths(databasePath, currentVersion)
    yield* checkpointDatabase(database)
    yield* options.createBackup(client, paths.temporary).pipe(
      Effect.andThen(options.verifyBackup(paths.temporary, currentVersion)),
      Effect.onError(() => cleanupSqliteBackup(paths)),
    )
    yield* publishSqliteBackup(paths)
  })()

const shouldBackup = (
  database: ReturnType<typeof makeDatabase>,
  existedBeforeOpen: boolean,
  runtime: SqliteRuntime,
) =>
  Effect.fn(`${runtime}.shouldBackup`)(function* () {
    if (!(yield* databaseRequiresMigration(database))) return false
    if ((yield* readDatabaseUserVersion(database)) > 0) return true
    if (!existedBeforeOpen) return false
    return (
      (yield* database.all(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         LIMIT 1`,
      )).length > 0
    )
  })()

/** Maps all SQLite startup failures to the stable database open boundary. */
export const mapSqliteStartupError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new DatabaseError({
          operation: DiagnosticOperation.make("open"),
          cause: Schema.is(DatabaseError)(cause) ? cause.cause : toError(cause),
        }),
    ),
    Effect.catchDefect((cause) =>
      Effect.fail(
        new DatabaseError({ operation: DiagnosticOperation.make("open"), cause: toError(cause) }),
      ),
    ),
  )
