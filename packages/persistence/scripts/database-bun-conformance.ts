import { strict as assert } from "node:assert"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { makeDatabase } from "../src/database"
import * as DatabaseBun from "../src/database-bun"

class RollbackProbe extends Schema.TaggedError<RollbackProbe>()("RollbackProbe", {}) {}

const directory = mkdtempSync(join(tmpdir(), "diffdash-bun-sqlite-"))
const databasePath = join(directory, "diffdash.sqlite")

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(DatabaseBun.layer(databasePath))))

try {
  await run(
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      const database = makeDatabase(client)

      const version = yield* database.get("PRAGMA user_version")
      assert.equal(Option.getOrThrow(version).user_version, 13)

      const foreignKeys = yield* database.get("PRAGMA foreign_keys")
      assert.equal(Option.getOrThrow(foreignKeys).foreign_keys, 1)

      const journalMode = yield* database.get("PRAGMA journal_mode")
      assert.equal(Option.getOrThrow(journalMode).journal_mode, "wal")

      const busyTimeout = yield* database.get("PRAGMA busy_timeout")
      assert.equal(Option.getOrThrow(busyTimeout).timeout, 5_000)

      yield* database.run("CREATE TABLE transaction_probe (value TEXT NOT NULL)")
      yield* database
        .transaction(
          Effect.gen(function* () {
            yield* database.run("INSERT INTO transaction_probe (value) VALUES (?)", ["rollback"])
            return yield* RollbackProbe.make()
          }),
        )
        .pipe(Effect.flip)

      const rows = yield* database.all("SELECT value FROM transaction_probe")
      assert.equal(rows.length, 0)

      yield* database.run("PRAGMA user_version = 12")
      yield* database.run("DROP TABLE walkthrough_operations")
    }),
  )

  await run(
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)
      const version = yield* database.get("PRAGMA user_version")
      assert.equal(Option.getOrThrow(version).user_version, 13)
      const integrity = yield* database.get("PRAGMA quick_check")
      assert.equal(Option.getOrThrow(integrity).quick_check, "ok")
    }),
  )

  assert.equal(
    readdirSync(directory).some((name) => name.includes(".pre-migration-v12-")),
    true,
  )
} finally {
  rmSync(directory, { force: true, recursive: true })
}
