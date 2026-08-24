import { describe, expect, it } from "@effect/vitest"
import { LanguageAdapterId, LanguageId } from "@diffdash/domain/language"
import { Effect, Exit, Option } from "effect"

import {
  LanguageAdapterCapabilities,
  LanguageAdapterDescriptor,
  type LanguageAdapterRegistration,
} from "./language-provider"
import { LanguageAdapterRegistry } from "./registry"

const registration = (
  id: string,
  languageId: string,
  extension: string,
): LanguageAdapterRegistration => ({
  descriptor: new LanguageAdapterDescriptor({
    id: LanguageAdapterId.make(id),
    displayName: id,
    languageIds: [LanguageId.make(languageId)],
    extensions: [extension],
    capabilities: new LanguageAdapterCapabilities({
      definitions: true,
      documentSymbols: true,
      references: true,
      workspaceSymbols: true,
    }),
  }),
  probe: Effect.void,
  openSession: () => Effect.die("not exercised by registry tests"),
})

describe("LanguageAdapterRegistry", () => {
  it.effect("resolves exact language and extension claims", () =>
    Effect.gen(function* () {
      const registry = yield* LanguageAdapterRegistry
      expect(Option.getOrThrow(registry.resolveExtension(".ts")).descriptor.id).toBe("typescript")
      expect(
        Option.getOrThrow(registry.resolveLanguage(LanguageId.make("typescript"))).descriptor.id,
      ).toBe("typescript")
      expect(registry.resolveExtension(".go")).toEqual(Option.none())
    }).pipe(
      Effect.provide(
        LanguageAdapterRegistry.layer([registration("typescript", "typescript", ".ts")]),
      ),
    ),
  )

  it.effect("rejects duplicate adapter IDs", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.provide(
        LanguageAdapterRegistry,
        LanguageAdapterRegistry.layer([
          registration("typescript", "typescript", ".ts"),
          registration("typescript", "javascript", ".js"),
        ]),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("rejects ambiguous extensions", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.provide(
        LanguageAdapterRegistry,
        LanguageAdapterRegistry.layer([
          registration("typescript", "typescript", ".ts"),
          registration("other", "other", ".ts"),
        ]),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
