import { execFileSync } from "node:child_process"
import { Schema } from "effect"

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

const MediaProbeJson = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(
      Schema.Struct({
        codec_type: Schema.String,
        codec_name: Schema.optionalKey(Schema.String),
        width: Schema.optionalKey(Schema.Finite),
        height: Schema.optionalKey(Schema.Finite),
        r_frame_rate: Schema.optionalKey(Schema.String),
        pix_fmt: Schema.optionalKey(Schema.String),
      }),
    ),
    format: Schema.Struct({ duration: Schema.optionalKey(Schema.String) }),
  }),
)

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
  let probe: Schema.Schema.Type<typeof MediaProbeJson>
  try {
    probe = Schema.decodeUnknownSync(MediaProbeJson)(source)
  } catch (cause) {
    throw new Error("ffprobe returned invalid JSON or an invalid response", { cause })
  }
  const durationSeconds =
    probe.format.duration === undefined || probe.format.duration.length === 0
      ? null
      : Number.parseFloat(probe.format.duration)
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new Error("ffprobe duration must be a non-negative finite number")
  }
  return {
    streams: probe.streams.map((stream) => ({
      codecType: stream.codec_type,
      codecName: stream.codec_name ?? null,
      width: stream.width ?? null,
      height: stream.height ?? null,
      frameRate: stream.r_frame_rate ?? null,
      pixelFormat: stream.pix_fmt ?? null,
    })),
    durationSeconds,
  }
}
