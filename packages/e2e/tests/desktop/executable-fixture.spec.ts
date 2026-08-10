import { execFileSync, spawnSync } from "node:child_process"
import { expect, test } from "@playwright/test"

import { installExecutableFixture } from "../helpers/executable-fixture"

test("cross-platform executable fixtures preserve arguments", async ({
  browserName: _browserName,
}, testInfo) => {
  const executable = await installExecutableFixture(
    testInfo.outputPath("fixture-bin"),
    "argument-fixture",
    `console.log(JSON.stringify(process.argv.slice(2)))`,
  )

  const fixtureArguments = ["alpha", "two words", "&|<>^%!", 'quoted"value', "single'value"]
  expect(execFileSync(executable, fixtureArguments, { encoding: "utf8" }).trim()).toBe(
    JSON.stringify(fixtureArguments),
  )
  const spawned = spawnSync(executable, fixtureArguments, {
    encoding: "utf8",
    shell: false,
  })
  expect(spawned.status).toBe(0)
  expect(spawned.stdout.trim()).toBe(JSON.stringify(fixtureArguments))
})
