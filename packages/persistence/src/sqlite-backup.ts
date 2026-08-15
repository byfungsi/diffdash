import { closeSync, fsyncSync, openSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { Effect, Option, Schema } from "effect"

import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { type Database, DatabaseError, toError } from "./database"
import { readDatabaseUserVersion } from "./database-migrations"

const CheckpointRow = Schema.Struct({
  busy: Schema.Number,
  log: Schema.Number,
  checkpointed: Schema.Number,
})

/** Paths used to verify a backup before atomically publishing it. */
export interface SqliteBackupPaths {
  readonly final: string
  readonly temporary: string
}

/** Creates versioned final and staging paths for one pre-migration backup. */
export const makeSqliteBackupPaths = (databasePath: string, version: number): SqliteBackupPaths => {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "")
  const final = join(
    dirname(databasePath),
    `${basename(databasePath)}.pre-migration-v${version}-${stamp}`,
  )
  return { final, temporary: `${final}.tmp` }
}

/** Requires a complete WAL checkpoint before snapshotting database bytes. */
export const checkpointDatabase = Effect.fn("SqliteBackup.checkpoint")(function* (
  database: Database,
) {
  const row = yield* database.get("PRAGMA wal_checkpoint(FULL)").pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () =>
      DatabaseError.make({
        operation: DiagnosticOperation.make("backupCheckpointDeadline"),
        cause: new Error("SQLite pre-migration WAL checkpoint exceeded its 10 second deadline."),
      }),
    ),
  )
  const checkpoint = yield* Schema.decodeUnknownEffect(CheckpointRow)(Option.getOrThrow(row))
  if (checkpoint.busy !== 0 || checkpoint.checkpointed !== checkpoint.log) {
    return yield* DatabaseError.make({
      operation: DiagnosticOperation.make("backupCheckpoint"),
      cause: new Error("SQLite could not complete the pre-migration WAL checkpoint."),
    })
  }
})

/** Verifies integrity, foreign keys, and schema identity before backup publication. */
export const verifySqliteBackup = Effect.fn("SqliteBackup.verify")(function* (
  database: Database,
  expectedVersion: number,
) {
  const integrityRow = yield* database.get("PRAGMA quick_check")
  const integrity = Option.isSome(integrityRow) ? integrityRow.value.quick_check : undefined
  if (integrity !== "ok") {
    return yield* DatabaseError.make({
      operation: DiagnosticOperation.make("backupIntegrity"),
      cause: new Error(`SQLite backup integrity check failed: ${String(integrity)}`),
    })
  }

  const foreignKeyFailures = yield* database.all("PRAGMA foreign_key_check")
  if (foreignKeyFailures.length > 0) {
    return yield* DatabaseError.make({
      operation: DiagnosticOperation.make("backupForeignKeys"),
      cause: new Error("SQLite backup contains foreign-key violations."),
    })
  }

  const version = yield* readDatabaseUserVersion(database)
  if (version !== expectedVersion) {
    return yield* DatabaseError.make({
      operation: DiagnosticOperation.make("backupVersion"),
      cause: new Error(`SQLite backup has schema version ${version}; expected ${expectedVersion}.`),
    })
  }
})

/** Fsyncs and atomically publishes a verified backup file. */
export const publishSqliteBackup = (paths: SqliteBackupPaths) =>
  Effect.try({
    try: () => {
      const fileDescriptor = openSync(paths.temporary, "r")
      try {
        fsyncSync(fileDescriptor)
      } finally {
        closeSync(fileDescriptor)
      }

      renameSync(paths.temporary, paths.final)
      if (process.platform !== "win32") {
        const directoryDescriptor = openSync(dirname(paths.final), "r")
        try {
          fsyncSync(directoryDescriptor)
        } finally {
          closeSync(directoryDescriptor)
        }
      }
    },
    catch: (cause) =>
      DatabaseError.make({
        operation: DiagnosticOperation.make("backupPublish"),
        cause: toError(cause),
      }),
  })

/** Removes incomplete backup files after any acquisition or verification failure. */
export const cleanupSqliteBackup = (paths: SqliteBackupPaths) =>
  Effect.sync(() => {
    rmSync(paths.temporary, { force: true })
    rmSync(`${paths.temporary}-shm`, { force: true })
    rmSync(`${paths.temporary}-wal`, { force: true })
  })
