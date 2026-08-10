import { existsSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const sourcePath = resolve("src/fixtures/database-v8-populated.sql")
const databasePath = resolve("src/fixtures/database-v8-populated.sqlite")

for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
  if (existsSync(path)) rmSync(path)
}

const database = new DatabaseSync(databasePath)
try {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec(readFileSync(sourcePath, "utf8"))
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all()
  if (foreignKeyFailures.length > 0) {
    throw new Error(
      `Generated fixture has foreign-key failures: ${JSON.stringify(foreignKeyFailures)}`,
    )
  }
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    throw new Error("Generated fixture failed SQLite integrity_check")
  }
  if (database.prepare("PRAGMA user_version").get()?.user_version !== 8) {
    throw new Error("Generated fixture does not have user_version 8")
  }
  database.exec("PRAGMA journal_mode = DELETE")
  database.exec("VACUUM")
} finally {
  database.close()
}

process.stdout.write(`Generated ${databasePath}\n`)
