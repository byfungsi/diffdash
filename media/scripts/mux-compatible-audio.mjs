import { rename, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const workspaceRoot = resolve(import.meta.dirname, "../..")
const targetArgument = process.argv[2]

if (targetArgument === undefined) {
  throw new Error("Expected the rendered MP4 path")
}

const targetPath = resolve(workspaceRoot, targetArgument)
const temporaryPath = `${targetPath}.muxing.mp4`
const audioPath = resolve(workspaceRoot, "media/public/audio/promo-song.mp3")

try {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      targetPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-ar",
      "44100",
      "-t",
      "42",
      "-movflags",
      "+faststart",
      temporaryPath,
    ],
    { stdio: "inherit" },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`FFmpeg failed while muxing ${targetArgument}`)
  await rename(temporaryPath, targetPath)
} finally {
  await rm(temporaryPath, { force: true })
}
