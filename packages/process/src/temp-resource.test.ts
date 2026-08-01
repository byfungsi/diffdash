import { describe, expect, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { TempResources } from "./temp-resource"

const makeTestParent = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-temp-resource-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const tempResourcesLayer = TempResources.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
)

describe("secure temporary resources", () => {
  it.scoped("creates private resources and cleans them after success", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const parentDirectory = yield* makeTestParent
      let directory = ""
      let filePath = ""
      let outputPath = ""

      yield* Effect.scoped(
        Effect.gen(function* () {
          directory = yield* tempResources.makeTempDirectoryScoped({
            parentDirectory,
            prefix: "directory-",
          })
          filePath = yield* tempResources.makeTempFileScoped("secret", {
            parentDirectory,
            prefix: "file-",
            fileName: "input.txt",
          })
          outputPath = yield* tempResources.makeTempOutputPathScoped({
            parentDirectory,
            prefix: "output-",
            fileName: "result.txt",
          })

          expect(statSync(directory).mode & 0o777).toBe(0o700)
          expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700)
          expect(statSync(filePath).mode & 0o777).toBe(0o600)
          expect(readFileSync(filePath, "utf8")).toBe("secret")
          expect(existsSync(outputPath)).toBe(false)

          writeFileSync(outputPath, "external output", { flag: "wx", mode: 0o600 })
          expect(readFileSync(outputPath, "utf8")).toBe("external output")
        }),
      )

      expect(existsSync(directory)).toBe(false)
      expect(existsSync(dirname(filePath))).toBe(false)
      expect(existsSync(dirname(outputPath))).toBe(false)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.scoped("cleans resources after failure", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const parentDirectory = yield* makeTestParent
      let filePath = ""
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          filePath = yield* tempResources.makeTempFileScoped("secret", {
            parentDirectory,
            fileName: "input.txt",
          })
          return yield* Effect.fail("expected failure")
        }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(existsSync(dirname(filePath))).toBe(false)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )

  it.scoped("cleans resources when the owning scope is interrupted", () =>
    Effect.gen(function* () {
      const tempResources = yield* TempResources
      const parentDirectory = yield* makeTestParent
      const acquired = yield* Deferred.make<string>()
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const path = yield* tempResources.makeTempOutputPathScoped({
            parentDirectory,
            fileName: "output.txt",
          })
          yield* Deferred.succeed(acquired, path)
          return yield* Effect.never
        }),
      ).pipe(Effect.fork)
      const path = yield* Deferred.await(acquired)

      yield* Fiber.interrupt(fiber)

      expect(existsSync(dirname(path))).toBe(false)
    }).pipe(Effect.provide(tempResourcesLayer)),
  )
})
