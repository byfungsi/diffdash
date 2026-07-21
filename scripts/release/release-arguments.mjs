import { parseArgs } from "node:util"

const parseOptions = (command, args, options, allowPositionals = false) => {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true })
  } catch (cause) {
    if (cause instanceof Error) {
      throw new Error(`Invalid ${command} arguments: ${cause.message}`, { cause })
    }
    throw cause
  }
}

const requireSinglePositional = (command, positionals, usage) => {
  if (positionals.length !== 1) {
    throw new Error(
      positionals.length === 0
        ? usage
        : `Invalid ${command} arguments: expected one positional argument, got ${positionals.length}.`,
    )
  }
  return positionals[0]
}

/** Parses the top-level local release orchestration arguments. */
export const parseLocalReleaseArguments = (args = process.argv.slice(2)) => {
  const { values } = parseOptions("release:local", args, {
    tag: { type: "string" },
    "assets-dir": { type: "string" },
    "mac-arch": { type: "string" },
    "skip-checks": { type: "boolean" },
    "skip-mac": { type: "boolean" },
    "skip-linux": { type: "boolean" },
    "skip-publish": { type: "boolean" },
    "allow-published": { type: "boolean" },
  })

  return {
    tag: values.tag,
    assetsDir: values["assets-dir"],
    macArch: values["mac-arch"],
    skipChecks: values["skip-checks"] ?? false,
    skipMac: values["skip-mac"] ?? false,
    skipLinux: values["skip-linux"] ?? false,
    skipPublish: values["skip-publish"] ?? false,
    allowPublished: values["allow-published"] ?? false,
  }
}

/** Parses local macOS release build arguments. */
export const parseMacReleaseArguments = (args = process.argv.slice(2)) => {
  const { values } = parseOptions("release:local:mac", args, {
    "assets-dir": { type: "string" },
    arch: { type: "string" },
    "package-existing": { type: "boolean" },
    "skip-notarize": { type: "boolean" },
    "submission-id": { type: "string" },
  })

  return {
    assetsDir: values["assets-dir"],
    arch: values.arch,
    packageExisting: values["package-existing"] ?? false,
    skipNotarize: values["skip-notarize"] ?? false,
    submissionId: values["submission-id"],
  }
}

/** Parses local Linux release build arguments. */
export const parseLinuxReleaseArguments = (args = process.argv.slice(2)) => {
  const { values } = parseOptions("release:local:linux", args, {
    "assets-dir": { type: "string" },
    platform: { type: "string" },
    image: { type: "string" },
  })

  return {
    assetsDir: values["assets-dir"],
    platform: values.platform,
    image: values.image,
  }
}

/** Parses release asset publishing arguments. */
export const parsePublishReleaseArguments = (args = process.argv.slice(2)) => {
  const { values } = parseOptions("release:local:publish", args, {
    tag: { type: "string" },
    "assets-dir": { type: "string" },
    "metadata-only": { type: "boolean" },
    "allow-published": { type: "boolean" },
    "require-existing-r2-provenance": { type: "boolean" },
  })

  return {
    tag: values.tag,
    assetsDir: values["assets-dir"],
    metadataOnly: values["metadata-only"] ?? false,
    allowPublished: values["allow-published"] ?? false,
    requireExistingR2Provenance: values["require-existing-r2-provenance"] ?? false,
  }
}

/** Parses stable release promotion arguments. */
export const parsePromoteReleaseArguments = (args = process.argv.slice(2)) => {
  const { values } = parseOptions("release:promote", args, {
    tag: { type: "string" },
  })
  return { tag: values.tag }
}

/** Parses public release verification arguments. */
export const parseVerifyReleaseArguments = (args = process.argv.slice(2)) => {
  const { values } = parseOptions("release:verify", args, {
    tag: { type: "string" },
    "base-url": { type: "string" },
  })
  return { tag: values.tag, baseUrl: values["base-url"] }
}

/** Parses notarization arguments without changing its timeout-aware command runner. */
export const parseNotarizeArguments = (args = process.argv.slice(2)) => {
  const { values, positionals } = parseOptions(
    "notarize-app",
    args,
    {
      "submission-id": { type: "string" },
      "timeout-minutes": { type: "string" },
      "poll-seconds": { type: "string" },
    },
    true,
  )
  const appPath = requireSinglePositional(
    "notarize-app",
    positionals,
    "Usage: node scripts/release/notarize-app.mjs <path-to-app> [--submission-id ID] [--timeout-minutes N] [--poll-seconds N]",
  )

  return {
    appPath,
    submissionId: values["submission-id"],
    timeoutMinutes: values["timeout-minutes"],
    pollSeconds: values["poll-seconds"],
  }
}

/** Parses the release-notes tag positional argument. */
export const parseReleaseNotesArguments = (args = process.argv.slice(2)) => {
  const { positionals } = parseOptions("release:notes", args, {}, true)
  return {
    tag: requireSinglePositional(
      "release:notes",
      positionals,
      "Usage: node scripts/release/extract-release-notes.mjs <tag>",
    ),
  }
}

/** Rejects unsupported arguments to the release tag command. */
export const parseCreateReleaseTagArguments = (args = process.argv.slice(2)) => {
  parseOptions("release:tag", args, {})
}
