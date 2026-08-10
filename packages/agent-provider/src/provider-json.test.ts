import { describe, expect, it } from "@effect/vitest"

import { parseProviderJsonText, providerJsonContent } from "./provider-json"

describe("provider JSON boundaries", () => {
  it("parses plain and fenced JSON while preserving invalid input", () => {
    expect(parseProviderJsonText('{"ok":true}')).toEqual({ ok: true })
    expect(parseProviderJsonText('```json\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(parseProviderJsonText("  invalid  ")).toBe("  invalid  ")
  })

  it("formats provider content", () => {
    expect(providerJsonContent({ ok: true })).toBe('{"ok":true}')
  })

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
