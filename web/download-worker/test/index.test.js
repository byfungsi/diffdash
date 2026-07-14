import assert from "node:assert/strict"
import test from "node:test"
import worker from "../src/index.js"

const publicBaseUrl = "https://download.usediffdash.com"

function createBucket(pages, stableTag, bodies) {
  return {
    async get(key) {
      const value = key === "stable.json" ? JSON.stringify({ tag: stableTag }) : bodies[key]
      return value === undefined ? null : { text: async () => value }
    },
    async list({ cursor, prefix }) {
      const index = cursor ? Number(cursor) : 0
      const keys = (pages[index] ?? []).filter((key) => key.startsWith(prefix))

      return {
        cursor: String(index + 1),
        objects: keys.map((key) => ({ key })),
        truncated: index < pages.length - 1,
      }
    },
  }
}

function createEnvironment(pages, options = {}) {
  return {
    PUBLIC_RELEASE_BASE_URL: publicBaseUrl,
    RELEASES_BUCKET: createBucket(pages, options.stableTag ?? "v0.1.5", options.bodies ?? {}),
  }
}

test("keeps the legacy Linux endpoint on the latest deb package", async () => {
  const response = await worker.fetch(
    new Request("https://download.usediffdash.com/linux"),
    createEnvironment([
      [
        "releases/v0.1.4/DiffDash-0.1.4-linux-amd64.deb",
        "releases/v0.1.4/DiffDash-0.1.4-linux-x86_64.AppImage",
      ],
      [
        "releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb",
        "releases/v0.1.5/DiffDash-0.1.5-linux-x86_64.AppImage",
      ],
    ]),
  )

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get("Location"),
    `${publicBaseUrl}/releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb`,
  )
})

test("redirects the AppImage endpoint to the latest requested architecture", async () => {
  const response = await worker.fetch(
    new Request("https://download.usediffdash.com/linux/appimage?arch=x86_64"),
    createEnvironment([
      [
        "releases/v0.1.5/DiffDash-0.1.5-linux-arm64.AppImage",
        "releases/v0.1.5/DiffDash-0.1.5-linux-x86_64.AppImage",
      ],
    ]),
  )

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get("Location"),
    `${publicBaseUrl}/releases/v0.1.5/DiffDash-0.1.5-linux-x86_64.AppImage`,
  )
})

test("falls back when the latest release has no AppImage", async () => {
  const response = await worker.fetch(
    new Request("https://download.usediffdash.com/linux/appimage"),
    createEnvironment([["releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb"]]),
  )

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get("Location"),
    "https://github.com/byfungsi/diffdash/releases/latest",
  )
})

test("ignores a newer uploaded candidate until it is promoted", async () => {
  const response = await worker.fetch(
    new Request("https://download.usediffdash.com/macos?arch=arm64"),
    createEnvironment([
      [
        "releases/v0.1.5/DiffDash-0.1.5-mac-arm64.dmg",
        "releases/v0.1.6/DiffDash-0.1.6-mac-arm64.dmg",
      ],
    ]),
  )

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get("Location"),
    `${publicBaseUrl}/releases/v0.1.5/DiffDash-0.1.5-mac-arm64.dmg`,
  )
})

test("serves architecture-specific updater metadata and redirects its artifact", async () => {
  const metadataKey = "releases/v0.1.5/latest-mac-arm64.yml"
  const environment = createEnvironment(
    [[metadataKey, "releases/v0.1.5/DiffDash-0.1.5-mac-arm64.zip"]],
    {
      bodies: {
        [metadataKey]: "version: 0.1.5\npath: DiffDash-0.1.5-mac-arm64.zip\n",
      },
    },
  )
  const metadata = await worker.fetch(
    new Request("https://download.usediffdash.com/updates/stable/macos/arm64/latest-mac.yml"),
    environment,
  )
  assert.equal(metadata.status, 200)
  assert.match(await metadata.text(), /version: 0\.1\.5/)
  assert.equal(metadata.headers.get("Cache-Control"), noStoreValue)

  const artifact = await worker.fetch(
    new Request(
      "https://download.usediffdash.com/updates/stable/macos/arm64/DiffDash-0.1.5-mac-arm64.zip",
    ),
    environment,
  )
  assert.equal(artifact.status, 302)
  assert.equal(
    artifact.headers.get("Location"),
    `${publicBaseUrl}/releases/v0.1.5/DiffDash-0.1.5-mac-arm64.zip`,
  )
})

test("serves the promoted Linux x64 AppImage update feed", async () => {
  const metadataKey = "releases/v0.1.5/latest-linux.yml"
  const appImage = "DiffDash-0.1.5-linux-x64.AppImage"
  const environment = createEnvironment([[metadataKey, `releases/v0.1.5/${appImage}`]], {
    bodies: {
      [metadataKey]: `version: 0.1.5\npath: ${appImage}\n`,
    },
  })
  const metadata = await worker.fetch(
    new Request("https://download.usediffdash.com/updates/stable/linux/x64/latest-linux.yml"),
    environment,
  )
  assert.equal(metadata.status, 200)
  assert.match(await metadata.text(), new RegExp(appImage))

  const artifact = await worker.fetch(
    new Request(`https://download.usediffdash.com/updates/stable/linux/x64/${appImage}`),
    environment,
  )
  assert.equal(artifact.status, 302)
  assert.equal(artifact.headers.get("Location"), `${publicBaseUrl}/releases/v0.1.5/${appImage}`)
})

const noStoreValue = "no-store, no-cache, must-revalidate, max-age=0"
