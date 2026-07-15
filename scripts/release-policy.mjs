/** Verifies that a release tag names the package version being built. */
export const assertTagMatchesVersion = (tag, packageVersion) => {
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${tag} does not match package version ${packageVersion}.`)
  }
}

/** Verifies the complete cross-platform stable release asset matrix. */
export const validateReleaseAssetNames = (names, tag = "release") => {
  const requirements = [
    ["macOS ARM64 DMG", (name) => name.endsWith("-mac-arm64.dmg")],
    ["macOS ARM64 ZIP", (name) => name.endsWith("-mac-arm64.zip")],
    ["macOS Intel DMG", (name) => name.endsWith("-mac-x64.dmg")],
    ["macOS Intel ZIP", (name) => name.endsWith("-mac-x64.zip")],
    ["macOS ARM64 metadata", (name) => name === "latest-mac-arm64.yml"],
    ["macOS Intel metadata", (name) => name === "latest-mac-x64.yml"],
    ["Linux x64 AppImage", (name) => /-linux-(?:x64|x86_64)\.AppImage$/u.test(name)],
    ["Linux updater metadata", (name) => name === "latest-linux.yml"],
    ["Linux deb", (name) => /-linux-(?:x64|amd64|x86_64)\.deb$/u.test(name)],
    ["release metadata", (name) => name === "latest.json"],
    ["checksums", (name) => name === "SHA256SUMS"],
  ]
  const missing = requirements.filter(([, matches]) => !names.some(matches)).map(([label]) => label)
  if (missing.length > 0) throw new Error(`Release ${tag} is missing: ${missing.join(", ")}`)
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
