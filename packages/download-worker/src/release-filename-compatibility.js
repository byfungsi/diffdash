const exact = (name) => [name]

/** Resolves the accepted historical release filenames into one explicit artifact-role map. */
export const resolveCompatibleReleaseArtifactNames = (names, version) => {
  const candidates = {
    macArm64Dmg: exact(`DiffDash-${version}-mac-arm64.dmg`),
    macArm64Zip: exact(`DiffDash-${version}-mac-arm64.zip`),
    macArm64Blockmap: exact(`DiffDash-${version}-mac-arm64.zip.blockmap`),
    macX64Dmg: exact(`DiffDash-${version}-mac-x64.dmg`),
    macX64Zip: exact(`DiffDash-${version}-mac-x64.zip`),
    macX64Blockmap: exact(`DiffDash-${version}-mac-x64.zip.blockmap`),
    macArm64Metadata: exact("latest-mac-arm64.yml"),
    macX64Metadata: exact("latest-mac-x64.yml"),
    linuxAppImage: [
      `DiffDash-${version}-linux-x64.AppImage`,
      `DiffDash-${version}-linux-x86_64.AppImage`,
    ],
    linuxMetadata: exact("latest-linux.yml"),
    linuxDeb: [
      `DiffDash-${version}-linux-x64.deb`,
      `DiffDash-${version}-linux-amd64.deb`,
      `DiffDash-${version}-linux-x86_64.deb`,
    ],
  }
  const available = new Set(names)
  const selected = {}
  const missing = []
  const ambiguous = []
  for (const [role, acceptedNames] of Object.entries(candidates)) {
    const matches = acceptedNames.filter((name) => available.has(name))
    if (matches.length === 0) missing.push(role)
    else if (matches.length > 1) ambiguous.push(role)
    else selected[role] = matches[0]
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    missing: Object.freeze(missing),
    ambiguous: Object.freeze(ambiguous),
  })
}
