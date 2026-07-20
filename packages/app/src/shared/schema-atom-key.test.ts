import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { makeSchemaAtomKeyCodec } from "./schema-atom-key"

const SearchKey = Schema.Struct({ providerId: Schema.String, query: Schema.String })

describe("makeSchemaAtomKeyCodec", () => {
  it("preserves JSON key strings while validating decoded values", () => {
    const codec = makeSchemaAtomKeyCodec(SearchKey)
    const value = { providerId: "github", query: "diffdash" }

    expect(codec.encode(value)).toBe(JSON.stringify(value))
    expect(codec.decode(codec.encode(value))).toEqual(value)
    expect(codec.decode('{"providerId":42,"query":"diffdash"}')).toBeNull()
    expect(codec.decode("not-json")).toBeNull()
  })
})
