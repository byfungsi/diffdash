import assert from "node:assert/strict"
import test from "node:test"

import {
  assertCommandAvailable,
  commandSucceeds,
  formatCommandForDisplay,
  quoteArgumentForDisplay,
  runSyncCommand,
} from "./release-command.mjs"

test("quotes command arguments for display without claiming POSIX shell escaping", () => {
  assert.equal(quoteArgumentForDisplay("release-assets/v0.3.1"), "release-assets/v0.3.1")
  assert.equal(quoteArgumentForDisplay("two words"), '"two words"')
  assert.equal(quoteArgumentForDisplay("$PATH"), '"$PATH"')
  assert.equal(
    formatCommandForDisplay("aws", ["s3", "cp", "two words", "s3://bucket/release"]),
    '$ aws s3 cp "two words" s3://bucket/release',
  )
})

test("sync command logs do not include credential environment values", () => {
  const secret = "credential-value-that-must-not-be-logged"
  const lines = []

  runSyncCommand(process.execPath, ["-e", "process.exit(0)"], {
    env: { ...process.env, R2_SECRET_ACCESS_KEY: secret },
    log: (line) => lines.push(line),
  })

  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], new RegExp(secret, "u"))
  assert.match(lines[0], /process\.exit/u)
})

test("sync command availability errors name only the command", () => {
  const secret = "credential-value-that-must-not-be-logged"
  const missingCommand = "diffdash-command-that-does-not-exist"

  assert.equal(commandSucceeds(process.execPath, ["-e", "process.exit(0)"]), true)
  assert.equal(commandSucceeds(process.execPath, ["-e", "process.exit(1)"]), false)
  assert.throws(
    () =>
      assertCommandAvailable(missingCommand, ["--version"], {
        env: { ...process.env, R2_SECRET_ACCESS_KEY: secret },
      }),
    (error) => {
      assert.match(error.message, new RegExp(missingCommand, "u"))
      assert.doesNotMatch(error.message, new RegExp(secret, "u"))
      return true
    },
  )
})
