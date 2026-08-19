import { strict as assert } from "node:assert"
import { chmodSync, copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { hostedRepositoryInput, remoteOnlyRepositoryCheckout } from "@diffdash/domain/repository"
import { GitProviderId, makeHostedRepositoryLocator } from "@diffdash/domain/git-provider"
import { Effect, Layer, Option, Result, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"

import { type DatabaseError, makeDatabase } from "../database"
import { RepositoryStore } from "../repository-store"

const FeatureRow = Schema.Struct({
  json_value: Schema.String,
  sqlite_version: Schema.String,
  window_value: Schema.Number,
})
const PageCountRow = Schema.Struct({ page_count: Schema.Number })

/** Runs the shared store, transaction, migration, backup, and SQLite feature qualification. */
export const runDatabaseConformance = Effect.fn("DatabaseConformance.run")(function* (
  databasePath: string,
  makeLayer: (path: string) => Layer.Layer<SqlClient.SqlClient, DatabaseError>,
) {
  const layer = RepositoryStore.layer.pipe(Layer.provideMerge(makeLayer(databasePath)))
  yield* Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    const store = yield* RepositoryStore

    const features = Schema.decodeUnknownSync(FeatureRow)(
      Option.getOrThrow(
        yield* database.get(
          `SELECT
             json_extract('{"qualified":"yes"}', '$.qualified') AS json_value,
             sqlite_version() AS sqlite_version,
             row_number() OVER () AS window_value`,
        ),
      ),
    )
    assert.equal(features.json_value, "yes")
    assert.match(features.sqlite_version, /^3\./u)
    assert.equal(features.window_value, 1)

    assert.equal(Option.getOrThrow(yield* database.get("PRAGMA journal_mode")).journal_mode, "wal")
    assert.equal(Option.getOrThrow(yield* database.get("PRAGMA foreign_keys")).foreign_keys, 1)
    assert.equal(Option.getOrThrow(yield* database.get("PRAGMA busy_timeout")).timeout, 5_000)

    yield* database.run("CREATE TABLE strict_probe (value TEXT NOT NULL) STRICT")
    const strictFailure = yield* Effect.result(
      database.run("INSERT INTO strict_probe (value) VALUES (?)", [new Uint8Array([1])]),
    )
    assert.equal(Result.isFailure(strictFailure), true)
    if (Result.isFailure(strictFailure))
      assert.equal(SqlError.isSqlError(strictFailure.failure), true)

    const repository = yield* store.upsertRepository(
      hostedRepositoryInput(
        makeHostedRepositoryLocator(GitProviderId.make("github"), "fungsi", "conformance"),
        remoteOnlyRepositoryCheckout("https://github.com/fungsi/conformance"),
        "mark",
      ),
    )
    assert.equal(repository.isFavorite, true)
    assert.deepEqual(
      (yield* store.list()).map(({ id }) => id),
      [repository.id],
    )

    const rollback = yield* Effect.result(
      database.transaction(
        Effect.gen(function* () {
          yield* database.run("INSERT INTO strict_probe (value) VALUES ('rollback')")
          return yield* Effect.fail("rollback-probe" as const)
        }),
      ),
    )
    assert.equal(Result.isFailure(rollback), true)
    assert.equal((yield* database.all("SELECT value FROM strict_probe")).length, 0)

    const foreignKeyFailure = yield* Effect.result(
      database.run(
        `INSERT INTO hosted_viewed_files
         (repo_id, pr_number, base_ref_name, review_key, patch_hash, viewed_at)
         VALUES ('missing', 1, 'main', 'file', 'patch', '2026-08-16T00:00:00.000Z')`,
      ),
    )
    assert.equal(Result.isFailure(foreignKeyFailure), true)

    yield* database.run("CREATE TABLE disk_full_probe (payload BLOB NOT NULL)")
    const pageCount = Schema.decodeUnknownSync(PageCountRow)(
      Option.getOrThrow(yield* database.get("PRAGMA page_count")),
    ).page_count
    yield* database.run(`PRAGMA max_page_count = ${String(pageCount)}`)
    const diskFull = yield* Effect.result(
      database.run("INSERT INTO disk_full_probe VALUES (zeroblob(1048576))"),
    )
    assert.equal(Result.isFailure(diskFull), true)
    yield* database.run("PRAGMA max_page_count = 1073741823")

    const busyFailure = yield* Effect.result(
      database.transaction(
        Effect.gen(function* () {
          yield* database.run("INSERT INTO strict_probe (value) VALUES ('writer-one')")
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const competing = makeDatabase(yield* SqlClient.SqlClient)
              yield* competing.run("INSERT INTO strict_probe (value) VALUES ('writer-two')")
            }).pipe(Effect.provide(makeLayer(databasePath))),
          )
        }),
      ),
    )
    assert.equal(Result.isFailure(busyFailure), true)

    yield* database.run("PRAGMA user_version = 12")
    yield* database.run("DROP TABLE walkthrough_operations")
  }).pipe(Effect.provide(layer))

  yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(databasePath))))
  yield* Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    assert.equal(Option.getOrThrow(yield* database.get("PRAGMA user_version")).user_version, 14)
    assert.equal(Option.getOrThrow(yield* database.get("PRAGMA quick_check")).quick_check, "ok")
    assert.deepEqual(yield* database.all("PRAGMA foreign_key_check"), [])
  }).pipe(Effect.provide(makeLayer(databasePath)))

  const backup = readdirSync(dirname(databasePath)).find((name) =>
    name.includes(".pre-migration-v12-"),
  )
  assert.notEqual(backup, undefined)
  const backupPath = join(dirname(databasePath), backup ?? "missing")
  assert.equal(existsSync(backupPath), true)

  const restoredPath = `${databasePath}.restored`
  copyFileSync(backupPath, restoredPath)
  yield* Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(restoredPath))))
  yield* Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    assert.equal(Option.getOrThrow(yield* database.get("PRAGMA user_version")).user_version, 14)
    assert.equal(
      Option.getOrThrow(yield* database.get("SELECT COUNT(*) AS count FROM repos")).count,
      1,
    )
  }).pipe(Effect.provide(makeLayer(restoredPath)))

  const corruptPath = `${databasePath}.corrupt`
  writeFileSync(corruptPath, "not a sqlite database")
  const corrupt = yield* Effect.result(
    Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(corruptPath)))),
  )
  assert.equal(Result.isFailure(corrupt), true)

  const newerPath = `${databasePath}.newer`
  yield* Effect.gen(function* () {
    const database = makeDatabase(yield* SqlClient.SqlClient)
    yield* database.run("CREATE TABLE future_marker (value TEXT NOT NULL)")
    yield* database.run("INSERT INTO future_marker VALUES ('preserve-me')")
    yield* database.run("PRAGMA user_version = 15")
  }).pipe(Effect.provide(makeLayer(newerPath)))
  const newer = yield* Effect.result(
    Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(newerPath)))),
  )
  assert.equal(Result.isFailure(newer), true)

  const readOnlyPath = `${databasePath}.read-only`
  copyFileSync(backupPath, readOnlyPath)
  chmodSync(readOnlyPath, 0o444)
  const readOnly = yield* Effect.result(
    Effect.scoped(Effect.void.pipe(Effect.provide(makeLayer(readOnlyPath)))),
  )
  chmodSync(readOnlyPath, 0o600)
  assert.equal(Result.isFailure(readOnly), true)
})
