import { describe, expect, it } from "@effect/vitest"
import { Error as PlatformError } from "@effect/platform"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Either, Layer } from "effect"
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
  it.scoped("returns null only when the file is missing", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory

      expect(yield* storage.readOptionalTextFile(join(directory, "missing.json"))).toBeNull()
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.scoped("writes private pretty JSON with a trailing newline", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "nested", "settings.json")

      yield* storage.writePrettyJsonFile(path, { enabled: true, model: "fast" })

      expect(readFileSync(path, "utf8")).toBe('{\n  "enabled": true,\n  "model": "fast"\n}\n')
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.scoped("atomically replaces an existing file", () =>
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

  it.scoped("fails instead of treating non-ENOENT read errors as missing", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      mkdirSync(path)

      const result = yield* Effect.either(storage.readOptionalTextFile(path))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(PlatformError.SystemError)
        if (result.left instanceof PlatformError.SystemError) {
          expect(result.left.reason).not.toBe("NotFound")
        }
      }
    }).pipe(Effect.provide(fileStorageLayer)),
  )

  it.scoped("removes the temporary file when atomic publication fails", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      mkdirSync(path)

      const result = yield* Effect.either(storage.writePrettyJsonFile(path, { enabled: true }))

      expect(Either.isLeft(result)).toBe(true)
      expect(readdirSync(directory)).toEqual(["settings.json"])
    }).pipe(Effect.provide(fileStorageLayer)),
  )
})
