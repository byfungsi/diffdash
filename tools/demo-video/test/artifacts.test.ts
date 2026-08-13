import { describe, expect, it } from "vitest"

import { decodeDemoManifest, decodeDemoRelease } from "../src/artifacts"
import type { DemoRelease } from "../src/framework"
import { decodeMediaProbe, type MediaProbe } from "../src/media"
import { assertReleaseMatchesMedia } from "../src/verify"

const release: DemoRelease = {
  schemaVersion: 1,
  story: "diffdash-0.4.3",
  video: "diffdash-0.4.3-demo.mp4",
  poster: "diffdash-0.4.3-poster.png",
  durationSeconds: 42.04,
}

const probe: MediaProbe = {
  streams: [],
  durationSeconds: 42,
}

describe("demo artifact boundaries", () => {
  it("rejects malformed and unsafe manifest clip files", () => {
    expect(() => decodeDemoManifest("not-json")).toThrow("not valid JSON")
    expect(() =>
      decodeDemoManifest(
        JSON.stringify({
          schemaVersion: 1,
          story: "diffdash-0.4.3",
          title: "Demo",
          viewport: { width: 1440, height: 900 },
          intro: { step: "", eyebrow: "Intro", title: "Intro", caption: "Intro" },
          outro: { step: "", eyebrow: "Outro", title: "Outro", caption: "Outro" },
          clips: [
            {
              name: "1-clip",
              file: "../1-clip.webm",
              trimStartSeconds: 0,
              card: { step: "1", eyebrow: "Clip", title: "Clip", caption: "Clip" },
            },
          ],
        }),
      ),
    ).toThrow("must use file")
  })

  it("validates release metadata names and actual duration", () => {
    expect(decodeDemoRelease(JSON.stringify(release))).toEqual(release)
    expect(() => assertReleaseMatchesMedia(release.story, release, probe)).not.toThrow()
    expect(() =>
      assertReleaseMatchesMedia(release.story, { ...release, durationSeconds: 43 }, probe),
    ).toThrow("must match actual duration")
    expect(() => decodeDemoRelease(JSON.stringify({ ...release, video: "other.mp4" }))).toThrow(
      "video name",
    )
  })

  it("decodes the ffprobe boundary through its media schema", () => {
    expect(
      decodeMediaProbe(
        JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: 1440, height: 900 }],
          format: { duration: "42.04" },
        }),
      ),
    ).toEqual({
      streams: [
        {
          codecType: "video",
          codecName: "h264",
          width: 1440,
          height: 900,
          frameRate: null,
          pixelFormat: null,
        },
      ],
      durationSeconds: 42.04,
    })
    expect(() => decodeMediaProbe('{"streams":"invalid","format":{}}')).toThrow("invalid response")
  })
})
