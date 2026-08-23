import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { LanguagePosition } from "@diffdash/domain/language"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { describe, expect, it } from "@effect/vitest"
import { Array as EffectArray, Effect, Fiber, HashSet, Option } from "effect"

import {
  makeTypeScriptLanguageAdapterRegistration,
  resolveTypeScriptLanguageAdapterAssets,
  TypeScriptLanguageAdapterAssets,
  typescriptLanguageAdapterDescriptor,
  typescriptLanguageAdapterRegistration,
} from "./typescript-language-adapter"

const fixtureServerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/fake-language-server.mjs",
)

const first = <A>(values: readonly A[]): A => Option.getOrThrow(EffectArray.head(values))

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "diffdash-typescript-lsp-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

describe("TypeScript language adapter", () => {
  it.effect("resolves every pinned server and grammar asset", () =>
    Effect.gen(function* () {
      const assets = resolveTypeScriptLanguageAdapterAssets()
      const paths = [
        assets.grammarRuntimePath,
        assets.languageServerPath,
        assets.languageServerRuntimePath,
        ...assets.grammars.map(({ wasmPath }) => wasmPath),
      ]
      yield* Effect.promise(() => Promise.all(paths.map((path) => access(path))))
      yield* typescriptLanguageAdapterRegistration.probe
      expect(typescriptLanguageAdapterDescriptor.id).toBe("typescript")
      expect(typescriptLanguageAdapterRegistration.descriptor).toBe(
        typescriptLanguageAdapterDescriptor,
      )
      expect(
        HashSet.size(HashSet.fromIterable(typescriptLanguageAdapterDescriptor.extensions)),
      ).toBe(typescriptLanguageAdapterDescriptor.extensions.length)
    }),
  )

  it.live("opens documents, contains locations, cancels requests, and exits cleanly", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory
      const sourcePath = join(root, "source.ts")
      const targetPath = join(root, "target.ts")
      const runtimeMarker = join(root, "tsserver.js")
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(sourcePath, "export const source = target\n", "utf8"),
          writeFile(targetPath, "export const target = 1\n", "utf8"),
          writeFile(runtimeMarker, "", "utf8"),
        ]),
      )

      const pinnedAssets = resolveTypeScriptLanguageAdapterAssets()
      const registration = makeTypeScriptLanguageAdapterRegistration(
        TypeScriptLanguageAdapterAssets.make({
          ...pinnedAssets,
          languageServerPath: fixtureServerPath,
          languageServerRuntimePath: runtimeMarker,
        }),
      )
      yield* registration.probe

      const safeResult = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* registration.openSession(RepositoryCheckoutPath.make(root))
          const source = RepositoryRelativePath.make("source.ts")
          const safe = yield* session.definitions(
            source,
            LanguagePosition.make({ line: 0, character: 0 }),
          )
          expect(safe.locations).toHaveLength(1)
          expect(first(safe.locations).target.path).toBe("target.ts")

          const symbols = yield* session.documentSymbols(source)
          expect(symbols.symbols.map(({ name }) => name)).toEqual(["source"])
          const references = yield* session.references(
            source,
            LanguagePosition.make({ line: 0, character: 0 }),
          )
          expect(references.locations).toHaveLength(1)
          expect(first(references.locations).target.path).toBe("source.ts")
          const workspaceSymbols = yield* session.workspaceSymbols("target")
          expect(workspaceSymbols.symbols).toHaveLength(1)
          expect(first(workspaceSymbols.symbols).location.path).toBe("target.ts")

          const unsafe = yield* Effect.flip(
            session.definitions(source, LanguagePosition.make({ line: 0, character: 98 })),
          )
          expect(unsafe.reason).toBe("unsafeLocation")

          const malformed = yield* Effect.flip(
            session.definitions(source, LanguagePosition.make({ line: 0, character: 97 })),
          )
          expect(malformed.reason).toBe("malformedResponse")

          const pending = yield* session
            .definitions(source, LanguagePosition.make({ line: 0, character: 99 }))
            .pipe(Effect.forkChild)
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(pending)
          yield* Effect.sleep("100 millis")
          yield* Effect.promise(() => access(`${runtimeMarker}.cancelled`))
          return safe
        }),
      )

      expect(safeResult.locations).toHaveLength(1)
      expect(first(safeResult.locations).target.path).toBe("target.ts")
      yield* Effect.promise(() =>
        Promise.all([access(`${runtimeMarker}.shutdown`), access(`${runtimeMarker}.exited`)]),
      )
    }),
  )

  it.live("resolves a definition through the pinned TypeScript language server", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(join(root, "source.ts"), 'import { target } from "./target"\ntarget\n', "utf8"),
          writeFile(join(root, "target.ts"), "export const target = 1\n", "utf8"),
          writeFile(
            join(root, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
            "utf8",
          ),
        ]),
      )

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* typescriptLanguageAdapterRegistration.openSession(
            RepositoryCheckoutPath.make(root),
          )
          return yield* session.definitions(
            RepositoryRelativePath.make("source.ts"),
            LanguagePosition.make({ line: 1, character: 1 }),
          )
        }),
      )
      expect(result.locations).toHaveLength(1)
      expect(first(result.locations).target.path).toBe("target.ts")
    }),
  )

  it.live("kills a server that ignores shutdown, exit, and termination", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory
      const runtimeMarker = join(root, "stubborn-tsserver.js")
      yield* Effect.promise(() => writeFile(runtimeMarker, "", "utf8"))
      const registration = makeTypeScriptLanguageAdapterRegistration(
        TypeScriptLanguageAdapterAssets.make({
          ...resolveTypeScriptLanguageAdapterAssets(),
          languageServerPath: fixtureServerPath,
          languageServerRuntimePath: runtimeMarker,
        }),
      )

      yield* Effect.scoped(
        registration.openSession(RepositoryCheckoutPath.make(root)).pipe(Effect.asVoid),
      )
      const pid = yield* Effect.promise(() =>
        readFile(`${runtimeMarker}.pid`, "utf8").then((value) => Number(value.trim())),
      )
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u)
    }),
  )
})
