import { ProjectWorkspaceNavigationLocation } from "@diffdash/domain/project-workspace"
import { HashMap, Option, Schema, SchemaGetter } from "effect"

import type { EncodedExtensionLocation } from "./extension-registry"

/** JSON-safe encoding, decoding, and validation for one extension-owned navigation schema. */
export interface ExtensionNavigationStateCodec<State> {
  readonly encode: (state: State) => EncodedExtensionLocation
  readonly decode: (state: EncodedExtensionLocation) => State
  readonly isValid: (state: EncodedExtensionLocation) => boolean
}

/** Creates the structured-clone-safe codec operations shared by navigation contributions. */
export const makeExtensionNavigationStateCodec = <State, Encoded>(
  schema: Schema.Codec<State, Encoded>,
): ExtensionNavigationStateCodec<State> => ({
  encode: (state) =>
    Schema.decodeUnknownSync(ProjectWorkspaceNavigationLocation)(Schema.encodeSync(schema)(state)),
  decode: (state) =>
    Schema.decodeUnknownSync(schema)(
      Schema.decodeUnknownSync(ProjectWorkspaceNavigationLocation)(state),
    ),
  isValid: (state) =>
    Option.isSome(
      Option.flatMap(
        Schema.decodeUnknownOption(ProjectWorkspaceNavigationLocation)(state),
        Schema.decodeUnknownOption(schema),
      ),
    ),
})

/** Creates a bounded entry-array schema decoded as an immutable `HashMap`. */
export const makeBoundedHashMapEntriesSchema = <Key, Value, EncodedKey, EncodedValue>(
  key: Schema.Codec<Key, EncodedKey>,
  value: Schema.Codec<Value, EncodedValue>,
  maxEntries: number,
): Schema.Codec<HashMap.HashMap<Key, Value>, readonly (readonly [EncodedKey, EncodedValue])[]> =>
  Schema.Array(Schema.Tuple([key, value])).pipe(
    Schema.check(Schema.isMaxLength(maxEntries)),
    Schema.decodeTo(
      Schema.declare<HashMap.HashMap<Key, Value>>(
        (candidate): candidate is HashMap.HashMap<Key, Value> => HashMap.isHashMap(candidate),
      ),
      {
        decode: SchemaGetter.transform((entries: readonly (readonly [Key, Value])[]) =>
          HashMap.fromIterable(entries),
        ),
        encode: SchemaGetter.transform((entries: HashMap.HashMap<Key, Value>) =>
          Array.from(entries),
        ),
      },
    ),
  )
