import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
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

import { readOptionalTextFile, writePrettyJsonFile } from "./file-storage"
import { isNodeError } from "./node-errors"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-file-storage-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

describe("file storage", () => {
  it.scoped("returns null only when the file is missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory

      expect(yield* readOptionalTextFile(join(directory, "missing.json"))).toBeNull()
    }),
  )

  it.scoped("writes private pretty JSON with a trailing newline", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const path = join(directory, "nested", "settings.json")

      yield* writePrettyJsonFile(path, { enabled: true, model: "fast" })

      expect(readFileSync(path, "utf8")).toBe('{\n  "enabled": true,\n  "model": "fast"\n}\n')
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    }),
  )

  it.scoped("atomically replaces an existing file", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      const previousPath = join(directory, "previous-settings.json")
      const previousContent = '{"enabled":false}\n'
      writeFileSync(path, previousContent, { encoding: "utf8", mode: 0o600 })
      linkSync(path, previousPath)

      yield* writePrettyJsonFile(path, { enabled: true })

      expect(readFileSync(path, "utf8")).toBe('{\n  "enabled": true\n}\n')
      expect(readFileSync(previousPath, "utf8")).toBe(previousContent)
      expect(new Set(readdirSync(directory))).toEqual(
        new Set(["previous-settings.json", "settings.json"]),
      )
    }),
  )

  it.scoped("fails instead of treating non-ENOENT read errors as missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      mkdirSync(path)

      const result = yield* Effect.either(readOptionalTextFile(path))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(isNodeError(result.left.error)).toBe(true)
        if (isNodeError(result.left.error)) expect(result.left.error.code).not.toBe("ENOENT")
      }
    }),
  )

  it.scoped("removes the temporary file when atomic publication fails", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const path = join(directory, "settings.json")
      mkdirSync(path)

      const result = yield* Effect.either(writePrettyJsonFile(path, { enabled: true }))

      expect(Either.isLeft(result)).toBe(true)
      expect(readdirSync(directory)).toEqual(["settings.json"])
    }),
  )
})
