import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

import * as DatabaseBun from "../src/database-bun"
import { runDatabaseConformance } from "../src/test-support/database-conformance"

const directory = mkdtempSync(join(tmpdir(), "diffdash-bun-conformance-"))

try {
  await Effect.runPromise(
    runDatabaseConformance(join(directory, "diffdash.sqlite"), DatabaseBun.layer),
  )
} finally {
  rmSync(directory, { force: true, recursive: true })
}
