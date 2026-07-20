const releaseVersionSource = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`
const releaseVersionPattern = new RegExp(`^${releaseVersionSource}$`, "u")
const releaseTagPattern = new RegExp(`^v${releaseVersionSource}$`, "u")
const changelogHeadingVersionPattern = new RegExp(
  `(?:^|@|\\[|\\s)v?(${releaseVersionSource})(?:\\]|\\s|$)`,
  "u",
)
const stableReleasePrefixPattern = /^releases\/v?(\d+)\.(\d+)\.(\d+)\/$/u

/** Returns whether a package version matches the release scripts' SemVer-like grammar. */
export const isReleaseVersion = (version) =>
  typeof version === "string" && releaseVersionPattern.test(version)

/** Verifies a package version without narrowing the historically accepted grammar. */
export const assertReleaseVersion = (version) => {
  if (!isReleaseVersion(version)) {
    throw new Error(`package.json version must be SemVer-like, got ${JSON.stringify(version)}`)
  }
}

/** Creates a release tag for a validated package version. */
export const releaseTagForVersion = (version) => {
  assertReleaseVersion(version)
  return `v${version}`
}

/** Returns whether a tag matches the release scripts' v-prefixed version grammar. */
export const isReleaseTag = (tag) => typeof tag === "string" && releaseTagPattern.test(tag)

/** Verifies a v-prefixed release tag. */
export const assertReleaseTag = (tag) => {
  if (!isReleaseTag(tag)) {
    throw new Error(`Release tag must look like v<semver>, got ${JSON.stringify(tag)}`)
  }
}

/** Extracts the package version from a validated release tag. */
export const releaseVersionFromTag = (tag) => {
  assertReleaseTag(tag)
  return tag.slice(1)
}

/** Extracts a version from the version-or-tag input historically accepted by release notes. */
export const releaseVersionFromVersionOrTag = (value) => {
  if (isReleaseVersion(value)) return value
  if (isReleaseTag(value)) return value.slice(1)
  throw new Error(`Release version or tag is invalid: ${JSON.stringify(value)}`)
}

/** Extracts a release version from a changelog heading using the shared version grammar. */
export const releaseVersionFromChangelogHeading = (headingText) =>
  changelogHeadingVersionPattern.exec(headingText)?.[1] ?? null

/** Parses an R2 stable release prefix, accepting the existing optional v prefix. */
export const parseStableReleasePrefix = (prefix) => {
  const match = stableReleasePrefixPattern.exec(prefix)
  return match === null
    ? null
    : { prefix, version: [Number(match[1]), Number(match[2]), Number(match[3])] }
}

/** Returns whether a path is an R2 stable release prefix eligible for retention cleanup. */
export const isStableReleasePrefix = (prefix) => parseStableReleasePrefix(prefix) !== null

/** Verifies that a release tag names the package version being built. */
export const assertTagMatchesVersion = (tag, packageVersion) => {
  assertReleaseTag(tag)
  assertReleaseVersion(packageVersion)
  if (tag !== releaseTagForVersion(packageVersion)) {
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
  version: releaseVersionFromTag(tag),
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
  version: releaseVersionFromTag(tag),
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
    .map(parseStableReleasePrefix)
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
