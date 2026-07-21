import assert from "node:assert/strict"
import test from "node:test"

import {
  parseCreateReleaseTagArguments,
  parseLinuxReleaseArguments,
  parseLocalReleaseArguments,
  parseMacReleaseArguments,
  parseNotarizeArguments,
  parsePromoteReleaseArguments,
  parsePublishReleaseArguments,
  parseReleaseNotesArguments,
  parseVerifyReleaseArguments,
} from "./release-arguments.mjs"

test("parses every documented local release option and flag", () => {
  assert.deepEqual(
    parseLocalReleaseArguments([
      "--tag",
      "v0.3.1",
      "--assets-dir",
      "release assets",
      "--mac-arch",
      "all",
      "--skip-checks",
      "--skip-mac",
      "--skip-linux",
      "--skip-publish",
      "--allow-published",
    ]),
    {
      tag: "v0.3.1",
      assetsDir: "release assets",
      macArch: "all",
      skipChecks: true,
      skipMac: true,
      skipLinux: true,
      skipPublish: true,
      allowPublished: true,
    },
  )
})

test("parses focused build, publish, promotion, and notarization arguments", () => {
  assert.deepEqual(
    parseMacReleaseArguments([
      "--assets-dir",
      "assets",
      "--arch",
      "arm64",
      "--package-existing",
      "--skip-notarize",
      "--submission-id",
      "submission-1",
    ]),
    {
      assetsDir: "assets",
      arch: "arm64",
      packageExisting: true,
      skipNotarize: true,
      submissionId: "submission-1",
    },
  )
  assert.deepEqual(
    parseLinuxReleaseArguments([
      "--assets-dir",
      "assets",
      "--platform",
      "linux/amd64",
      "--image",
      "node:22-trixie",
    ]),
    {
      assetsDir: "assets",
      platform: "linux/amd64",
      image: "node:22-trixie",
    },
  )
  assert.deepEqual(
    parsePublishReleaseArguments([
      "--tag",
      "v0.3.1",
      "--assets-dir",
      "assets",
      "--metadata-only",
      "--allow-published",
      "--require-existing-r2-provenance",
    ]),
    {
      tag: "v0.3.1",
      assetsDir: "assets",
      metadataOnly: true,
      allowPublished: true,
      requireExistingR2Provenance: true,
    },
  )
  assert.deepEqual(parsePromoteReleaseArguments(["--tag", "v0.3.1"]), { tag: "v0.3.1" })
  assert.deepEqual(
    parseVerifyReleaseArguments(["--tag", "v0.3.1", "--base-url", "download.example.test"]),
    { tag: "v0.3.1", baseUrl: "download.example.test" },
  )
  assert.deepEqual(
    parseNotarizeArguments([
      "DiffDash.app",
      "--submission-id",
      "submission-1",
      "--timeout-minutes",
      "60",
      "--poll-seconds",
      "30",
    ]),
    {
      appPath: "DiffDash.app",
      submissionId: "submission-1",
      timeoutMinutes: "60",
      pollSeconds: "30",
    },
  )
})

test("parses positional release commands and rejects arguments for release tags", () => {
  assert.deepEqual(parseReleaseNotesArguments(["v0.3.1"]), { tag: "v0.3.1" })
  assert.equal(parseCreateReleaseTagArguments([]), undefined)
  assert.throws(() => parseCreateReleaseTagArguments(["unexpected"]), /Unexpected argument/u)
})

test("reports unknown, missing, and malformed options clearly", () => {
  assert.throws(
    () => parseLocalReleaseArguments(["--unknown"]),
    /Invalid release:local arguments: Unknown option '--unknown'/u,
  )
  assert.throws(
    () => parseLocalReleaseArguments(["--tag"]),
    /Option '--tag <value>' argument missing/u,
  )
  assert.throws(
    () => parsePublishReleaseArguments(["--metadata-only=yes"]),
    /Option '--metadata-only' does not take an argument/u,
  )
  assert.throws(
    () => parseLinuxReleaseArguments(["unexpected"]),
    /Unexpected argument 'unexpected'/u,
  )
  assert.throws(() => parseNotarizeArguments([]), /Usage: node scripts\/release\/notarize-app/u)
  assert.throws(
    () => parseNotarizeArguments(["one.app", "two.app"]),
    /expected one positional argument, got 2/u,
  )
  assert.throws(
    () => parseReleaseNotesArguments(["v0.3.1", "v0.3.2"]),
    /expected one positional argument, got 2/u,
  )
})
