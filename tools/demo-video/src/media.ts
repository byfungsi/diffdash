import { execFileSync } from "node:child_process"

/** Validated ffprobe information used by combination and verification. */
export interface MediaProbe {
  readonly streams: readonly {
    readonly codecType: string
    readonly codecName: string | null
    readonly width: number | null
    readonly height: number | null
    readonly frameRate: string | null
    readonly pixelFormat: string | null
  }[]
  readonly durationSeconds: number | null
}

/** Runs ffprobe and validates the JSON response before returning media metadata. */
export const probeMedia = (path: string, ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe") =>
  decodeMediaProbe(
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
  )

/** Decodes the subset of ffprobe JSON trusted by demo tooling. */
export const decodeMediaProbe = (source: string): MediaProbe => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("ffprobe returned invalid JSON")
  }
  const root = requireRecord(value, "ffprobe response")
  if (!Array.isArray(root.streams)) throw new Error("ffprobe streams must be an array")
  const format = requireRecord(root.format, "ffprobe format")
  const durationValue = format.duration
  const durationSeconds =
    typeof durationValue === "string" && durationValue.length > 0
      ? Number.parseFloat(durationValue)
      : null
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new Error("ffprobe duration must be a non-negative finite number")
  }
  return {
    streams: root.streams.map((streamValue) => {
      const stream = requireRecord(streamValue, "ffprobe stream")
      return {
        codecType: readRequiredString(stream, "codec_type"),
        codecName: readOptionalString(stream, "codec_name"),
        width: readOptionalNumber(stream, "width"),
        height: readOptionalNumber(stream, "height"),
        frameRate: readOptionalString(stream, "r_frame_rate"),
        pixelFormat: readOptionalString(stream, "pix_fmt"),
      }
    }),
    durationSeconds,
  }
}

type JsonRecord = Readonly<Record<string, unknown>>

const requireRecord = (value: unknown, label: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  // SAFETY: the runtime checks above narrow this value to an object with string keys.
  return value as JsonRecord
}

const readRequiredString = (value: JsonRecord, key: string) => {
  const result = value[key]
  if (typeof result !== "string") throw new Error(`ffprobe ${key} must be a string`)
  return result
}

const readOptionalString = (value: JsonRecord, key: string) => {
  const result = value[key]
  if (result === undefined) return null
  if (typeof result !== "string") throw new Error(`ffprobe ${key} must be a string`)
  return result
}

const readOptionalNumber = (value: JsonRecord, key: string) => {
  const result = value[key]
  if (result === undefined) return null
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`ffprobe ${key} must be a finite number`)
  }
  return result
}
