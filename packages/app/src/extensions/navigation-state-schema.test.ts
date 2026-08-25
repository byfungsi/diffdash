import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { makeExtensionNavigationStateCodec } from "./navigation-state-schema"

const Payload = Schema.Struct({ payload: Schema.String })
const codec = makeExtensionNavigationStateCodec(Payload)

describe("extension navigation state codec", () => {
  it("accepts an owner payload encoded as exactly one MiB of ASCII", () => {
    const serializedEmptyPayloadBytes = JSON.stringify({ payload: "" }).length
    const boundary = { payload: "x".repeat(1_048_576 - serializedEmptyPayloadBytes) }

    expect(JSON.stringify(boundary)).toHaveLength(1_048_576)
    expect(codec.encode(boundary)).toEqual(boundary)
    expect(codec.isValid(boundary)).toBe(true)
    expect(codec.decode(boundary)).toEqual(boundary)
  })

  it("rejects multibyte owner payloads larger than one MiB during encode, validation, and decode", () => {
    const serializedEmptyPayloadBytes = JSON.stringify({ payload: "" }).length
    const oversized = {
      payload: "🚀".repeat(Math.floor((1_048_576 - serializedEmptyPayloadBytes) / 4) + 1),
    }

    expect(JSON.stringify(oversized).length).toBeLessThan(1_048_576)
    expect(() => codec.encode(oversized)).toThrow(
      "Expected a project workspace navigation location no larger than one MiB",
    )
    expect(codec.isValid(oversized)).toBe(false)
    expect(() => codec.decode(oversized)).toThrow(
      "Expected a project workspace navigation location no larger than one MiB",
    )
  })
})
