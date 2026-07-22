/* eslint-disable no-await-in-loop -- Card rendering and FFmpeg segments preserve authored order. */
import { execFileSync } from "node:child_process"
import { copyFile, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

import type { CardCopy, DemoManifest } from "./framework"

const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg"
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe"
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const storyId = process.argv[2] ?? "diffdash-0.4.3"
const outputDirectory = resolve(packageRoot, "output", storyId)
const manifest = JSON.parse(
  await readFile(resolve(outputDirectory, "manifest.json"), "utf8"),
) as DemoManifest
if (manifest.story !== storyId) throw new Error(`Manifest story mismatch: ${manifest.story}`)

const width = 1440
const height = 900
const fps = 30
const cardDuration = 4.2
const transitionDuration = 0.6

const runFfmpeg = (arguments_: readonly string[]) => {
  execFileSync(ffmpegPath, arguments_, {
    stdio: ["ignore", "ignore", "inherit"],
    maxBuffer: 1 << 28,
  })
}

const durationOf = (file: string) =>
  Number.parseFloat(
    execFileSync(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    ).trim(),
  )

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/gu, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }
    return entities[character] ?? character
  })

const cardHtml = (card: CardCopy, iconSource: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${width}px;height:${height}px;overflow:hidden}
body{position:relative;color:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(1100px 660px at 16% 10%,rgba(21,198,132,.20),transparent 60%),radial-gradient(850px 560px at 94% 100%,rgba(51,111,255,.16),transparent 58%),linear-gradient(135deg,#07111f 0%,#0b1728 56%,#07111f 100%)}
.step{position:absolute;right:92px;top:72px;color:#fff;font-size:300px;font-weight:800;letter-spacing:-12px;line-height:1;opacity:.045}
.content{position:absolute;left:120px;top:50%;max-width:1040px;transform:translateY(-52%)}
.eyebrow{display:inline-block;margin-bottom:32px;border:1px solid rgba(105,224,177,.34);border-radius:999px;padding:10px 18px;color:#69e0b1;font-size:21px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
.title{font-size:88px;font-weight:800;letter-spacing:-2.6px;line-height:1.03}.caption{margin-top:28px;color:#a8b6ca;font-size:32px;line-height:1.35}.rule{width:96px;height:6px;margin-top:40px;border-radius:6px;background:linear-gradient(90deg,#15c684,#6b9cff)}
.brand{position:absolute;right:112px;bottom:78px;display:flex;align-items:center;gap:15px}.brand img{width:48px;height:48px}.brand span{font-size:38px;font-weight:750}
</style></head><body><div class="step">${escapeHtml(card.step)}</div><main class="content"><div class="eyebrow">${escapeHtml(card.eyebrow)}</div><h1 class="title">${escapeHtml(card.title)}</h1><p class="caption">${escapeHtml(card.caption)}</p><div class="rule"></div></main><div class="brand"><img src="${iconSource}" alt=""><span>DiffDash</span></div></body></html>`

const iconSource = `data:image/png;base64,${(
  await readFile(resolve(workspaceRoot, "packages/desktop/logo.png"))
).toString("base64")}`
const units = [
  { card: manifest.intro },
  ...manifest.clips.map((clip) => ({ card: clip.card, clip })),
  { card: manifest.outro },
]

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const cardPngs: string[] = []
try {
  for (const [index, unit] of units.entries()) {
    await page.setContent(cardHtml(unit.card, iconSource), { waitUntil: "load" })
    const path = resolve(outputDirectory, `.card-${index}.png`)
    await page.screenshot({ path })
    cardPngs.push(path)
  }
} finally {
  await browser.close()
}
const introPng = cardPngs[0]
if (introPng === undefined) throw new Error("Demo story did not render an intro card")
await copyFile(introPng, resolve(outputDirectory, `${storyId}-poster.png`))

const segments: { readonly path: string; readonly duration: number }[] = []
for (const [index, unit] of units.entries()) {
  const cardSegment = resolve(outputDirectory, `.seg-card-${index}.mp4`)
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
  const source = resolve(outputDirectory, unit.clip.file)
  const sourceDuration = durationOf(source)
  const clipDuration = Math.max(0.5, sourceDuration - unit.clip.trimStartSeconds)
  const clipSegment = resolve(outputDirectory, `.seg-clip-${index}.mp4`)
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
const finalDuration =
  segments.reduce((total, segment) => total + segment.duration, 0) -
  transitionDuration * (segments.length - 1)
filters.push(
  `[xf]fade=t=out:st=${Math.max(0, finalDuration - 0.6).toFixed(3)}:d=0.6:color=black[v]`,
)

const finalPath = resolve(outputDirectory, `${storyId}-demo.mp4`)
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
  finalPath,
])

await Promise.all(
  [...segments.map(({ path }) => path), ...cardPngs].map((path) => rm(path, { force: true })),
)
await writeFile(
  resolve(outputDirectory, "release.json"),
  `${JSON.stringify({ story: storyId, video: `${storyId}-demo.mp4`, poster: `${storyId}-poster.png`, durationSeconds: finalDuration }, null, 2)}\n`,
)
process.stdout.write(`[demo] combined ${finalPath} (${finalDuration.toFixed(1)}s)\n`)
