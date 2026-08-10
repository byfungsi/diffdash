import assert from "node:assert/strict"
import test from "node:test"
import worker from "../src/index.js"

const publicBaseUrl = "https://download.usediffdash.com"

const completeAssetNames = (tag) => {
  const version = tag.slice(1)
  return [
    `DiffDash-${version}-mac-arm64.dmg`,
    `DiffDash-${version}-mac-arm64.zip`,
    `DiffDash-${version}-mac-arm64.zip.blockmap`,
    `DiffDash-${version}-mac-x64.dmg`,
    `DiffDash-${version}-mac-x64.zip`,
    `DiffDash-${version}-mac-x64.zip.blockmap`,
    `DiffDash-${version}-linux-amd64.deb`,
    `DiffDash-${version}-linux-x86_64.AppImage`,
    "latest-mac-arm64.yml",
    "latest-mac-x64.yml",
    "latest-linux.yml",
  ]
}

function createBucket(pages, stableTag, bodies, complete, releaseOrigin) {
  const listedNames = pages
    .flat()
    .filter((key) => key.startsWith(`releases/${stableTag}/`))
    .map((key) => key.slice(`releases/${stableTag}/`.length))
  const defaults = completeAssetNames(stableTag).filter(
    (name) =>
      !(name.endsWith(".AppImage") && listedNames.some((listed) => listed.endsWith(".AppImage"))) &&
      !(name.endsWith(".deb") && listedNames.some((listed) => listed.endsWith(".deb"))),
  )
  const names = [...new Set([...(complete ? defaults : []), ...listedNames])]
  const latest = JSON.stringify({
    version: stableTag.slice(1),
    tag: stableTag,
    generatedAt: "2026-07-20T00:00:00.000Z",
    assets: names.map((name) => ({
      name,
      url: `${releaseOrigin}/releases/${stableTag}/${encodeURIComponent(name)}`,
      size: 1,
      sha256: "a".repeat(64),
    })),
  })
  return {
    async get(key) {
      const value =
        key === "stable.json"
          ? JSON.stringify({ tag: stableTag })
          : key === `releases/${stableTag}/latest.json`
            ? (bodies[key] ?? latest)
            : bodies[key]
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
  const stableTag = options.stableTag ?? "v0.1.5"
  const releaseOrigin = options.publicBaseUrl ?? publicBaseUrl
  return {
    PUBLIC_RELEASE_BASE_URL: releaseOrigin,
    RELEASES_BUCKET: createBucket(
      pages,
      stableTag,
      options.bodies ?? {},
      options.complete ?? true,
      releaseOrigin,
    ),
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
    createEnvironment([["releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb"]], {
      complete: false,
    }),
  )

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get("Location"),
    "https://github.com/byfungsi/diffdash/releases/latest",
  )
})

test("accepts native-valid public origins and rejects non-origin configuration", async () => {
  const keys = [["releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb"]]
  const schemeless = createEnvironment(keys, {
    publicBaseUrl: "https://downloads.example.test:8443",
  })
  schemeless.PUBLIC_RELEASE_BASE_URL = "downloads.example.test:8443/"
  const validResponse = await worker.fetch(
    new Request("https://download.usediffdash.com/linux"),
    schemeless,
  )
  assert.equal(
    validResponse.headers.get("Location"),
    "https://downloads.example.test:8443/releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb",
  )

  const withPath = createEnvironment(keys)
  withPath.PUBLIC_RELEASE_BASE_URL = "https://downloads.example.test/public"
  const invalidResponse = await worker.fetch(
    new Request("https://download.usediffdash.com/linux"),
    withPath,
  )
  assert.equal(invalidResponse.headers.get("Location"), fallbackUrl)
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

test("allows only GET and HEAD", async () => {
  const response = await worker.fetch(
    new Request("https://download.usediffdash.com/linux", { method: "POST" }),
    createEnvironment([]),
  )
  assert.equal(response.status, 405)
  assert.equal(response.headers.get("Allow"), "GET, HEAD")
})

test("returns bodyless HEAD responses for discovery and updater metadata", async () => {
  const root = await worker.fetch(
    new Request("https://download.usediffdash.com/", { method: "HEAD" }),
    createEnvironment([]),
  )
  assert.equal(root.status, 200)
  assert.equal(await root.text(), "")

  const metadataKey = "releases/v0.1.5/latest-linux.yml"
  const metadata = await worker.fetch(
    new Request("https://download.usediffdash.com/updates/stable/linux/x64/latest-linux.yml", {
      method: "HEAD",
    }),
    createEnvironment([[metadataKey]], { bodies: { [metadataKey]: "version: 0.1.5\n" } }),
  )
  assert.equal(metadata.status, 200)
  assert.equal(await metadata.text(), "")
})

test("supports the mac, darwin, and deb aliases", async () => {
  const environment = createEnvironment([
    [
      "releases/v0.1.5/DiffDash-0.1.5-mac-arm64.dmg",
      "releases/v0.1.5/DiffDash-0.1.5-linux-amd64.deb",
    ],
  ])
  const macResponses = await Promise.all(
    ["mac", "darwin"].map((path) =>
      worker.fetch(new Request(`https://download.usediffdash.com/${path}?arch=arm64`), environment),
    ),
  )
  for (const response of macResponses) {
    assert.match(response.headers.get("Location"), /mac-arm64\.dmg$/u)
  }
  const deb = await worker.fetch(new Request("https://download.usediffdash.com/deb"), environment)
  assert.match(deb.headers.get("Location"), /linux-amd64\.deb$/u)
})

test("does not substitute the wrong architecture", async () => {
  const response = await worker.fetch(
    new Request("https://download.usediffdash.com/macos?arch=x64"),
    createEnvironment([["releases/v0.1.5/DiffDash-0.1.5-mac-arm64.dmg"]], { complete: false }),
  )
  assert.equal(response.headers.get("Location"), fallbackUrl)
})

test("rejects unsafe or missing update artifact names", async () => {
  const environment = createEnvironment([["releases/v0.1.5/DiffDash-0.1.5-linux-x64.AppImage"]])
  const responses = await Promise.all(
    ["DiffDash..-linux-x64.AppImage", "missing-linux-x64.AppImage"].map((name) =>
      worker.fetch(
        new Request(`https://download.usediffdash.com/updates/stable/linux/x64/${name}`),
        environment,
      ),
    ),
  )
  for (const response of responses) {
    assert.equal(response.status, 404)
  }
})

test("handles missing, malformed, and failing stable storage", async () => {
  const missing = createEnvironment([], { stableTag: undefined })
  missing.RELEASES_BUCKET.get = async () => null
  const missingResponse = await worker.fetch(
    new Request("https://download.usediffdash.com/linux"),
    missing,
  )
  assert.equal(missingResponse.headers.get("Location"), fallbackUrl)

  const malformed = createEnvironment([])
  malformed.RELEASES_BUCKET.get = async () => ({ text: async () => "not-json" })
  const malformedResponse = await worker.fetch(
    new Request("https://download.usediffdash.com/linux"),
    malformed,
  )
  assert.equal(malformedResponse.headers.get("Location"), fallbackUrl)

  const failing = createEnvironment([])
  failing.RELEASES_BUCKET.get = async () => {
    throw new Error("R2 unavailable")
  }
  const updateResponse = await worker.fetch(
    new Request("https://download.usediffdash.com/updates/stable/linux/x64/latest-linux.yml"),
    failing,
  )
  assert.equal(updateResponse.status, 503)
})

const noStoreValue = "no-store, no-cache, must-revalidate, max-age=0"
const fallbackUrl = "https://github.com/byfungsi/diffdash/releases/latest"
