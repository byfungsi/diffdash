import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"

import { generateSyntheticFixture } from "../src/synthetic-fixture.mjs"

const execFilePromise = promisify(execFile)

test("generates every scale scenario without network access", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "diffdash-synthetic-scale-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const result = await generateSyntheticFixture({
    directory: join(root, "repository"),
    profile: { fileCount: 5, rowCount: 14, enormousFileRows: 5, wrappedLineBytes: 64 },
  })

  assert.equal(result.manifest.profile.rowCount, 14)
  assert.deepEqual(Object.keys(result.manifest.scenarios), [
    "annotation",
    "broadSearch",
    "enormousFile",
    "revisionChange",
    "wrappedLine",
  ])
  const { stdout } = await execFilePromise(
    "git",
    ["diff", "--numstat", result.manifest.baseSha, result.manifest.headSha],
    { cwd: result.repository },
  )
  const addedRows = stdout
    .trim()
    .split("\n")
    .reduce((total, line) => total + Number(line.split("\t", 1)[0]), 0)
  assert.equal(addedRows, 14)
  assert.match(await readFile(result.manifestPath, "utf8"), /synthetic-repository-scale/)
})
