/** Verifies that a release tag names the package version being built. */
export const assertTagMatchesVersion = (tag, packageVersion) => {
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${tag} does not match package version ${packageVersion}.`)
  }
}

/** Verifies the complete cross-platform stable release asset matrix. */
export const validateReleaseAssetNames = (names, tag = "release") => {
  selectReleaseArtifacts(names, tag)
  const missing = ["latest.json", "SHA256SUMS"].filter((name) => !names.includes(name))
  if (missing.length > 0) throw new Error(`Release ${tag} is missing: ${missing.join(", ")}`)
}

const artifactRequirements = {
  macArm64Dmg: ["macOS ARM64 DMG", (name) => name.endsWith("-mac-arm64.dmg")],
  macArm64Zip: ["macOS ARM64 ZIP", (name) => name.endsWith("-mac-arm64.zip")],
  macX64Dmg: ["macOS Intel DMG", (name) => name.endsWith("-mac-x64.dmg")],
  macX64Zip: ["macOS Intel ZIP", (name) => name.endsWith("-mac-x64.zip")],
  macArm64Metadata: ["macOS ARM64 metadata", (name) => name === "latest-mac-arm64.yml"],
  macX64Metadata: ["macOS Intel metadata", (name) => name === "latest-mac-x64.yml"],
  linuxAppImage: ["Linux x64 AppImage", (name) => /-linux-(?:x64|x86_64)\.AppImage$/u.test(name)],
  linuxMetadata: ["Linux updater metadata", (name) => name === "latest-linux.yml"],
  linuxDeb: ["Linux deb", (name) => /-linux-(?:x64|amd64|x86_64)\.deb$/u.test(name)],
}

/** Selects the deterministic platform artifact matrix used by publishing and promotion. */
export const selectReleaseArtifacts = (names, tag = "release") => {
  const sortedNames = names.toSorted((left, right) => left.localeCompare(right))
  const selected = {}
  const missing = []
  for (const [key, [label, matches]] of Object.entries(artifactRequirements)) {
    const name = sortedNames.find(matches)
    if (name === undefined) missing.push(label)
    else selected[key] = name
  }
  if (missing.length > 0) throw new Error(`Release ${tag} is missing: ${missing.join(", ")}`)
  return selected
}

/** Builds deterministic public metadata from already-hashed release assets. */
export const createLatestMetadata = ({ tag, baseUrl, generatedAt, assets }) => ({
  version: tag.replace(/^v/u, ""),
  tag,
  generatedAt,
  assets: assets
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((asset) => ({
      name: asset.name,
      url: `${baseUrl}/releases/${tag}/${encodeURIComponent(asset.name)}`,
      size: asset.size,
      sha256: asset.sha256,
    })),
})

/** Builds the stable pointer consumed by the download worker. */
export const createStableMetadata = ({ tag, promotedAt }) => ({
  version: tag.replace(/^v/u, ""),
  tag,
  promotedAt,
})

/** Runs one synchronous operation with a fixed bounded retry count. */
export const runWithRetries = (run, { attempts = 3, onRetry = () => undefined } = {}) => {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run()
    } catch (error) {
      lastError = error
      if (attempt < attempts) onRetry(attempt + 1, attempts)
    }
  }
  throw lastError
}

/** Selects the promoted release and two newest other stable releases for retention. */
export const retainedReleasePrefixes = (prefixes, promotedTag) => {
  const parsed = prefixes
    .map((prefix) => {
      const match = /^releases\/v?(\d+)\.(\d+)\.(\d+)\/$/u.exec(prefix)
      return match === null
        ? null
        : { prefix, version: [Number(match[1]), Number(match[2]), Number(match[3])] }
    })
    .filter((entry) => entry !== null)
    .toSorted(
      (left, right) =>
        right.version[0] - left.version[0] ||
        right.version[1] - left.version[1] ||
        right.version[2] - left.version[2],
    )
  const promotedPrefix = `releases/${promotedTag}/`
  return new Set([
    promotedPrefix,
    ...parsed
      .filter(({ prefix }) => prefix !== promotedPrefix)
      .slice(0, 2)
      .map(({ prefix }) => prefix),
  ])
}
