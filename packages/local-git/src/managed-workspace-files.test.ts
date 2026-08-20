import { expect, it } from "@effect/vitest"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ManagedWorkspaceFiles } from "./managed-workspace-files"

const withWorkspace = <A, E>(
  use: (path: RepositoryCheckoutPath) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => RepositoryCheckoutPath.make(mkdtempSync(join(tmpdir(), "diffdash-code-")))),
    use,
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  )

it.live(
  "lists immediate children without exposing Git metadata or traversing symlink directories",
  () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        mkdirSync(join(root, "src"))
        mkdirSync(join(root, ".git"))
        writeFileSync(join(root, "README.md"), "read me\n")
        writeFileSync(join(root, "src", "app.ts"), "export {}\n")
        symlinkSync(join(root, "src"), join(root, "linked-src"))

        const files = yield* ManagedWorkspaceFiles
        const rootPage = yield* files.listDirectory(root, null, 0, 500)
        expect(rootPage.entries.map(({ path }) => path)).toEqual(["src", "linked-src", "README.md"])
        expect(rootPage.entries.find(({ path }) => path === "linked-src")?.kind).toBe("file")

        const indexed = yield* files.indexFiles(root)
        expect(indexed).toEqual(["linked-src", "README.md", "src/app.ts"])
      }).pipe(Effect.provide(ManagedWorkspaceFiles.layer)),
    ),
)

it.live("indexes repositories beyond the former ten-thousand-file limit", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const source = join(root, "src")
      mkdirSync(source)
      for (let index = 0; index < 20_025; index += 1) {
        writeFileSync(join(source, `file-${index.toString().padStart(5, "0")}.ts`), "")
      }

      const files = yield* ManagedWorkspaceFiles
      const firstPage = yield* files.listDirectory(root, RepositoryRelativePath.make("src"), 0, 500)
      expect(firstPage.entries).toHaveLength(500)
      expect(firstPage.nextOffset).toBe(500)
      expect(yield* files.indexFiles(root)).toHaveLength(20_025)
    }).pipe(Effect.provide(ManagedWorkspaceFiles.layer)),
  ),
)
