import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import * as DatabaseNode from "./database-node"
import { runDatabaseConformance } from "./test-support/database-conformance"

it.effect("FUN-221: node:sqlite passes shared persistence conformance", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-node-conformance-"))),
    (directory) => runDatabaseConformance(join(directory, "diffdash.sqlite"), DatabaseNode.layer),
    (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
  ),
)
