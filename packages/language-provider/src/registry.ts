import { LanguageAdapterId, LanguageId } from "@diffdash/domain/language"
import { Context, Effect, HashMap, HashSet, Layer, Option, Schema } from "effect"

import type { LanguageAdapterRegistration } from "./language-provider"

/** Two adapters claim the same stable adapter ID. */
export class DuplicateLanguageAdapterError extends Schema.TaggedError<DuplicateLanguageAdapterError>()(
  "DuplicateLanguageAdapterError",
  { adapterId: LanguageAdapterId },
) {}

/** Two adapters claim the same source file extension. */
export class AmbiguousLanguageExtensionError extends Schema.TaggedError<AmbiguousLanguageExtensionError>()(
  "AmbiguousLanguageExtensionError",
  {
    extension: Schema.String,
    adapterIds: Schema.Array(LanguageAdapterId),
  },
) {}

/** Two adapters claim the same source language identifier. */
export class AmbiguousLanguageIdError extends Schema.TaggedError<AmbiguousLanguageIdError>()(
  "AmbiguousLanguageIdError",
  {
    languageId: LanguageId,
    adapterIds: Schema.Array(LanguageAdapterId),
  },
) {}

/** Registry of bundled language adapter families. */
export class LanguageAdapterRegistry extends Context.Service<
  LanguageAdapterRegistry,
  {
    readonly list: Effect.Effect<readonly LanguageAdapterRegistration[]>
    readonly resolveExtension: (extension: string) => Option.Option<LanguageAdapterRegistration>
    readonly resolveLanguage: (languageId: LanguageId) => Option.Option<LanguageAdapterRegistration>
  }
>()("@diffdash/LanguageAdapterRegistry") {
  /** Builds a registry and rejects ambiguous adapter claims at composition time. */
  static readonly layer = (registrations: readonly LanguageAdapterRegistration[]) =>
    Layer.effect(
      LanguageAdapterRegistry,
      Effect.gen(function* () {
        let adapters = HashMap.empty<LanguageAdapterId, LanguageAdapterRegistration>()
        let extensions = HashMap.empty<string, LanguageAdapterRegistration>()
        let languages = HashMap.empty<LanguageId, LanguageAdapterRegistration>()

        for (const registration of registrations) {
          const adapterId = registration.descriptor.id
          if (HashMap.has(adapters, adapterId)) {
            return yield* DuplicateLanguageAdapterError.make({ adapterId })
          }
          for (const extension of HashSet.fromIterable(registration.descriptor.extensions)) {
            const existing = HashMap.get(extensions, extension)
            if (Option.isSome(existing)) {
              return yield* AmbiguousLanguageExtensionError.make({
                extension,
                adapterIds: [existing.value.descriptor.id, adapterId],
              })
            }
            extensions = HashMap.set(extensions, extension, registration)
          }
          for (const languageId of HashSet.fromIterable(registration.descriptor.languageIds)) {
            const existing = HashMap.get(languages, languageId)
            if (Option.isSome(existing)) {
              return yield* AmbiguousLanguageIdError.make({
                languageId,
                adapterIds: [existing.value.descriptor.id, adapterId],
              })
            }
            languages = HashMap.set(languages, languageId, registration)
          }
          adapters = HashMap.set(adapters, adapterId, registration)
        }

        return LanguageAdapterRegistry.of({
          list: Effect.succeed(Array.from(HashMap.values(adapters))),
          resolveExtension: (extension) => HashMap.get(extensions, extension),
          resolveLanguage: (languageId) => HashMap.get(languages, languageId),
        })
      }),
    )
}
