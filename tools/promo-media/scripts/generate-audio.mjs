import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const packageRoot = resolve(import.meta.dirname, "..")
const workspaceRoot = resolve(packageRoot, "../..")
const outputDirectory = resolve(packageRoot, "public/audio")
const packageSource = resolve(packageRoot, "recall_promo_song.mp3")
const sourcePath = existsSync(packageSource)
  ? packageSource
  : resolve(workspaceRoot, "media/recall_promo_song.mp3")

await mkdir(outputDirectory, { recursive: true })

renderAudio("promo-song.mp3", [
  "-i",
  sourcePath,
  "-t",
  "42",
  "-map",
  "0:a:0",
  "-c:a",
  "copy",
  "-avoid_negative_ts",
  "make_zero",
])

function renderAudio(fileName, inputArguments) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...inputArguments,
      resolve(outputDirectory, fileName),
    ],
    { stdio: "inherit" },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`FFmpeg failed while generating ${fileName}`)
}
