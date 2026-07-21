import assert from "node:assert/strict"
import test from "node:test"

import { verifyPublicReleaseOnce } from "./release-verification.mjs"

const tag = "v0.3.1"
const version = "0.3.1"
const origin = "https://download.example.test"
const digest = "a".repeat(64)
const assetNames = [
  "DiffDash-0.3.1-linux-amd64.deb",
  "DiffDash-0.3.1-linux-x86_64.AppImage",
  "DiffDash-0.3.1-mac-arm64.dmg",
  "DiffDash-0.3.1-mac-arm64.zip",
  "DiffDash-0.3.1-mac-arm64.zip.blockmap",
  "DiffDash-0.3.1-mac-x64.dmg",
  "DiffDash-0.3.1-mac-x64.zip",
  "DiffDash-0.3.1-mac-x64.zip.blockmap",
  "latest-linux.yml",
  "latest-mac-arm64.yml",
  "latest-mac-x64.yml",
  "SHA256SUMS",
]
const assets = assetNames.map((name) => ({
  name,
  url: `${origin}/releases/${tag}/${encodeURIComponent(name)}`,
  size: 1,
  sha256: digest,
}))
const latest = { version, tag, generatedAt: "2026-07-20T00:00:00.000Z", assets }
const checksums = assetNames
  .filter((name) => name !== "SHA256SUMS")
  .map((name) => `${digest}  ${name}`)
  .join("\n")

test("verifies stable metadata, updater feeds, downloads, and release assets", async () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- This fake belongs to one scenario.
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    if (method === "HEAD" && url.pathname.startsWith(`/releases/${tag}/`)) {
      return new Response(null, { status: 200, headers: { "content-length": "1" } })
    }
    if (method === "HEAD" && url.pathname.startsWith("/updates/stable/")) {
      return new Response(null, { status: 200 })
    }
    if (method === "HEAD") {
      const artifact =
        url.pathname === "/macos" && url.searchParams.get("arch") === "arm64"
          ? "DiffDash-0.3.1-mac-arm64.dmg"
          : url.pathname === "/macos"
            ? "DiffDash-0.3.1-mac-x64.dmg"
            : url.pathname === "/linux/appimage"
              ? "DiffDash-0.3.1-linux-x86_64.AppImage"
              : "DiffDash-0.3.1-linux-amd64.deb"
      return new Response(null, {
        status: 302,
        headers: { location: `${origin}/releases/${tag}/${artifact}` },
      })
    }
    if (url.pathname === "/stable.json") {
      return Response.json({ version, tag, promotedAt: "2026-07-20T00:00:00.000Z" })
    }
    if (url.pathname === "/latest.json" || url.pathname === `/releases/${tag}/latest.json`) {
      return Response.json(latest)
    }
    if (url.pathname === `/releases/${tag}/SHA256SUMS`) {
      return new Response(`${checksums}\n`)
    }
    if (url.pathname.includes("/macos/arm64/")) {
      return new Response(updaterMetadata("DiffDash-0.3.1-mac-arm64.zip"))
    }
    if (url.pathname.includes("/macos/x64/")) {
      return new Response(updaterMetadata("DiffDash-0.3.1-mac-x64.zip"))
    }
    if (url.pathname.includes("/linux/x64/")) {
      return new Response(updaterMetadata("DiffDash-0.3.1-linux-x86_64.AppImage"))
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  }

  await assert.doesNotReject(() => verifyPublicReleaseOnce({ tag, baseUrl: origin, fetchImpl }))
})

const updaterMetadata = (artifact) => `version: ${version}
files:
  - url: ${artifact}
    sha512: digest
    size: 1
path: ${artifact}
sha512: digest
`

test("rejects a stable pointer for another release", async () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- This fake documents the mismatch scenario inline.
  const fetchImpl = async () => Response.json({ version: "0.3.0", tag: "v0.3.0" })
  await assert.rejects(
    () => verifyPublicReleaseOnce({ tag, baseUrl: origin, fetchImpl }),
    /stable\.json does not identify v0\.3\.1/u,
  )
})
