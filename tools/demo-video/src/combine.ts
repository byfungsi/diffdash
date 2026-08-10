/* eslint-disable no-await-in-loop -- Card rendering and FFmpeg segments preserve authored order. */
import { execFileSync } from "node:child_process"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright"

import { decodeDemoManifest } from "./artifacts"
import { DemoArtifactTransaction } from "./artifact-transaction"
import { demoOutputRoot, demoVideoPackageRoot, demoWorkspaceRoot } from "./environment"
import { DEMO_VIEWPORT, type CardCopy, type DemoRelease } from "./framework"
import { escapeHtml } from "./html"
import { probeMedia } from "./media"
import { resolveContainedPath } from "./paths"
import { getStory } from "./stories"

const width = DEMO_VIEWPORT.width
const height = DEMO_VIEWPORT.height
const fps = 30
const cardDuration = 4.2
const transitionDuration = 0.6

/** Combines one complete recording into staged poster, video, and release metadata artifacts. */
export const combineDemo = async (storyId: string) => {
  const story = getStory(storyId)
  const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg"
  const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
  const outputDirectory = resolveContainedPath(demoOutputRoot, story.id)
  const manifest = decodeDemoManifest(
    await readFile(resolveContainedPath(outputDirectory, "manifest.json"), "utf8"),
  )
  if (manifest.story !== story.id) throw new Error(`Manifest story mismatch: ${manifest.story}`)
  const expectedClips = story.clips.map(({ name }) => name)
  const manifestClips = manifest.clips.map(({ name }) => name)
  if (
    manifestClips.length !== expectedClips.length ||
    !manifestClips.every((value, index) => value === expectedClips[index])
  ) {
    throw new Error("Manifest clip order does not match the registered story")
  }

  return DemoArtifactTransaction.run(demoOutputRoot, story.id, "combine", async (transaction) => {
    const { stagingDirectory } = transaction
    const iconSource = `data:image/png;base64,${(
      await readFile(resolve(demoWorkspaceRoot, "packages/desktop/logo.png"))
    ).toString("base64")}`
    const fontSource = `data:font/woff2;base64,${(
      await readFile(resolve(demoVideoPackageRoot, "src/host/Inter-Latin.woff2"))
    ).toString("base64")}`
    const units = [
      { card: manifest.intro },
      ...manifest.clips.map((clip) => ({ card: clip.card, clip })),
      { card: manifest.outro },
    ]
    const cardPngs = await renderCards(units, stagingDirectory, iconSource, fontSource)
    const introPng = cardPngs[0]
    if (introPng === undefined) throw new Error("Demo story did not render an intro card")
    const posterName = `${story.id}-poster.png`
    const videoName = `${story.id}-demo.mp4`
    const stagedPoster = resolveContainedPath(stagingDirectory, posterName)
    const stagedVideo = resolveContainedPath(stagingDirectory, videoName)
    await copyFile(introPng, stagedPoster)

    const runFfmpeg = (arguments_: readonly string[]) => {
      execFileSync(ffmpegPath, arguments_, {
        stdio: ["ignore", "ignore", "inherit"],
        maxBuffer: 1 << 28,
      })
    }
    const segments: { readonly path: string; readonly duration: number }[] = []
    for (const [index, unit] of units.entries()) {
      const cardSegment = resolveContainedPath(stagingDirectory, `.seg-card-${index}.mp4`)
      const cardPng = cardPngs[index]
      if (cardPng === undefined) throw new Error(`Missing rendered card ${index}`)
      runFfmpeg([
        "-y",
        "-loop",
        "1",
        "-i",
        cardPng,
        "-t",
        cardDuration.toFixed(3),
        "-vf",
        `scale=${width}:${height},fps=${fps},format=yuv420p`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        cardSegment,
      ])
      segments.push({ path: cardSegment, duration: cardDuration })

      if (!("clip" in unit) || unit.clip === undefined) continue
      const source = resolveContainedPath(outputDirectory, unit.clip.file)
      const sourceDuration = probeMedia(source, ffprobePath).durationSeconds
      if (sourceDuration === null || sourceDuration <= unit.clip.trimStartSeconds) {
        throw new Error(`Recorded clip ${unit.clip.name} has no content after its trim point`)
      }
      const clipDuration = sourceDuration - unit.clip.trimStartSeconds
      const clipSegment = resolveContainedPath(stagingDirectory, `.seg-clip-${index}.mp4`)
      runFfmpeg([
        "-y",
        "-ss",
        unit.clip.trimStartSeconds.toFixed(3),
        "-i",
        source,
        "-t",
        clipDuration.toFixed(3),
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setpts=PTS-STARTPTS,format=yuv420p`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        clipSegment,
      ])
      segments.push({ path: clipSegment, duration: clipDuration })
    }

    const inputs = segments.flatMap((segment) => ["-i", segment.path])
    const filters: string[] = []
    let previous = "[0:v]"
    let offset = 0
    for (let index = 1; index < segments.length; index += 1) {
      const priorSegment = segments[index - 1]
      if (priorSegment === undefined) throw new Error(`Missing segment ${index - 1}`)
      offset += priorSegment.duration - transitionDuration
      const output = index === segments.length - 1 ? "[xf]" : `[x${index}]`
      filters.push(
        `${previous}[${index}:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}${output}`,
      )
      previous = output
    }
    const plannedDuration =
      segments.reduce((total, segment) => total + segment.duration, 0) -
      transitionDuration * (segments.length - 1)
    filters.push(
      `[xf]fade=t=out:st=${Math.max(0, plannedDuration - 0.6).toFixed(3)}:d=0.6:color=black[v]`,
    )
    runFfmpeg([
      "-y",
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[v]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      stagedVideo,
    ])

    const actualDuration = probeMedia(stagedVideo, ffprobePath).durationSeconds
    if (actualDuration === null || actualDuration <= 0) {
      throw new Error("Combined demo has no measurable duration")
    }
    const release: DemoRelease = {
      schemaVersion: 1,
      story: story.id,
      video: videoName,
      poster: posterName,
      durationSeconds: actualDuration,
    }
    const stagedRelease = resolveContainedPath(stagingDirectory, "release.json")
    await writeFile(stagedRelease, `${JSON.stringify(release, null, 2)}\n`)
    await transaction.commit([release.poster, release.video, "release.json"])
    process.stdout.write(
      `[demo] combined ${resolveContainedPath(outputDirectory, videoName)} (${actualDuration.toFixed(1)}s)\n`,
    )
  })
}

/** Generates one self-contained chapter-card document using the bundled Inter font. */
export const cardHtml = (card: CardCopy, iconSource: string, fontSource: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url("${fontSource}") format("woff2");font-style:normal;font-weight:100 900;font-display:block}
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${width}px;height:${height}px;overflow:hidden}
body{position:relative;color:#fff;font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(1100px 660px at 16% 10%,rgba(21,198,132,.20),transparent 60%),radial-gradient(850px 560px at 94% 100%,rgba(51,111,255,.16),transparent 58%),linear-gradient(135deg,#07111f 0%,#0b1728 56%,#07111f 100%)}
.step{position:absolute;right:92px;top:72px;color:#fff;font-size:300px;font-weight:800;letter-spacing:-12px;line-height:1;opacity:.045}
.content{position:absolute;left:120px;top:50%;max-width:1040px;transform:translateY(-52%)}
.eyebrow{display:inline-block;margin-bottom:32px;border:1px solid rgba(105,224,177,.34);border-radius:999px;padding:10px 18px;color:#69e0b1;font-size:21px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
.title{font-size:88px;font-weight:800;letter-spacing:-2.6px;line-height:1.03}.caption{margin-top:28px;color:#a8b6ca;font-size:32px;line-height:1.35}.rule{width:96px;height:6px;margin-top:40px;border-radius:6px;background:linear-gradient(90deg,#15c684,#6b9cff)}
.brand{position:absolute;right:112px;bottom:78px;display:flex;align-items:center;gap:15px}.brand img{width:48px;height:48px}.brand span{font-size:38px;font-weight:750}
</style></head><body><div class="step">${escapeHtml(card.step)}</div><main class="content"><div class="eyebrow">${escapeHtml(card.eyebrow)}</div><h1 class="title">${escapeHtml(card.title)}</h1><p class="caption">${escapeHtml(card.caption)}</p><div class="rule"></div></main><div class="brand"><img src="${iconSource}" alt=""><span>DiffDash</span></div></body></html>`

const renderCards = async (
  units: readonly { readonly card: CardCopy }[],
  stagingDirectory: string,
  iconSource: string,
  fontSource: string,
) => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: DEMO_VIEWPORT, deviceScaleFactor: 1 })
  const paths: string[] = []
  try {
    for (const [index, unit] of units.entries()) {
      await page.setContent(cardHtml(unit.card, iconSource, fontSource), { waitUntil: "load" })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      const path = resolveContainedPath(stagingDirectory, `.card-${index}.png`)
      await page.screenshot({ path })
      paths.push(path)
    }
  } finally {
    await browser.close()
  }
  return paths
}
