import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  createDashboardRequestHandler,
  decodeMediaPath,
  parseByteRange,
  resolveDashboardMedia,
} from "../src/dashboard"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("demo dashboard media requests", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: "none" })
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ kind: "range", start: 10, end: 19 })
    expect(parseByteRange("bytes=90-", 100)).toEqual({ kind: "range", start: 90, end: 99 })
    expect(parseByteRange("bytes=-12", 100)).toEqual({ kind: "range", start: 88, end: 99 })
    expect(parseByteRange("bytes=90-200", 100)).toEqual({ kind: "range", start: 90, end: 99 })
  })

  it.each([
    "bytes=",
    "bytes=-0",
    "bytes=100-",
    "bytes=30-20",
    "bytes=0-1,4-5",
    "items=0-1",
  ])("rejects invalid or unsatisfiable range %s", (range) => {
    expect(parseByteRange(range, 100)).toEqual({ kind: "unsatisfiable" })
  })

  it("rejects malformed, traversal, absolute, and unsupported media paths", () => {
    expect(() => decodeMediaPath("/media/%E0%A4%A/video.webm")).toThrow("percent encoding")
    expect(() => decodeMediaPath("/media/story/%2Fetc.webm")).toThrow("filename")
    expect(() => decodeMediaPath("/media/story/..%2Fsecret.webm")).toThrow("filename")
    expect(() => decodeMediaPath("/media/story/poster.png")).toThrow("extension")
  })

  it("serves only contained regular allow-listed files", async () => {
    const outputRoot = await mkdtemp(resolve(tmpdir(), "diffdash-dashboard-"))
    temporaryDirectories.push(outputRoot)
    const storyDirectory = resolve(outputRoot, "diffdash-0.4.3")
    await mkdir(storyDirectory)
    await writeFile(resolve(storyDirectory, "1-intro.webm"), "media")
    await mkdir(resolve(storyDirectory, "directory.webm"))
    const outsideFile = resolve(outputRoot, "outside.webm")
    await writeFile(outsideFile, "outside")
    await symlink(outsideFile, resolve(storyDirectory, "linked.webm"))

    await expect(
      resolveDashboardMedia(outputRoot, "/media/diffdash-0.4.3/1-intro.webm"),
    ).resolves.toMatchObject({ size: 5, contentType: "video/webm" })
    await expect(
      resolveDashboardMedia(outputRoot, "/media/diffdash-0.4.3/directory.webm"),
    ).resolves.toBeNull()
    await expect(
      resolveDashboardMedia(outputRoot, "/media/diffdash-0.4.3/missing.mp4"),
    ).resolves.toBeNull()
    await expect(
      resolveDashboardMedia(outputRoot, "/media/diffdash-0.4.3/linked.webm"),
    ).resolves.toBeNull()
  })

  it("returns 416 metadata for an unsatisfiable media range without opening a server", async () => {
    const outputRoot = await mkdtemp(resolve(tmpdir(), "diffdash-dashboard-"))
    temporaryDirectories.push(outputRoot)
    const storyDirectory = resolve(outputRoot, "story")
    await mkdir(storyDirectory)
    await writeFile(resolve(storyDirectory, "clip.webm"), "media")
    let status = 0
    let headers: Readonly<Record<string, string | number>> = {}
    let ended = false
    // SAFETY: the handler only reads these request fields before returning the 416 response.
    const request = {
      method: "GET",
      url: "/media/story/clip.webm",
      headers: { range: "bytes=99-" },
    } as unknown as IncomingMessage
    // SAFETY: this focused response double implements every method used by the 416 branch.
    const response = {
      writeHead(nextStatus: number, nextHeaders: Readonly<Record<string, string | number>>) {
        status = nextStatus
        headers = nextHeaders
        return this
      },
      end() {
        ended = true
        return this
      },
    } as unknown as ServerResponse

    await createDashboardRequestHandler(outputRoot, "<html></html>")(request, response)

    expect(status).toBe(416)
    expect(headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-range": "bytes */5",
    })
    expect(ended).toBe(true)
  })
})
