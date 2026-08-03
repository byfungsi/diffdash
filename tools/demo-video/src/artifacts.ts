import type { CardCopy, DemoManifest, DemoRelease } from "./framework"
import { assertDemoSlug } from "./paths"

type JsonRecord = Readonly<Record<string, unknown>>

/** Decodes and validates a recording manifest at the filesystem boundary. */
export const decodeDemoManifest = (source: string): DemoManifest => {
  const value = parseJsonRecord(source, "demo manifest")
  const clipsValue = value.clips
  if (!Array.isArray(clipsValue)) throw new Error("Demo manifest clips must be an array")
  const story = readString(value, "story")
  assertDemoSlug(story, "manifest story ID")
  const viewport = readRecord(value, "viewport")
  const clips = clipsValue.map((clipValue, index) => {
    const clip = requireRecord(clipValue, `Demo manifest clip ${index}`)
    const name = readString(clip, "name")
    assertDemoSlug(name, `manifest clip ${index} ID`)
    const file = readString(clip, "file")
    if (file !== `${name}.webm`) {
      throw new Error(`Demo manifest clip ${name} must use file ${name}.webm`)
    }
    return {
      name,
      file,
      trimStartSeconds: readNonNegativeFiniteNumber(clip, "trimStartSeconds"),
      card: decodeCard(readRecord(clip, "card"), `clip ${name} card`),
    }
  })
  if (new Set(clips.map(({ name }) => name)).size !== clips.length) {
    throw new Error("Demo manifest clip IDs must be unique")
  }
  return {
    schemaVersion: readLiteralOne(value, "schemaVersion"),
    story,
    title: readString(value, "title"),
    viewport: {
      width: readPositiveInteger(viewport, "width"),
      height: readPositiveInteger(viewport, "height"),
    },
    intro: decodeCard(readRecord(value, "intro"), "intro card"),
    outro: decodeCard(readRecord(value, "outro"), "outro card"),
    clips,
  }
}

/** Decodes and validates combined release metadata at the filesystem boundary. */
export const decodeDemoRelease = (source: string): DemoRelease => {
  const value = parseJsonRecord(source, "demo release")
  const story = readString(value, "story")
  assertDemoSlug(story, "release story ID")
  const video = readString(value, "video")
  const poster = readString(value, "poster")
  if (video !== `${story}-demo.mp4`)
    throw new Error("Demo release video name does not match its story")
  if (poster !== `${story}-poster.png`) {
    throw new Error("Demo release poster name does not match its story")
  }
  return {
    schemaVersion: readLiteralOne(value, "schemaVersion"),
    story,
    video,
    poster,
    durationSeconds: readPositiveFiniteNumber(value, "durationSeconds"),
  }
}

const decodeCard = (value: JsonRecord, label: string): CardCopy => ({
  step: readString(value, "step", label),
  eyebrow: readString(value, "eyebrow", label),
  title: readString(value, "title", label),
  caption: readString(value, "caption", label),
})

const parseJsonRecord = (source: string, label: string): JsonRecord => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  return requireRecord(value, label)
}

const requireRecord = (value: unknown, label: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  // SAFETY: the runtime checks above narrow this value to an object with string keys.
  return value as JsonRecord
}

const readRecord = (value: JsonRecord, key: string) => requireRecord(value[key], key)

const readString = (value: JsonRecord, key: string, label = "demo artifact") => {
  const result = value[key]
  if (typeof result !== "string") throw new Error(`${label} ${key} must be a string`)
  return result
}

const readLiteralOne = (value: JsonRecord, key: string): 1 => {
  if (value[key] !== 1) throw new Error(`${key} must be 1`)
  return 1
}

const readPositiveInteger = (value: JsonRecord, key: string) => {
  const result = value[key]
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }
  return result
}

const readNonNegativeFiniteNumber = (value: JsonRecord, key: string) => {
  const result = value[key]
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    throw new Error(`${key} must be a non-negative finite number`)
  }
  return result
}

const readPositiveFiniteNumber = (value: JsonRecord, key: string) => {
  const result = readNonNegativeFiniteNumber(value, key)
  if (result === 0) throw new Error(`${key} must be greater than zero`)
  return result
}
