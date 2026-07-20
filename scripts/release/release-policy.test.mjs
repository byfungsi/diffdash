import assert from "node:assert/strict"
import test from "node:test"

import {
  assertReleaseTag,
  assertReleaseVersion,
  assertTagMatchesVersion,
  createLatestMetadata,
  createStableMetadata,
  isReleaseTag,
  isReleaseVersion,
  isStableReleasePrefix,
  parseStableReleasePrefix,
  releaseTagForVersion,
  releaseVersionFromChangelogHeading,
  releaseVersionFromTag,
  releaseVersionFromVersionOrTag,
  retainedReleasePrefixes,
  runWithRetries,
  selectReleaseArtifacts,
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

test("preserves the release version and tag grammar used by existing scripts", () => {
  const acceptedVersions = ["0.3.1", "01.002.0003", "1.2.3-alpha.1", "1.2.3+build.7", "1.2.3-..."]
  const rejectedVersions = ["v0.3.1", "1.2", "1.2.3-alpha+build", "1.2.3 ", 3]

  for (const version of acceptedVersions) {
    assert.equal(isReleaseVersion(version), true)
    assert.doesNotThrow(() => assertReleaseVersion(version))
    assert.equal(releaseTagForVersion(version), `v${version}`)
    assert.equal(isReleaseTag(`v${version}`), true)
    assert.equal(releaseVersionFromTag(`v${version}`), version)
    assert.equal(releaseVersionFromVersionOrTag(version), version)
    assert.equal(releaseVersionFromVersionOrTag(`v${version}`), version)
  }

  for (const version of rejectedVersions) {
    assert.equal(isReleaseVersion(version), false)
    assert.throws(() => assertReleaseVersion(version), /SemVer-like/u)
  }
  assert.equal(isReleaseTag("0.3.1"), false)
  assert.throws(() => assertReleaseTag("0.3.1"), /v<semver>/u)
  assert.throws(() => releaseVersionFromVersionOrTag("not-a-version"), /invalid/u)
})

test("uses the shared version grammar for changelog headings", () => {
  assert.equal(releaseVersionFromChangelogHeading("@diffdash/desktop@0.3.1"), "0.3.1")
  assert.equal(releaseVersionFromChangelogHeading("[v1.2.3-alpha.1] - 2026-07-17"), "1.2.3-alpha.1")
  assert.equal(releaseVersionFromChangelogHeading("not a release"), null)
})

test("recognizes only stable numeric R2 release prefixes", () => {
  assert.deepEqual(parseStableReleasePrefix("releases/v1.2.3/"), {
    prefix: "releases/v1.2.3/",
    version: [1, 2, 3],
  })
  assert.equal(isStableReleasePrefix("releases/1.2.3/"), true)
  assert.equal(isStableReleasePrefix("releases/v1.2.3-beta.1/"), false)
  assert.equal(isStableReleasePrefix("releases/v1.2.3/assets/"), false)
})

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

test("selects platform artifacts deterministically without renaming them", () => {
  assert.deepEqual(selectReleaseArtifacts(completeAssets.toReversed(), "v0.3.1"), {
    macArm64Dmg: "DiffDash-0.3.1-mac-arm64.dmg",
    macArm64Zip: "DiffDash-0.3.1-mac-arm64.zip",
    macX64Dmg: "DiffDash-0.3.1-mac-x64.dmg",
    macX64Zip: "DiffDash-0.3.1-mac-x64.zip",
    macArm64Metadata: "latest-mac-arm64.yml",
    macX64Metadata: "latest-mac-x64.yml",
    linuxAppImage: "DiffDash-0.3.1-linux-x64.AppImage",
    linuxMetadata: "latest-linux.yml",
    linuxDeb: "DiffDash-0.3.1-linux-amd64.deb",
  })
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

test("builds the stable worker pointer without changing its protocol", () => {
  assert.deepEqual(
    createStableMetadata({ tag: "v0.3.1", promotedAt: "2026-07-15T01:00:00.000Z" }),
    {
      version: "0.3.1",
      tag: "v0.3.1",
      promotedAt: "2026-07-15T01:00:00.000Z",
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
