/* eslint-disable no-await-in-loop -- Verification reports the exact clip that violates the delivery contract. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, open, readFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { DemoManifest } from "./framework"

const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const storyId = process.argv[2] ?? "diffdash-0.4.3"
const outputDirectory = resolve(packageRoot, "output", storyId)
const manifestText = await readFile(resolve(outputDirectory, "manifest.json"), "utf8")
const manifest = JSON.parse(manifestText) as DemoManifest

assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.story, storyId)
assert.equal(manifest.clips.length, 7)
assert.equal(new Set(manifest.clips.map(({ name }) => name)).size, manifest.clips.length)
assert.ok(!manifestText.includes(packageRoot), "manifest must not leak absolute workspace paths")

const files = await readdir(outputDirectory)
assert.deepEqual(
  files.filter((file) => file.startsWith("FAILED-")),
  [],
  "recording directory contains failed-take screenshots",
)

for (const clip of manifest.clips) {
  const path = resolve(outputDirectory, clip.file)
  await access(path)
  const probe = probeFile(path)
  const video = probe.streams.find((stream) => stream.codec_type === "video")
  assert.ok(video?.codec_name === "vp8" || video?.codec_name === "vp9")
  assert.equal(video.width, 1440)
  assert.equal(video.height, 900)
  assert.ok(Number(probe.format.duration) > clip.trimStartSeconds + 1)
}

const finalPath = resolve(outputDirectory, `${storyId}-demo.mp4`)
const finalProbe = probeFile(finalPath)
const finalVideo = finalProbe.streams.find((stream) => stream.codec_type === "video")
assert.equal(finalVideo?.codec_name, "h264")
assert.equal(finalVideo?.width, 1440)
assert.equal(finalVideo?.height, 900)
assert.equal(finalVideo?.r_frame_rate, "30/1")
assert.equal(finalVideo?.pix_fmt, "yuv420p")
assert.equal(
  finalProbe.streams.some((stream) => stream.codec_type === "audio"),
  false,
  "Xenith-style release reel must remain silent",
)
assert.ok(Number(finalProbe.format.duration) > 60)

const handle = await open(finalPath, "r")
try {
  const header = Buffer.alloc(1_048_576)
  const { bytesRead } = await handle.read(header, 0, header.length, 0)
  const headerText = header.subarray(0, bytesRead).toString("latin1")
  const moov = headerText.indexOf("moov")
  const mdat = headerText.indexOf("mdat")
  assert.ok(moov >= 0 && mdat >= 0 && moov < mdat, "MP4 must use fast-start atom ordering")
} finally {
  await handle.close()
}

await access(resolve(outputDirectory, `${storyId}-poster.png`))
await access(resolve(outputDirectory, "release.json"))
process.stdout.write(`[demo] verified seven clips and ${storyId}-demo.mp4\n`)

interface ProbeResult {
  readonly streams: readonly {
    readonly codec_type: string
    readonly codec_name?: string
    readonly width?: number
    readonly height?: number
    readonly r_frame_rate?: string
    readonly pix_fmt?: string
  }[]
  readonly format: { readonly duration: string }
}

function probeFile(path: string): ProbeResult {
  return JSON.parse(
    execFileSync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" },
    ),
  ) as ProbeResult
}
