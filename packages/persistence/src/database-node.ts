import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Context, Effect, Layer } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { makeDatabase } from "./database"
import { mapSqliteStartupError, startupSqlite } from "./sqlite-startup"
import { verifySqliteBackup } from "./sqlite-backup"

/** Provides a migrated generic SQL client backed by Node's built-in SQLite runtime. */
export const layer = (databasePath: string) =>
  Layer.effectContext(
    startupSqlite(databasePath, {
      runtime: "DatabaseNode",
      acquire: (path) => SqliteClient.make({ filename: path }),
      createBackup: (client, backupPath) => client.backup(backupPath),
      verifyBackup,
    }).pipe(
      Effect.map((client) => Context.make(SqlClient.SqlClient, client)),
      mapSqliteStartupError,
    ),
  ).pipe(Layer.provide(Reactivity.layer))

const verifyBackup = (backupPath: string, expectedVersion: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const backupClient = yield* SqliteClient.make({
        filename: backupPath,
        disableWAL: true,
      })
      yield* verifySqliteBackup(makeDatabase(backupClient), expectedVersion)
    }),
  )
