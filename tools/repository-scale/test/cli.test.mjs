import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

const execFilePromise = promisify(execFile)
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.mjs")

test("rejects misspelled command options instead of silently using defaults", async () => {
  await assert.rejects(
    execFilePromise(process.execPath, [
      cli,
      "measure",
      "--pid=123",
      "--fixture=linux-test",
      "--session=baseline",
      "--switch=1",
      "--duraton-ms=1",
    ]),
    (error) => error.stderr.includes("Unknown option for measure: --duraton-ms"),
  )
})
