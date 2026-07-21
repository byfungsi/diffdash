const releaseVersionSource = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`
const releaseVersionPattern = new RegExp(`^${releaseVersionSource}$`, "u")
const releaseTagPattern = new RegExp(`^v${releaseVersionSource}$`, "u")
const stableReleaseTagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
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

/** Verifies a stable v-prefixed SemVer tag without prerelease or build metadata. */
export const assertStableReleaseTag = (tag) => {
  if (typeof tag !== "string" || !stableReleaseTagPattern.test(tag)) {
    throw new Error(`Stable release tag must look like vX.Y.Z, got ${JSON.stringify(tag)}`)
  }
}

/** Compares two stable release tags by numeric semantic version. */
export const compareStableReleaseTags = (left, right) => {
  assertStableReleaseTag(left)
  assertStableReleaseTag(right)
  const leftParts = left.slice(1).split(".").map(Number)
  const rightParts = right.slice(1).split(".").map(Number)
  return (
    leftParts[0] - rightParts[0] || leftParts[1] - rightParts[1] || leftParts[2] - rightParts[2]
  )
}

/** Rejects an accidental stable-channel downgrade while allowing idempotent promotion. */
export const assertPromotionDoesNotDowngrade = (candidateTag, currentTag) => {
  if (compareStableReleaseTags(candidateTag, currentTag) < 0) {
    throw new Error(`Refusing to promote ${candidateTag} over newer stable release ${currentTag}.`)
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
export const validateReleaseAssetNames = (names, tag) => {
  const selected = selectReleaseArtifacts(names, tag)
  const required = new Set([...Object.values(selected), "latest.json", "SHA256SUMS"])
  const allowed = new Set([...required, "release-provenance.json"])
  const uniqueNames = new Set(names)
  const duplicates = [...uniqueNames].filter(
    (name) => names.filter((candidate) => candidate === name).length > 1,
  )
  if (duplicates.length > 0) {
    throw new Error(`Release ${tag} has duplicate assets: ${duplicates.join(", ")}`)
  }
  const missing = [...required].filter((name) => !uniqueNames.has(name))
  if (missing.length > 0) throw new Error(`Release ${tag} is missing: ${missing.join(", ")}`)
  const unexpected = [...uniqueNames].filter((name) => !allowed.has(name))
  if (unexpected.length > 0) {
    throw new Error(`Release ${tag} has unexpected assets: ${unexpected.join(", ")}`)
  }
}

/** Builds the commit-bound manifest proving which workflow inputs produced a release candidate. */
export const createReleaseProvenance = ({ tag, commit, generatedAt, assets }) => {
  assertReleaseTag(tag)
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("Release commit SHA is invalid.")
  return {
    schemaVersion: 1,
    tag,
    commit,
    generatedAt,
    assets: assets
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(({ name, size, sha256, sha512 }) => ({ name, size, sha256, sha512 })),
  }
}

/** Verifies release provenance against the resolved tag commit and GitHub asset digests. */
export const validateReleaseProvenance = (provenance, { tag, commit, assets }) => {
  if (
    provenance?.schemaVersion !== 1 ||
    provenance.tag !== tag ||
    provenance.commit !== commit ||
    !Array.isArray(provenance.assets)
  ) {
    throw new Error(`Release provenance does not identify ${tag} at ${commit}.`)
  }
  const selectedNames = new Set(
    Object.values(
      selectReleaseArtifacts(
        assets.map(({ name }) => name),
        tag,
      ),
    ),
  )
  const provenanceNames = new Set(provenance.assets.map(({ name }) => name))
  if (
    selectedNames.size !== provenanceNames.size ||
    [...selectedNames].some((name) => !provenanceNames.has(name))
  ) {
    throw new Error("Release provenance does not contain the complete platform asset matrix.")
  }
  const remoteAssets = new Map(assets.map((asset) => [asset.name, asset]))
  for (const asset of provenance.assets) {
    const remote = remoteAssets.get(asset.name)
    if (
      remote?.size !== asset.size ||
      remote.digest !== `sha256:${asset.sha256}` ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
      typeof asset.sha512 !== "string" ||
      asset.sha512.length === 0
    ) {
      throw new Error(`Release provenance does not match GitHub asset ${asset.name}.`)
    }
  }
}

const artifactRequirements = (version) => ({
  macArm64Dmg: ["macOS ARM64 DMG", (name) => name === `DiffDash-${version}-mac-arm64.dmg`],
  macArm64Zip: ["macOS ARM64 ZIP", (name) => name === `DiffDash-${version}-mac-arm64.zip`],
  macArm64Blockmap: [
    "macOS ARM64 blockmap",
    (name) => name === `DiffDash-${version}-mac-arm64.zip.blockmap`,
  ],
  macX64Dmg: ["macOS Intel DMG", (name) => name === `DiffDash-${version}-mac-x64.dmg`],
  macX64Zip: ["macOS Intel ZIP", (name) => name === `DiffDash-${version}-mac-x64.zip`],
  macX64Blockmap: [
    "macOS Intel blockmap",
    (name) => name === `DiffDash-${version}-mac-x64.zip.blockmap`,
  ],
  macArm64Metadata: ["macOS ARM64 metadata", (name) => name === "latest-mac-arm64.yml"],
  macX64Metadata: ["macOS Intel metadata", (name) => name === "latest-mac-x64.yml"],
  linuxAppImage: [
    "Linux x64 AppImage",
    (name) =>
      name === `DiffDash-${version}-linux-x64.AppImage` ||
      name === `DiffDash-${version}-linux-x86_64.AppImage`,
  ],
  linuxMetadata: ["Linux updater metadata", (name) => name === "latest-linux.yml"],
  linuxDeb: [
    "Linux deb",
    (name) =>
      name === `DiffDash-${version}-linux-x64.deb` ||
      name === `DiffDash-${version}-linux-amd64.deb` ||
      name === `DiffDash-${version}-linux-x86_64.deb`,
  ],
})

/** Selects the deterministic platform artifact matrix used by publishing and promotion. */
export const selectReleaseArtifacts = (names, tag) => {
  const version = releaseVersionFromTag(tag)
  const sortedNames = names.toSorted((left, right) => left.localeCompare(right))
  const selected = {}
  const missing = []
  const ambiguous = []
  for (const [key, [label, matches]] of Object.entries(artifactRequirements(version))) {
    const matching = sortedNames.filter(matches)
    if (matching.length === 0) missing.push(label)
    else if (matching.length > 1) ambiguous.push(label)
    else selected[key] = matching[0]
  }
  if (missing.length > 0) throw new Error(`Release ${tag} is missing: ${missing.join(", ")}`)
  if (ambiguous.length > 0) {
    throw new Error(`Release ${tag} has multiple candidates for: ${ambiguous.join(", ")}`)
  }
  return selected
}

/** Normalizes a configured public download origin to one URL without a trailing slash. */
export const normalizePublicBaseUrl = (value) => {
  const trimmed = value.trim().replace(/\/+$/u, "")
  if (/^https?:\/\//u.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/** Parses and validates Electron Builder updater YAML fields used by update clients. */
export const validateUpdaterMetadata = (metadata, { version, artifact, size, sha512 }) => {
  const lines = metadata.split("\n")
  const rootValue = (key) =>
    lines
      .find((line) => line.startsWith(`${key}:`))
      ?.slice(key.length + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "")
  const fileStart = lines.findIndex((line) => line.trim() === `- url: ${artifact}`)
  const fileLines = fileStart === -1 ? [] : lines.slice(fileStart + 1, fileStart + 4)
  const fileValue = (key) =>
    fileLines
      .find((line) => line.trimStart().startsWith(`${key}:`))
      ?.trimStart()
      .slice(key.length + 1)
      .trim()
  const rootSha512 = rootValue("sha512")
  const fileSha512 = fileValue("sha512")
  const fileSize = Number(fileValue("size"))
  if (
    rootValue("version") !== version ||
    rootValue("path") !== artifact ||
    typeof rootSha512 !== "string" ||
    rootSha512.length === 0 ||
    fileSha512 !== rootSha512 ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    (size !== undefined && fileSize !== size) ||
    (sha512 !== undefined && rootSha512 !== sha512)
  ) {
    throw new Error(`Updater metadata does not contain a valid ${artifact} entry for ${version}.`)
  }
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
