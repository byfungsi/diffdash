import { readFileSync } from "node:fs"

const tag = process.argv[2]

if (tag === undefined || tag.trim().length === 0) {
  throw new Error("Usage: node scripts/extract-release-notes.mjs <tag>")
}

const version = tag.trim().replace(/^v/, "")
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

  const headingText = match[1]
  const versionMatch = /(?:^|@|\[|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\]|\s|$)/.exec(
    headingText,
  )
  return versionMatch?.[1] ?? null
}
