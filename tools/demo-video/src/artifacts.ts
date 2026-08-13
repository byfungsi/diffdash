import { Schema } from "effect"

import type { DemoManifest, DemoRelease } from "./framework"
import { assertDemoSlug } from "./paths"

const NonNegativeFinite = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PositiveFinite = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

const Card = Schema.Struct({
  step: Schema.String,
  eyebrow: Schema.String,
  title: Schema.String,
  caption: Schema.String,
})

const DemoManifestJson = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    story: Schema.String,
    title: Schema.String,
    viewport: Schema.Struct({ width: PositiveInteger, height: PositiveInteger }),
    intro: Card,
    outro: Card,
    clips: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        file: Schema.String,
        trimStartSeconds: NonNegativeFinite,
        card: Card,
      }),
    ),
  }),
)

const DemoReleaseJson = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    story: Schema.String,
    video: Schema.String,
    poster: Schema.String,
    durationSeconds: PositiveFinite,
  }),
)
const decodeDemoManifestJson = Schema.decodeUnknownSync(DemoManifestJson)
const decodeDemoReleaseJson = Schema.decodeUnknownSync(DemoReleaseJson)

/** Decodes and validates a recording manifest at the filesystem boundary. */
export const decodeDemoManifest = (source: string): DemoManifest => {
  let manifest: Schema.Schema.Type<typeof DemoManifestJson>
  try {
    manifest = decodeDemoManifestJson(source)
  } catch (cause) {
    throw new Error("Demo manifest is not valid JSON or does not match its schema", { cause })
  }
  assertDemoSlug(manifest.story, "manifest story ID")
  for (const [index, clip] of manifest.clips.entries()) {
    assertDemoSlug(clip.name, `manifest clip ${index} ID`)
    if (clip.file !== `${clip.name}.webm`) {
      throw new Error(`Demo manifest clip ${clip.name} must use file ${clip.name}.webm`)
    }
  }
  if (new Set(manifest.clips.map(({ name }) => name)).size !== manifest.clips.length) {
    throw new Error("Demo manifest clip IDs must be unique")
  }
  return manifest
}

/** Decodes and validates combined release metadata at the filesystem boundary. */
export const decodeDemoRelease = (source: string): DemoRelease => {
  let release: Schema.Schema.Type<typeof DemoReleaseJson>
  try {
    release = decodeDemoReleaseJson(source)
  } catch (cause) {
    throw new Error("Demo release is not valid JSON or does not match its schema", { cause })
  }
  assertDemoSlug(release.story, "release story ID")
  if (release.video !== `${release.story}-demo.mp4`) {
    throw new Error("Demo release video name does not match its story")
  }
  if (release.poster !== `${release.story}-poster.png`) {
    throw new Error("Demo release poster name does not match its story")
  }
  return release
}
