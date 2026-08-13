import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { withTemporaryDirectory, withTemporaryDirectorySync } from "./temporary-directory.mjs"

test("removes scoped temporary directories after success and failure", async () => {
  let synchronousDirectory
  assert.throws(() =>
    withTemporaryDirectorySync(path.join(tmpdir(), "diffdash-temp-sync-"), (directory) => {
      synchronousDirectory = directory
      throw new Error("expected failure")
    }),
  )
  assert.equal(existsSync(synchronousDirectory), false)

  let asynchronousDirectory
  await withTemporaryDirectory(path.join(tmpdir(), "diffdash-temp-async-"), async (directory) => {
    asynchronousDirectory = directory
  })
  assert.equal(existsSync(asynchronousDirectory), false)
})
