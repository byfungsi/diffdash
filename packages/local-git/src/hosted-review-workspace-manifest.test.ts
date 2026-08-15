import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"

import { mutateManifest, updateManifest } from "./hosted-review-workspace-manifest"
import { poolError } from "./hosted-review-workspace-pool-error"
import { makeManagedWorkspaceFilesystem } from "./hosted-review-workspace-paths"

const manifestFixture = Effect.acquireRelease(
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "diffdash-manifest-"))
    const filesystem = yield* makeManagedWorkspaceFilesystem(join(root, "pool"))
    return { filesystem, root }
  }),
  ({ root }) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
)

describe("manifest transactions", () => {
  it.effect("persists a write-only manifest update", () =>
    Effect.gen(function* () {
      const { filesystem } = yield* manifestFixture

      yield* updateManifest(filesystem, (manifest) => ({
        ...manifest,
        repositories: [
          ...manifest.repositories,
          {
            providerId: "github",
            repositoryKey: "github:Acme/Widget",
            clonedAt: "2026-08-15T00:00:00.000Z",
            lastUsedAt: "2026-08-15T00:00:00.000Z",
          },
        ],
      }))

      const repositoryCount = yield* mutateManifest(filesystem, (manifest) => ({
        manifest,
        value: manifest.repositories.length,
      }))

      expect(repositoryCount).toBe(1)
    }),
  )

  it.effect("returns a meaningful value from a manifest mutation", () =>
    Effect.gen(function* () {
      const { filesystem } = yield* manifestFixture

      const value = yield* mutateManifest(filesystem, (manifest) => ({
        manifest,
        value: "transaction-result",
      }))

      expect(value).toBe("transaction-result")
    }),
  )

  it.effect("preserves manifest-write and temporary-cleanup causes when both fail", () =>
    Effect.gen(function* () {
      const { filesystem } = yield* manifestFixture
      const failingFilesystem = {
        ...filesystem,
        validate: (path: Parameters<typeof filesystem.validate>[0], operation: string) =>
          operation === "manifest.rename.destination"
            ? Effect.fail(
                poolError(
                  "filesystem",
                  operation,
                  "Injected manifest destination failure.",
                  new Error("manifest write failed"),
                ),
              )
            : filesystem.validate(path, operation),
        remove: (path: Parameters<typeof filesystem.remove>[0], operation: string) =>
          operation === "manifest.temporary.cleanup"
            ? Effect.fail(
                poolError(
                  "filesystem",
                  operation,
                  "Injected manifest cleanup failure.",
                  new Error("temporary cleanup failed"),
                ),
              )
            : filesystem.remove(path, operation),
      }

      const cause = yield* updateManifest(failingFilesystem, (manifest) => manifest).pipe(
        Effect.sandbox,
        Effect.flip,
      )

      expect(cause.reasons).toHaveLength(2)
      expect(Cause.pretty(cause)).toContain("manifest write failed")
      expect(Cause.pretty(cause)).toContain("temporary cleanup failed")
    }),
  )
})
