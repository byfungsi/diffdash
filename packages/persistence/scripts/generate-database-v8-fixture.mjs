import { existsSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import BetterSqlite3 from "better-sqlite3"

const sourcePath = resolve("src/fixtures/database-v8-populated.sql")
const databasePath = resolve("src/fixtures/database-v8-populated.sqlite")

for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
  if (existsSync(path)) rmSync(path)
}

const database = new BetterSqlite3(databasePath)
try {
  database.pragma("foreign_keys = ON")
  database.exec(readFileSync(sourcePath, "utf8"))
  const foreignKeyFailures = database.pragma("foreign_key_check")
  if (foreignKeyFailures.length > 0) {
    throw new Error(
      `Generated fixture has foreign-key failures: ${JSON.stringify(foreignKeyFailures)}`,
    )
  }
  if (database.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new Error("Generated fixture failed SQLite integrity_check")
  }
  if (database.pragma("user_version", { simple: true }) !== 8) {
    throw new Error("Generated fixture does not have user_version 8")
  }
  database.pragma("journal_mode = DELETE")
  database.exec("VACUUM")
} finally {
  database.close()
}

console.log(`Generated ${databasePath}`)
