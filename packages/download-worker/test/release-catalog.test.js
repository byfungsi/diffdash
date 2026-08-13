import assert from "node:assert/strict"
import test from "node:test"

import {
  createReleaseArtifactMatrix,
  decodeStableReleaseManifest,
  decodeVersionedLatestManifest,
  selectReleaseDownload,
  selectReleaseUpdate,
} from "../src/release-catalog.js"

const tag = "v1.2.3"
const origin = "https://download.example.test"
const names = [
  "DiffDash-1.2.3-mac-arm64.dmg",
  "DiffDash-1.2.3-mac-arm64.zip",
  "DiffDash-1.2.3-mac-arm64.zip.blockmap",
  "DiffDash-1.2.3-mac-x64.dmg",
  "DiffDash-1.2.3-mac-x64.zip",
  "DiffDash-1.2.3-mac-x64.zip.blockmap",
  "DiffDash-1.2.3-linux-amd64.deb",
  "DiffDash-1.2.3-linux-x86_64.AppImage",
  "latest-mac-arm64.yml",
  "latest-mac-x64.yml",
  "latest-linux.yml",
]
const manifest = {
  version: "1.2.3",
  tag,
  generatedAt: "2026-08-10T00:00:00.000Z",
  assets: names.map((name) => ({
    name,
    url: `${origin}/releases/${tag}/${encodeURIComponent(name)}`,
    size: 42,
    sha256: "a".repeat(64),
  })),
}

test("decodes stable and versioned manifests into an explicit immutable matrix", () => {
  assert.deepEqual(decodeStableReleaseManifest({ tag, version: "1.2.3" }), {
    tag,
    version: "1.2.3",
  })
  const latest = decodeVersionedLatestManifest(manifest, { expectedTag: tag, publicOrigin: origin })
  const matrix = createReleaseArtifactMatrix(latest)
  assert.equal(selectReleaseDownload(matrix, "macos", "arm64")?.name, names[0])
  assert.equal(
    selectReleaseUpdate(matrix, "linux", "x64")?.artifact.name,
    "DiffDash-1.2.3-linux-x86_64.AppImage",
  )
  assert.equal(Object.isFrozen(matrix), true)
  assert.equal(Object.isFrozen(latest.assets), true)
})

test("keeps historical Linux names in one compatibility path and rejects ambiguity", () => {
  const matrix = createReleaseArtifactMatrix({
    tag,
    assets: names.map((name) => ({ name })),
  })
  assert.equal(matrix.roles.linuxDeb, "DiffDash-1.2.3-linux-amd64.deb")
  assert.throws(
    () =>
      createReleaseArtifactMatrix({
        tag,
        assets: [...names, "DiffDash-1.2.3-linux-x64.deb"].map((name) => ({ name })),
      }),
    /multiple candidates/u,
  )
})

test("rejects mismatched manifest identity and public asset URLs", () => {
  assert.throws(() => decodeVersionedLatestManifest({ ...manifest, version: "1.2.4" }), /identity/u)
  assert.throws(
    () =>
      decodeVersionedLatestManifest(
        { ...manifest, assets: [{ ...manifest.assets[0], url: "https://evil.test/file" }] },
        { expectedTag: tag, publicOrigin: origin },
      ),
    /Unexpected release asset URL/u,
  )
})
