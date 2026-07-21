import {
  normalizePublicBaseUrl,
  releaseVersionFromTag,
  selectReleaseArtifacts,
  validateReleaseAssetNames,
  validateUpdaterMetadata,
} from "./release-policy.mjs"

const defaultAttempts = 20
const defaultDelayMs = 15_000

/** Verifies the promoted release through the same public endpoints used by installers and updates. */
export const verifyPublicRelease = async ({
  tag,
  baseUrl,
  fetchImpl = fetch,
  attempts = defaultAttempts,
  delayMs = defaultDelayMs,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  log = console.log,
}) => {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Public propagation checks must retry serially.
      await verifyPublicReleaseOnce({ tag, baseUrl, fetchImpl })
      log(`Verified public release endpoints for ${tag}.`)
      return
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      log(`Public release verification attempt ${attempt}/${attempts} failed; retrying.`)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Delay intentionally precedes the next retry.
      await sleep(delayMs)
    }
  }
  throw lastError
}

/** Runs one public release verification attempt without retrying. */
export const verifyPublicReleaseOnce = async ({ tag, baseUrl, fetchImpl = fetch }) => {
  const origin = normalizePublicBaseUrl(baseUrl)
  const version = releaseVersionFromTag(tag)
  const stable = await fetchJson(fetchImpl, `${origin}/stable.json`)
  assertReleaseIdentity(stable, tag, version, "stable.json")

  const latest = await fetchJson(fetchImpl, `${origin}/latest.json`)
  assertReleaseIdentity(latest, tag, version, "latest.json")
  const versionLatest = await fetchJson(fetchImpl, `${origin}/releases/${tag}/latest.json`)
  assertReleaseIdentity(versionLatest, tag, version, `releases/${tag}/latest.json`)

  const assets = validateLatestAssets(latest, tag, origin)
  const versionAssets = validateLatestAssets(versionLatest, tag, origin)
  if (JSON.stringify(versionAssets) !== JSON.stringify(assets)) {
    throw new Error("Root and versioned latest.json asset manifests differ.")
  }

  const selected = selectReleaseArtifacts(
    [...assets.map((asset) => asset.name), "latest.json"],
    tag,
  )
  const provenanceAsset = assets.find((asset) => asset.name === "release-provenance.json")
  const provenance =
    provenanceAsset === undefined ? null : await fetchJson(fetchImpl, provenanceAsset.url)
  if (provenance !== null && provenance.tag !== tag) {
    throw new Error(`release-provenance.json does not identify ${tag}.`)
  }
  const updaterIntegrity = (artifact) => {
    const latestAsset = assets.find((asset) => asset.name === artifact)
    if (latestAsset === undefined) throw new Error(`latest.json is missing ${artifact}.`)
    const provenanceAssetEntry = provenance?.assets?.find((asset) => asset.name === artifact)
    return { size: latestAsset.size, sha512: provenanceAssetEntry?.sha512 }
  }
  const checksums = parseChecksums(
    await fetchText(fetchImpl, `${origin}/releases/${tag}/SHA256SUMS`),
  )
  await Promise.all(
    assets.map(async (asset) => {
      if (asset.name !== "SHA256SUMS" && checksums.get(asset.name) !== asset.sha256) {
        throw new Error(`SHA256SUMS does not match latest.json for ${asset.name}.`)
      }
      await verifyAssetHead(fetchImpl, asset)
    }),
  )

  await verifyUpdaterMetadata(fetchImpl, {
    url: `${origin}/updates/stable/macos/arm64/latest-mac.yml`,
    version,
    artifact: selected.macArm64Zip,
    integrity: updaterIntegrity(selected.macArm64Zip),
  })
  await verifyUpdaterMetadata(fetchImpl, {
    url: `${origin}/updates/stable/macos/x64/latest-mac.yml`,
    version,
    artifact: selected.macX64Zip,
    integrity: updaterIntegrity(selected.macX64Zip),
  })
  await verifyUpdaterMetadata(fetchImpl, {
    url: `${origin}/updates/stable/linux/x64/latest-linux.yml`,
    version,
    artifact: selected.linuxAppImage,
    integrity: updaterIntegrity(selected.linuxAppImage),
  })

  await verifyRedirect(fetchImpl, `${origin}/macos?arch=arm64`, tag, selected.macArm64Dmg)
  await verifyRedirect(fetchImpl, `${origin}/macos?arch=x64`, tag, selected.macX64Dmg)
  await verifyRedirect(
    fetchImpl,
    `${origin}/linux/appimage?arch=x86_64`,
    tag,
    selected.linuxAppImage,
  )
  await verifyRedirect(fetchImpl, `${origin}/linux`, tag, selected.linuxDeb)
}

const validateLatestAssets = (latest, tag, origin) => {
  if (!Array.isArray(latest.assets)) throw new Error("latest.json is missing its asset manifest.")
  const assets = latest.assets.toSorted((left, right) => left.name.localeCompare(right.name))
  validateReleaseAssetNames([...assets.map((asset) => asset.name), "latest.json"], tag)
  for (const asset of assets) {
    if (
      typeof asset.name !== "string" ||
      typeof asset.url !== "string" ||
      typeof asset.size !== "number" ||
      typeof asset.sha256 !== "string"
    ) {
      throw new Error("latest.json contains an invalid asset entry.")
    }
    const expectedUrl = `${origin}/releases/${tag}/${encodeURIComponent(asset.name)}`
    if (asset.url !== expectedUrl) {
      throw new Error(`latest.json has an unexpected URL for ${asset.name}.`)
    }
  }
  return assets
}

const assertReleaseIdentity = (metadata, tag, version, name) => {
  if (metadata.tag !== tag || metadata.version !== version) {
    throw new Error(`${name} does not identify ${tag}.`)
  }
}

const parseChecksums = (content) => {
  const checksums = new Map()
  for (const line of content.trim().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line)
    if (match === null) throw new Error("SHA256SUMS contains an invalid line.")
    checksums.set(match[2], match[1])
  }
  return checksums
}

const verifyAssetHead = async (fetchImpl, asset) => {
  const response = await fetchResponse(fetchImpl, asset.url, { method: "HEAD" })
  if (!response.ok) throw new Error(`HEAD ${asset.url} returned ${response.status}.`)
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null && Number(contentLength) !== asset.size) {
    throw new Error(`HEAD ${asset.url} returned an unexpected content length.`)
  }
}

const verifyUpdaterMetadata = async (fetchImpl, { url, version, artifact, integrity }) => {
  const metadata = await fetchText(fetchImpl, url)
  try {
    validateUpdaterMetadata(metadata, { version, artifact, ...integrity })
  } catch (cause) {
    throw new Error(`${url} does not reference ${artifact}.`, { cause })
  }
  const head = await fetchResponse(fetchImpl, url, { method: "HEAD" })
  if (!head.ok) throw new Error(`HEAD ${url} returned ${head.status}.`)
}

const verifyRedirect = async (fetchImpl, url, tag, artifact) => {
  const response = await fetchResponse(fetchImpl, url, { method: "HEAD", redirect: "manual" })
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`${url} did not return a redirect.`)
  }
  const location = response.headers.get("location")
  if (location === null) {
    throw new Error(`${url} did not redirect to ${artifact}.`)
  }
  const actual = new URL(location, url)
  const expected = new URL(`/releases/${tag}/${encodeURIComponent(artifact)}`, url)
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search) {
    throw new Error(`${url} did not redirect to ${artifact}.`)
  }
}

const fetchJson = async (fetchImpl, url) => JSON.parse(await fetchText(fetchImpl, url))

const fetchText = async (fetchImpl, url) => {
  const response = await fetchResponse(fetchImpl, url)
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}.`)
  return response.text()
}

const fetchResponse = (fetchImpl, url, init = {}) =>
  fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) })
