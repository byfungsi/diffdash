import { describe, expect, it } from "@effect/vitest"
import { assertJsonPayloadWithinBudget, jsonSafeUtf8ByteLength } from "./payload-budget"

describe("IPC payload budgets", () => {
  it("measures aggregate JSON UTF-8 bytes and honors the exact boundary", () => {
    const payload = { label: "café", values: ["é", "東京"] }
    const expected = new TextEncoder().encode(JSON.stringify(payload)).byteLength

    expect(jsonSafeUtf8ByteLength(payload)).toBe(expected)
    expect(assertJsonPayloadWithinBudget(payload, expected)).toBe(expected)
    expect(() => assertJsonPayloadWithinBudget(payload, expected - 1)).toThrowError(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    )
  })

  it("rejects aggregate many-small-value overflow instead of checking only leaves", () => {
    const payload = { values: Array.from({ length: 2_000 }, () => "x") }
    const bytes = jsonSafeUtf8ByteLength(payload)

    expect(bytes).toBeGreaterThan(2_000)
    expect(() => assertJsonPayloadWithinBudget(payload, 2_000)).toThrowError(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    )
  })

  it("bounds structural depth before serialization", () => {
    let payload: { child?: unknown } = {}
    const root = payload
    for (let index = 0; index < 70; index += 1) {
      const child = {}
      payload.child = child
      payload = child
    }

    expect(() => jsonSafeUtf8ByteLength(root)).toThrowError(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    )
  })
})
