import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { isNodeError } from "./hosted-review-workspace-pool-error"
import { makeManagedWorkspaceFilesystem } from "./hosted-review-workspace-paths"

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-managed-paths-"))),
  (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
)

describe("ManagedWorkspaceFilesystem", () => {
  it.scoped("allows and canonicalizes a configured root symlink", () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory
      const target = join(temporary, "target")
      const alias = join(temporary, "alias")
      mkdirSync(target)
      symlinkSync(target, alias, "dir")

      const filesystem = yield* makeManagedWorkspaceFilesystem(alias)

      expect(filesystem.root).toBe(realpathSync(target))
      expect(filesystem.path("manifest.json")).toBe(join(realpathSync(target), "manifest.json"))
    }),
  )

  it.scoped("rejects a symlink in each existing managed descendant component", () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory

      for (const component of ["repositories", "repository", "slot"] as const) {
        const configuredRoot = join(temporary, `pool-${component}`)
        const outside = join(temporary, `outside-${component}`)
        mkdirSync(outside)
        const filesystem = yield* makeManagedWorkspaceFilesystem(configuredRoot)
        const repositoriesPath = filesystem.path("repositories")
        const repositoryPath = filesystem.path("repositories", "repository")
        const slotPath = filesystem.path("repositories", "repository", "slot")

        if (component === "repositories") {
          symlinkSync(outside, repositoriesPath, "dir")
        } else {
          mkdirSync(repositoriesPath)
          if (component === "repository") {
            symlinkSync(outside, repositoryPath, "dir")
          } else {
            mkdirSync(repositoryPath)
            symlinkSync(outside, slotPath, "dir")
          }
        }

        const error = yield* filesystem.validate(slotPath, `test.${component}`).pipe(Effect.flip)
        expect(error).toMatchObject({ code: "filesystem", operation: `test.${component}` })
      }
    }),
  )

  it.scoped("does not treat non-ENOENT traversal errors as an absent path", () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory
      const filesystem = yield* makeManagedWorkspaceFilesystem(join(temporary, "pool"))
      const repositoriesPath = filesystem.path("repositories")
      writeFileSync(repositoriesPath, "not a directory")

      const error = yield* filesystem
        .exists(filesystem.path("repositories", "repository.git"), "test.exists")
        .pipe(Effect.flip)

      expect(error).toMatchObject({ code: "filesystem", operation: "test.exists" })
      expect(error.cause).toBeInstanceOf(Error)
      expect(String(error.cause)).toContain("ancestor is not a directory")
    }),
  )

  it.scoped("preserves permission failures instead of reporting an absent descendant", () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory
      const filesystem = yield* makeManagedWorkspaceFilesystem(join(temporary, "pool"))
      const repositoriesPath = filesystem.path("repositories")
      mkdirSync(repositoriesPath)
      chmodSync(repositoriesPath, 0o000)

      const error = yield* filesystem
        .exists(filesystem.path("repositories", "repository.git"), "test.permission")
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => chmodSync(repositoriesPath, 0o700))))

      expect(error).toMatchObject({ code: "filesystem", operation: "test.permission" })
      expect(isNodeError(error.cause, "EACCES")).toBe(true)
    }),
  )
})
