import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import {
  assertTagMatchesVersion,
  normalizePublicBaseUrl,
  releaseTagForVersion,
} from "./release-policy.mjs"

/** Derives and freezes the release identity and boundary inputs shared by release scripts. */
export const deriveReleaseContext = ({
  requestedTag,
  configuredCommit,
  commitRef,
  assetsDirectory,
  publicOrigin,
  packagePath = "packages/desktop/package.json",
  readFile = readFileSync,
  readDirectory = readdirSync,
  execute = execFileSync,
}) => {
  const packageJson = JSON.parse(readFile(packagePath, "utf8"))
  const packageVersion = packageJson.version
  const tag = requestedTag ?? releaseTagForVersion(packageVersion)
  assertTagMatchesVersion(tag, packageVersion)
  const resolvedCommitRef = commitRef === false ? undefined : (commitRef ?? tag)
  const tagCommit =
    resolvedCommitRef === undefined
      ? undefined
      : execute("git", ["rev-list", "-n", "1", resolvedCommitRef], {
          encoding: "utf8",
        }).trim()
  if (tagCommit !== undefined && !/^[0-9a-f]{40,64}$/u.test(tagCommit)) {
    throw new Error(`Could not resolve a commit for ${tag}.`)
  }
  if (configuredCommit !== undefined && configuredCommit !== tagCommit) {
    throw new Error(`Configured release commit does not match ${tag}.`)
  }
  const resolvedAssetsDirectory =
    assetsDirectory === undefined ? undefined : path.resolve(assetsDirectory)
  const assetNames =
    resolvedAssetsDirectory === undefined
      ? Object.freeze([])
      : Object.freeze(readDirectory(resolvedAssetsDirectory).toSorted())
  return Object.freeze({
    packageVersion,
    tag,
    commit: tagCommit,
    assetsDirectory: resolvedAssetsDirectory,
    assetNames,
    publicOrigin: publicOrigin === undefined ? undefined : normalizePublicBaseUrl(publicOrigin),
  })
}
