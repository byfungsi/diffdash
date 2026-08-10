import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { deriveReleaseContext } from "./release-context.mjs"

const commit = "a".repeat(40)

test("derives one immutable release identity from package, tag, commit, assets, and origin", () => {
  const context = deriveReleaseContext({
    assetsDirectory: "release-assets",
    publicOrigin: "download.example.test/",
    readFile: () => JSON.stringify({ version: "1.2.3" }),
    readDirectory: () => ["z.dmg", "a.yml"],
    execute: () => `${commit}\n`,
  })
  assert.deepEqual(context, {
    packageVersion: "1.2.3",
    tag: "v1.2.3",
    commit,
    assetsDirectory: path.resolve("release-assets"),
    assetNames: ["a.yml", "z.dmg"],
    publicOrigin: "https://download.example.test",
  })
  assert.equal(Object.isFrozen(context), true)
  assert.equal(Object.isFrozen(context.assetNames), true)
})

test("rejects mismatched requested tags and configured commits", () => {
  const options = {
    readFile: () => JSON.stringify({ version: "1.2.3" }),
    readDirectory: () => [],
    execute: () => commit,
  }
  assert.throws(
    () => deriveReleaseContext({ ...options, requestedTag: "v1.2.4" }),
    /does not match/u,
  )
  assert.throws(
    () => deriveReleaseContext({ ...options, configuredCommit: "b".repeat(40) }),
    /Configured release commit/u,
  )
})

test("derives read-only public verification context without requiring local git state", () => {
  const context = deriveReleaseContext({
    commitRef: false,
    publicOrigin: "https://download.example.test",
    readFile: () => JSON.stringify({ version: "1.2.3" }),
    readDirectory: () => [],
    execute: () => assert.fail("git must not be called"),
  })
  assert.equal(context.commit, undefined)
  assert.equal(context.tag, "v1.2.3")
})
