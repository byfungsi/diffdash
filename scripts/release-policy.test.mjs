import assert from "node:assert/strict"
import test from "node:test"

import {
  assertTagMatchesVersion,
  createLatestMetadata,
  retainedReleasePrefixes,
  runWithRetries,
  validateReleaseAssetNames,
} from "./release-policy.mjs"

const completeAssets = [
  "DiffDash-0.3.1-mac-arm64.dmg",
  "DiffDash-0.3.1-mac-arm64.zip",
  "DiffDash-0.3.1-mac-x64.dmg",
  "DiffDash-0.3.1-mac-x64.zip",
  "DiffDash-0.3.1-linux-x64.AppImage",
  "DiffDash-0.3.1-linux-amd64.deb",
  "latest-mac-arm64.yml",
  "latest-mac-x64.yml",
  "latest-linux.yml",
  "latest.json",
  "SHA256SUMS",
]

test("requires the release tag to match the package version", () => {
  assert.doesNotThrow(() => assertTagMatchesVersion("v0.3.1", "0.3.1"))
  assert.throws(() => assertTagMatchesVersion("v0.3.2", "0.3.1"), /does not match/u)
})

test("requires every stable platform asset and metadata file", () => {
  assert.doesNotThrow(() => validateReleaseAssetNames(completeAssets, "v0.3.1"))
  assert.throws(
    () => validateReleaseAssetNames(completeAssets.filter((name) => !name.endsWith(".deb"))),
    /Linux deb/u,
  )
})

test("builds deterministic sorted metadata with encoded public URLs", () => {
  assert.deepEqual(
    createLatestMetadata({
      tag: "v0.3.1",
      baseUrl: "https://download.example.test",
      generatedAt: "2026-07-15T00:00:00.000Z",
      assets: [
        { name: "z file.zip", size: 2, sha256: "bbb" },
        { name: "a.zip", size: 1, sha256: "aaa" },
      ],
    }),
    {
      version: "0.3.1",
      tag: "v0.3.1",
      generatedAt: "2026-07-15T00:00:00.000Z",
      assets: [
        {
          name: "a.zip",
          size: 1,
          sha256: "aaa",
          url: "https://download.example.test/releases/v0.3.1/a.zip",
        },
        {
          name: "z file.zip",
          size: 2,
          sha256: "bbb",
          url: "https://download.example.test/releases/v0.3.1/z%20file.zip",
        },
      ],
    },
  )
})

test("retries transient operations and preserves the final failure", () => {
  let attempts = 0
  const retries = []
  const result = runWithRetries(
    () => {
      attempts += 1
      if (attempts < 3) throw new Error(`failure-${attempts}`)
      return "published"
    },
    { attempts: 3, onRetry: (attempt, total) => retries.push([attempt, total]) },
  )
  assert.equal(result, "published")
  assert.deepEqual(retries, [
    [2, 3],
    [3, 3],
  ])
  assert.throws(
    () =>
      runWithRetries(
        () => {
          throw new Error("final failure")
        },
        { attempts: 2 },
      ),
    /final failure/u,
  )
})

test("retains the promoted release and two newest other stable releases", () => {
  assert.deepEqual(
    retainedReleasePrefixes(
      [
        "releases/v0.2.0/",
        "releases/v0.3.0/",
        "releases/v0.3.1/",
        "releases/v0.4.0/",
        "releases/v0.5.0-beta.1/",
      ],
      "v0.3.1",
    ),
    new Set(["releases/v0.3.1/", "releases/v0.4.0/", "releases/v0.3.0/"]),
  )
})
