import { describe, expect, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Result, Layer, PlatformError } from "effect"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileStorage } from "./file-storage"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-file-storage-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const fileStorageLayer = FileStorage.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
)

describe("file storage", () => {
  it.effect("returns null only when the file is missing", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory

      expect(yield* storage.readOptionalTextFile(join(directory, "missing.json"))).toBeNull()
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.effect("writes private pretty JSON with a trailing newline", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "nested", "settings.json")

      yield* storage.writePrettyJsonFile(path, { enabled: true, model: "fast" })

      expect(readFileSync(path, "utf8")).toBe('{\n  "enabled": true,\n  "model": "fast"\n}\n')
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.effect("atomically replaces an existing file", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      const previousPath = join(directory, "previous-settings.json")
      const previousContent = '{"enabled":false}\n'
      writeFileSync(path, previousContent, { encoding: "utf8", mode: 0o600 })
      linkSync(path, previousPath)

      yield* storage.writePrettyJsonFile(path, { enabled: true })

      expect(readFileSync(path, "utf8")).toBe('{\n  "enabled": true\n}\n')
      expect(readFileSync(previousPath, "utf8")).toBe(previousContent)
      expect(new Set(readdirSync(directory))).toEqual(
        new Set(["previous-settings.json", "settings.json"]),
      )
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.effect("fails instead of treating non-ENOENT read errors as missing", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      mkdirSync(path)

      const result = yield* Effect.result(storage.readOptionalTextFile(path))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(PlatformError.PlatformError)
        if (result.failure instanceof PlatformError.PlatformError) {
          expect(result.failure.reason._tag).not.toBe("NotFound")
        }
      }
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.effect("removes the temporary file when atomic publication fails", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      mkdirSync(path)

      const result = yield* Effect.result(storage.writePrettyJsonFile(path, { enabled: true }))

      expect(Result.isFailure(result)).toBe(true)
      expect(readdirSync(directory)).toEqual(["settings.json"])
    }).pipe(Effect.provide(fileStorageLayer)),
  )
})
