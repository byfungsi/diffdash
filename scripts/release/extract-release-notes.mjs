import { readFileSync } from "node:fs"
import { parseReleaseNotesArguments } from "./release-arguments.mjs"
import {
  releaseVersionFromChangelogHeading,
  releaseVersionFromVersionOrTag,
} from "./release-policy.mjs"

const { tag } = parseReleaseNotesArguments()
const version = releaseVersionFromVersionOrTag(tag.trim())
const changelog = readFileSync("packages/desktop/CHANGELOG.md", "utf8")
const lines = changelog.split(/\r?\n/)
const headingIndex = lines.findIndex((line) => headingVersion(line) === version)

if (headingIndex === -1) {
  throw new Error(`CHANGELOG.md does not contain release notes for ${version}.`)
}

let endIndex = lines.length
for (let index = headingIndex + 1; index < lines.length; index += 1) {
  if (/^##\s+/.test(lines[index] ?? "")) {
    endIndex = index
    break
  }
}

const notes = lines.slice(headingIndex, endIndex).join("\n").trim()

if (notes.length === 0) {
  throw new Error(`CHANGELOG.md release notes for ${version} are empty.`)
}

console.log(notes)

function headingVersion(line) {
  const match = /^##\s+(.+?)\s*$/.exec(line)
  if (match === null) return null
  return releaseVersionFromChangelogHeading(match[1])
}
