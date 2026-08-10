import {
  CoreAbsolutePath,
  CoreExternalFileOpenIntent,
  CoreLocalFileOpenIntent,
  CoreWebUrl,
} from "@diffdash/core"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { OpenRepositoryFilePath } from "@diffdash/protocol/hosted-git"

import { openCoreFileIntent } from "./core-file-open-intent"

describe("openCoreFileIntent", () => {
  it("routes external intents only through the external URL capability", async () => {
    const openExternal = vi.fn<(url: CoreWebUrl) => Promise<boolean>>(async () => true)
    const openLocal = vi.fn<(path: CoreAbsolutePath) => Promise<void>>(async () => undefined)

    await openCoreFileIntent(
      CoreExternalFileOpenIntent.make({
        url: CoreWebUrl.make("https://github.com/fungsi/diffdash/blob/main/src/app.ts"),
      }),
      { openExternal, openLocal },
    )

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/fungsi/diffdash/blob/main/src/app.ts",
    )
    expect(openLocal).not.toHaveBeenCalled()
  })

  it("resolves local intents inside their repository before opening", async () => {
    const openExternal = vi.fn<(url: CoreWebUrl) => Promise<boolean>>(async () => true)
    const openLocal = vi.fn<(path: CoreAbsolutePath) => Promise<void>>(async () => undefined)
    const directory = mkdtempSync(join(tmpdir(), "diffdash-file-intent-test-"))
    const repositoryPath = join(directory, "repository")
    const filePath = join(repositoryPath, "src", "app.ts")
    mkdirSync(join(repositoryPath, "src"), { recursive: true })
    writeFileSync(filePath, "export const app = true\n")

    try {
      await openCoreFileIntent(
        CoreLocalFileOpenIntent.make({
          rootPath: CoreAbsolutePath.make(repositoryPath),
          filePath: OpenRepositoryFilePath.make("src/app.ts"),
        }),
        { openExternal, openLocal },
      )

      expect(openLocal).toHaveBeenCalledExactlyOnceWith(realpathSync(filePath))
      expect(openExternal).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
