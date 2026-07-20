import { Schema } from "effect"

/** Creates a renderer-local JSON atom-key codec backed by boundary schema decoding. */
export const makeSchemaAtomKeyCodec = <A, I>(schema: Schema.Schema<A, I>) => {
  const decode = Schema.decodeUnknownSync(schema)
  return {
    encode: (value: I) => JSON.stringify(value),
    decode: (key: string): A | null => {
      try {
        return decode(JSON.parse(key))
      } catch {
        return null
      }
    },
  }
}
