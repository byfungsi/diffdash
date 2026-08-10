import { resolveCompatibleReleaseArtifactNames } from "./release-filename-compatibility.js"

const releaseTagPattern = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/
const artifactRoleLabels = {
  macArm64Dmg: "macOS ARM64 DMG",
  macArm64Zip: "macOS ARM64 ZIP",
  macArm64Blockmap: "macOS ARM64 blockmap",
  macX64Dmg: "macOS Intel DMG",
  macX64Zip: "macOS Intel ZIP",
  macX64Blockmap: "macOS Intel blockmap",
  macArm64Metadata: "macOS ARM64 metadata",
  macX64Metadata: "macOS Intel metadata",
  linuxAppImage: "Linux x64 AppImage",
  linuxMetadata: "Linux updater metadata",
  linuxDeb: "Linux deb",
}

/** Normalizes a configured HTTP(S) public release origin. */
export const normalizePublicReleaseOrigin = (value) => {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) throw new Error("Public release origin must not be blank.")
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url
  try {
    url = new URL(candidate)
  } catch (cause) {
    throw new Error("Public release origin must be a valid HTTP(S) origin.", { cause })
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    !/^\/+$/u.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error("Public release origin must be a valid HTTP(S) origin.")
  }
  return url.origin
}

/** Decodes the stable pointer consumed by release clients. */
export const decodeStableReleaseManifest = (value) => {
  if (!isRecord(value) || !isString(value.tag)) {
    throw new Error("Stable release manifest must declare a tag.")
  }
  const version = versionFromTag(value.tag)
  if (value.version !== undefined && value.version !== version) {
    throw new Error("Stable release manifest version does not match its tag.")
  }
  return Object.freeze({ tag: value.tag, version })
}

/** Decodes and freezes a versioned latest manifest and its release artifact inventory. */
export const decodeVersionedLatestManifest = (value, { expectedTag, publicOrigin } = {}) => {
  if (
    !isRecord(value) ||
    !isString(value.tag) ||
    !isString(value.generatedAt) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Versioned latest manifest is invalid.")
  }
  const version = versionFromTag(value.tag)
  if (value.version !== version || (expectedTag !== undefined && value.tag !== expectedTag)) {
    throw new Error("Versioned latest manifest identity is invalid.")
  }
  const assets = Object.freeze(
    value.assets.map((asset) => decodeManifestAsset(asset, value.tag, publicOrigin)),
  )
  assertUniqueNames(
    assets.map(({ name }) => name),
    value.tag,
  )
  return Object.freeze({
    tag: value.tag,
    version,
    generatedAt: value.generatedAt,
    assets,
  })
}

/** Builds the complete platform and architecture matrix for one release inventory. */
export const createReleaseArtifactMatrix = ({ tag, assets }) => {
  const version = versionFromTag(tag)
  const inventory = Object.freeze(assets.map((asset) => Object.freeze({ ...asset })))
  const byName = new Map(inventory.map((asset) => [asset.name, asset]))
  assertUniqueNames(
    inventory.map(({ name }) => name),
    tag,
  )
  const resolution = resolveCompatibleReleaseArtifactNames([...byName.keys()], version)
  if (resolution.missing.length > 0) {
    throw new Error(`Release ${tag} is missing: ${resolution.missing.map(roleLabel).join(", ")}`)
  }
  if (resolution.ambiguous.length > 0) {
    throw new Error(
      `Release ${tag} has multiple candidates for: ${resolution.ambiguous.map(roleLabel).join(", ")}`,
    )
  }
  const artifact = (role) => {
    const name = resolution.selected[role]
    const value = byName.get(name)
    if (value === undefined) throw new Error(`Release ${tag} has no ${role} artifact.`)
    return value
  }
  return Object.freeze({
    tag,
    version,
    inventory,
    roles: resolution.selected,
    downloads: Object.freeze({
      macos: Object.freeze({ arm64: artifact("macArm64Dmg"), x64: artifact("macX64Dmg") }),
      linuxDeb: Object.freeze({ x64: artifact("linuxDeb") }),
      linuxAppImage: Object.freeze({ x64: artifact("linuxAppImage") }),
    }),
    updates: Object.freeze({
      macos: Object.freeze({
        arm64: Object.freeze({
          artifact: artifact("macArm64Zip"),
          blockmap: artifact("macArm64Blockmap"),
          metadata: artifact("macArm64Metadata"),
        }),
        x64: Object.freeze({
          artifact: artifact("macX64Zip"),
          blockmap: artifact("macX64Blockmap"),
          metadata: artifact("macX64Metadata"),
        }),
      }),
      linux: Object.freeze({
        x64: Object.freeze({
          artifact: artifact("linuxAppImage"),
          metadata: artifact("linuxMetadata"),
        }),
      }),
    }),
  })
}

/** Selects one public installer download without filename scoring. */
export const selectReleaseDownload = (matrix, platform, architecture) => {
  if (platform === "macos" && (architecture === "arm64" || architecture === "x64")) {
    return matrix.downloads.macos[architecture]
  }
  if (platform === "linux" && architecture === "x64") return matrix.downloads.linuxDeb.x64
  if (platform === "appimage" && architecture === "x64") {
    return matrix.downloads.linuxAppImage.x64
  }
  return undefined
}

/** Selects one updater feed and its downloadable artifacts explicitly. */
export const selectReleaseUpdate = (matrix, platform, architecture) => {
  if (platform === "macos" && (architecture === "arm64" || architecture === "x64")) {
    return matrix.updates.macos[architecture]
  }
  if (platform === "linux" && architecture === "x64") return matrix.updates.linux.x64
  return undefined
}

/** Encodes deterministic versioned latest metadata from an already-inspected inventory. */
export const createVersionedLatestManifest = ({ tag, publicOrigin, generatedAt, assets }) => {
  const version = versionFromTag(tag)
  return {
    version,
    tag,
    generatedAt,
    assets: assets
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(({ name, size, sha256 }) => ({
        name,
        url: `${publicOrigin}/releases/${tag}/${encodeURIComponent(name)}`,
        size,
        sha256,
      })),
  }
}

const decodeManifestAsset = (value, tag, publicOrigin) => {
  if (
    !isRecord(value) ||
    !isString(value.name) ||
    !isString(value.url) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    !isString(value.sha256) ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error("Versioned latest manifest contains an invalid asset.")
  }
  if (publicOrigin !== undefined) {
    const expected = `${publicOrigin}/releases/${tag}/${encodeURIComponent(value.name)}`
    if (value.url !== expected) throw new Error(`Unexpected release asset URL for ${value.name}.`)
  }
  return Object.freeze({
    name: value.name,
    url: value.url,
    size: value.size,
    sha256: value.sha256,
  })
}

const versionFromTag = (tag) => {
  const match = releaseTagPattern.exec(tag)
  if (match === null) throw new Error(`Invalid release tag: ${JSON.stringify(tag)}`)
  return match[1]
}

const roleLabel = (role) => artifactRoleLabels[role] ?? role

const assertUniqueNames = (names, tag) => {
  if (new Set(names).size !== names.length) {
    throw new Error(`Release ${tag} has duplicate assets.`)
  }
}

const isRecord = (value) => Object.prototype.toString.call(value) === "[object Object]"
const isString = (value) => String(value) === value

/** Worker-safe release manifest codec and encoder surface. */
export const ReleaseCatalog = Object.freeze({
  normalizePublicOrigin: normalizePublicReleaseOrigin,
  decodeStableManifest: decodeStableReleaseManifest,
  decodeVersionedLatestManifest,
  createVersionedLatestManifest,
})

/** Worker-safe release artifact matrix construction and explicit selection surface. */
export const ReleaseArtifactMatrix = Object.freeze({
  create: createReleaseArtifactMatrix,
  selectDownload: selectReleaseDownload,
  selectUpdate: selectReleaseUpdate,
})
