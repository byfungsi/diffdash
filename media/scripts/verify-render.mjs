import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const workspaceRoot = resolve(import.meta.dirname, "../..")
const outputDirectory = resolve(workspaceRoot, "media/output")
const canonicalAudioPath = resolve(workspaceRoot, "media/public/audio/promo-song.mp3")
const captureManifestPath = resolve(
  workspaceRoot,
  "media/public/captures/ai-review/capture-manifest.json",
)
const reviewFrames = [60, 195, 450, 720, 1020, 1140]
const deliveries = [
  {
    id: "landscape",
    fileName: "diffdash-v0.2.1-landscape.mp4",
    contactSheet: "diffdash-v0.2.1-landscape-contact-sheet.png",
    width: 1920,
    height: 1080,
    contactCell: { width: 480, height: 270 },
  },
  {
    id: "vertical",
    fileName: "diffdash-v0.2.1-vertical.mp4",
    contactSheet: "diffdash-v0.2.1-vertical-contact-sheet.png",
    width: 1080,
    height: 1920,
    contactCell: { width: 270, height: 480 },
  },
]

await mkdir(outputDirectory, { recursive: true })

const packageJson = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"))
const captureManifest = JSON.parse(await readFile(captureManifestPath, "utf8"))
const canonicalAudioPacketHash = hashAudioPackets(canonicalAudioPath)
const canonicalAudioLoudness = measureLoudness(canonicalAudioPath)
const ignoreRules = new Set(
  (await readFile(resolve(workspaceRoot, ".gitignore"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
)

for (const expectedRule of [
  "demo/.cache/",
  "media/.cache/",
  "media/output/",
  "media/public/audio/",
  "media/public/captures/",
  "media/public/fonts/",
]) {
  assert(ignoreRules.has(expectedRule), `Missing generated-artifact ignore rule: ${expectedRule}`)
}

const packagedFiles = packageJson.build?.files
assert(Array.isArray(packagedFiles), "Electron Builder file allowlist is missing")
assert(
  packagedFiles.every((entry) => typeof entry === "string" && !/^(demo|media)(\/|$)/.test(entry)),
  "Demo or media tooling can enter Electron release artifacts",
)

const verifiedDeliveries = await Promise.all(
  deliveries.map(async (delivery) => {
    const videoPath = resolve(outputDirectory, delivery.fileName)
    const contactSheetPath = resolve(outputDirectory, delivery.contactSheet)
    const probe = probeMedia(videoPath)
    const video = probe.streams.find((stream) => stream.codec_type === "video")
    const audio = probe.streams.find((stream) => stream.codec_type === "audio")

    assert(video !== undefined, `${delivery.id} delivery has no video stream`)
    assert(audio !== undefined, `${delivery.id} delivery has no audio stream`)
    assert(video.codec_name === "h264", `${delivery.id} video codec is not H.264`)
    assert(video.width === delivery.width, `${delivery.id} width is not ${delivery.width}`)
    assert(video.height === delivery.height, `${delivery.id} height is not ${delivery.height}`)
    assert(video.avg_frame_rate === "30/1", `${delivery.id} frame rate is not 30 fps`)
    assert(video.nb_frames === "1260", `${delivery.id} frame count is not 1260`)
    assert(Number(video.duration) === 42, `${delivery.id} video duration is not 42 seconds`)
    assert(
      video.pix_fmt === "yuv420p" || video.pix_fmt === "yuvj420p",
      `${delivery.id} pixel format is not 4:2:0 compatible`,
    )
    assert(audio.codec_name === "aac", `${delivery.id} audio codec is not AAC`)
    assert(audio.sample_rate === "44100", `${delivery.id} audio sample rate is not 44.1 kHz`)
    assert(audio.channels === 2, `${delivery.id} audio is not stereo`)
    const loudness = measureLoudness(videoPath)
    assert(
      Math.abs(loudness.integratedLufs - canonicalAudioLoudness.integratedLufs) <= 0.6,
      `${delivery.id} audio loudness differs from the cropped source track`,
    )
    assert(
      Number(probe.format.duration) >= 35 && Number(probe.format.duration) <= 45,
      `${delivery.id} container duration is outside 35–45 seconds`,
    )
    assert(
      !JSON.stringify(probe).includes(workspaceRoot),
      `${delivery.id} metadata contains the local workspace path`,
    )

    createContactSheet(videoPath, contactSheetPath, delivery.contactCell)
    const [videoStats, contactSheetStats, videoHash, contactSheetHash] = await Promise.all([
      stat(videoPath),
      stat(contactSheetPath),
      hashFile(videoPath),
      hashFile(contactSheetPath),
    ])
    return {
      id: delivery.id,
      fileName: delivery.fileName,
      sha256: videoHash,
      size: videoStats.size,
      video: {
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        pixelFormat: video.pix_fmt,
        fps: 30,
        durationSeconds: Number(video.duration),
        frameCount: Number(video.nb_frames),
      },
      audio: {
        codec: audio.codec_name,
        sampleRate: Number(audio.sample_rate),
        channels: audio.channels,
        durationSeconds: Number(audio.duration),
        sourcePacketSha256: canonicalAudioPacketHash,
        sourceIntegratedLufs: canonicalAudioLoudness.integratedLufs,
        ...loudness,
      },
      contactSheet: {
        fileName: delivery.contactSheet,
        sha256: contactSheetHash,
        size: contactSheetStats.size,
        frames: reviewFrames,
      },
    }
  }),
)

const manifest = {
  campaignId: captureManifest.campaignId,
  scenarioId: captureManifest.scenarioId,
  appVersion: packageJson.version,
  verifiedAt: new Date().toISOString(),
  scenarioAndCaptureCacheKey: captureManifest.cacheKey,
  capture: {
    capturedAt: captureManifest.capturedAt,
    viewport: captureManifest.viewport,
    deviceScaleFactor: captureManifest.deviceScaleFactor,
    locale: captureManifest.locale,
    timezone: captureManifest.timezone,
    theme: captureManifest.theme,
    checkpoints: captureManifest.checkpoints.map(({ name, fileName }) => ({ name, fileName })),
  },
  composition: {
    fps: 30,
    durationSeconds: 42,
    durationInFrames: 1260,
    remotionVersion: packageJson.devDependencies.remotion,
  },
  tools: {
    node: process.version,
    ffmpeg: firstLine(run("ffmpeg", ["-version"])),
    ffprobe: firstLine(run("ffprobe", ["-version"])),
  },
  provenance: [
    "media/audio-provenance.md",
    "demo/capture/src/INTER-LICENSE.txt",
    "demo/scenarios/atomic-webhook-replay/assets/provenance.json",
  ],
  packaging: {
    generatedArtifactsIgnored: true,
    electronBuilderFiles: packagedFiles,
    demoAndMediaExcludedFromElectron: true,
  },
  deliveries: verifiedDeliveries,
}

const manifestPath = resolve(outputDirectory, "diffdash-v0.2.1-render-manifest.json")
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(
  `Verified ${verifiedDeliveries.length} deliveries and wrote media/output/${manifestPath.split("/").at(-1)}\n`,
)

function probeMedia(path) {
  return JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,codec_type,width,height,pix_fmt,avg_frame_rate,sample_rate,channels,duration,nb_frames:format=duration,size,format_name:format_tags",
      "-of",
      "json",
      path,
    ]),
  )
}

function createContactSheet(inputPath, outputPath, cell) {
  const select = reviewFrames.map((frame) => `eq(n\\,${frame})`).join("+")
  const filter = [
    `select=${select}`,
    `scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease`,
    `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2:color=0x06101c`,
    "tile=3x2",
  ].join(",")
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-frames:v",
    "1",
    outputPath,
  ])
}

function measureLoudness(path) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`FFmpeg loudness analysis failed: ${result.stderr}`)
  const start = result.stderr.lastIndexOf("{")
  const end = result.stderr.lastIndexOf("}") + 1
  assert(start >= 0 && end > start, "FFmpeg loudness analysis did not return JSON")
  const measurement = JSON.parse(result.stderr.slice(start, end))
  return {
    integratedLufs: Number(measurement.input_i),
    truePeakDbtp: Number(measurement.input_tp),
    loudnessRangeLu: Number(measurement.input_lra),
  }
}

function hashAudioPackets(path) {
  const output = run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    path,
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ]).trim()
  const match = /^SHA256=([a-f0-9]{64})$/.exec(output)
  assert(match !== null, "FFmpeg audio packet hashing did not return a SHA-256 digest")
  return match[1]
}

async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

function firstLine(value) {
  const line = value.split("\n")[0]
  assert(line !== undefined && line.length > 0, "Tool version output is empty")
  return line
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
