/* eslint-disable no-await-in-loop -- Verification reports the exact clip that violates the delivery contract. */
import assert from "node:assert/strict"
import { open, readFile, readdir, stat } from "node:fs/promises"

import { decodeDemoManifest, decodeDemoRelease } from "./artifacts"
import { demoOutputRoot, demoVideoPackageRoot } from "./environment"
import { DEMO_VIEWPORT, type DemoRelease } from "./framework"
import { probeMedia, type MediaProbe } from "./media"
import { resolveContainedPath } from "./paths"
import { getStory } from "./stories"

const durationToleranceSeconds = 0.05

/** Verifies all recorded and combined artifacts for one registered story. */
export const verifyDemo = async (storyId: string) => {
  const story = getStory(storyId)
  const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
  const outputDirectory = resolveContainedPath(demoOutputRoot, story.id)
  const manifestText = await readFile(
    resolveContainedPath(outputDirectory, "manifest.json"),
    "utf8",
  )
  const releaseText = await readFile(resolveContainedPath(outputDirectory, "release.json"), "utf8")
  const manifest = decodeDemoManifest(manifestText)
  const release = decodeDemoRelease(releaseText)

  assert.equal(manifest.story, story.id)
  assert.equal(manifest.title, story.title)
  assert.deepEqual(manifest.viewport, DEMO_VIEWPORT)
  assert.deepEqual(manifest.intro, story.intro)
  assert.deepEqual(manifest.outro, story.outro)
  assert.deepEqual(
    manifest.clips.map(({ name }) => name),
    story.clips.map(({ name }) => name),
    "manifest clip order must match the registered story",
  )
  assert.deepEqual(
    manifest.clips.map(({ card }) => card),
    story.clips.map(({ card }) => card),
    "manifest chapter cards must match the registered story",
  )
  assert.ok(!manifestText.includes(demoVideoPackageRoot), "manifest must not leak absolute paths")
  assert.ok(!releaseText.includes(demoVideoPackageRoot), "release metadata must not leak paths")

  const files = await readdir(outputDirectory)
  assert.deepEqual(
    files.filter((file) => file.startsWith("FAILED-")),
    [],
    "recording directory contains failed-take screenshots",
  )

  for (const clip of manifest.clips) {
    const path = resolveContainedPath(outputDirectory, clip.file)
    await assertRegularNonEmptyFile(path, `recorded clip ${clip.name}`)
    const probe = probeMedia(path, ffprobePath)
    const video = probe.streams.find((stream) => stream.codecType === "video")
    assert.ok(video?.codecName === "vp8" || video?.codecName === "vp9")
    assert.equal(video.width, DEMO_VIEWPORT.width)
    assert.equal(video.height, DEMO_VIEWPORT.height)
    assert.ok(
      probe.durationSeconds !== null && probe.durationSeconds > clip.trimStartSeconds,
      `${clip.name} must contain media after its trim point`,
    )
  }

  const finalPath = resolveContainedPath(outputDirectory, release.video)
  await assertRegularNonEmptyFile(finalPath, "combined demo video")
  const finalProbe = probeMedia(finalPath, ffprobePath)
  const finalVideo = finalProbe.streams.find((stream) => stream.codecType === "video")
  assert.equal(finalVideo?.codecName, "h264")
  assert.equal(finalVideo?.width, DEMO_VIEWPORT.width)
  assert.equal(finalVideo?.height, DEMO_VIEWPORT.height)
  assert.equal(finalVideo?.frameRate, "30/1")
  assert.equal(finalVideo?.pixelFormat, "yuv420p")
  assert.equal(
    finalProbe.streams.some((stream) => stream.codecType === "audio"),
    false,
    "release reel must remain silent",
  )
  assertReleaseMatchesMedia(story.id, release, finalProbe)
  await assertFastStart(finalPath)

  const posterPath = resolveContainedPath(outputDirectory, release.poster)
  await assertRegularNonEmptyFile(posterPath, "demo poster")
  const posterProbe = probeMedia(posterPath, ffprobePath)
  const posterVideo = posterProbe.streams.find((stream) => stream.codecType === "video")
  assert.equal(posterVideo?.codecName, "png")
  assert.equal(posterVideo?.width, DEMO_VIEWPORT.width)
  assert.equal(posterVideo?.height, DEMO_VIEWPORT.height)
  process.stdout.write(
    `[demo] verified ${manifest.clips.length} clips and ${release.video} (${release.durationSeconds.toFixed(1)}s)\n`,
  )
}

/** Checks release filenames, story identity, and declared duration against probed media. */
export const assertReleaseMatchesMedia = (
  storyId: string,
  release: DemoRelease,
  probe: MediaProbe,
) => {
  assert.equal(release.story, storyId)
  assert.equal(release.video, `${storyId}-demo.mp4`)
  assert.equal(release.poster, `${storyId}-poster.png`)
  assert.ok(probe.durationSeconds !== null && probe.durationSeconds > 0)
  assert.ok(
    Math.abs(release.durationSeconds - probe.durationSeconds) <= durationToleranceSeconds,
    `release duration ${release.durationSeconds} must match actual duration ${probe.durationSeconds}`,
  )
}

const assertRegularNonEmptyFile = async (path: string, label: string) => {
  const fileStat = await stat(path)
  assert.ok(fileStat.isFile(), `${label} must be a regular file`)
  assert.ok(fileStat.size > 0, `${label} must not be empty`)
}

const assertFastStart = async (path: string) => {
  const handle = await open(path, "r")
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
}
