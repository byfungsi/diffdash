import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"

import {
  nonNegativeNumberAt,
  numberAt,
  parseProviderJsonlObject,
  parseProviderJsonText,
  providerJsonContent,
  providerMetadata,
  recordAt,
  stringAt,
} from "./provider-json"

describe("provider JSON helpers", () => {
  it("parses plain and fenced JSON while preserving invalid input", () => {
    expect(parseProviderJsonText('{"ok":true}')).toEqual({ ok: true })
    expect(parseProviderJsonText('```json\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(parseProviderJsonText("  invalid  ")).toBe("  invalid  ")
  })

  it("reads typed record fields", () => {
    const record = { text: "value", finite: 2, negative: -1, nested: { ok: true }, array: [] }

    expect(stringAt(record, "text")).toBe("value")
    expect(numberAt(record, "finite")).toBe(2)
    expect(nonNegativeNumberAt(record, "negative")).toBeNull()
    expect(recordAt(record, "nested")).toEqual({ ok: true })
    expect(recordAt(record, "array")).toBeNull()
  })

  it("formats provider metadata and content", () => {
    expect(providerMetadata({ kept: "value", omitted: null })).toEqual({ kept: "value" })
    expect(providerJsonContent({ ok: true })).toBe('{"ok":true}')
  })

  it.effect("parses only JSONL object events", () =>
    Effect.gen(function* () {
      expect(yield* parseProviderJsonlObject('{"type":"event"}')).toEqual({ type: "event" })
      const array = yield* parseProviderJsonlObject("[]").pipe(Effect.either)
      const malformed = yield* parseProviderJsonlObject("{").pipe(Effect.either)
      expect(Either.isLeft(array) && array.left.reason).toBe("event is not a JSON object")
      expect(Either.isLeft(malformed)).toBe(true)
    }),
  )

  it("serializes cycles and BigInt and contains stringify failures", () => {
    const cyclic: { readonly count: bigint; self?: unknown } = { count: 12n }
    cyclic.self = cyclic
    const throwing = {
      toJSON: () => {
        throw new Error("stringify failed")
      },
    }

    expect(providerJsonContent(cyclic)).toBe('{"count":"12n","self":"[Circular]"}')
    expect(providerJsonContent(12n)).toBe('"12n"')
    expect(providerJsonContent(throwing)).toBe("[Unserializable]")
    expect(providerJsonContent(undefined)).toBe("undefined")
  })
})
