import { describe, expect, it, vi } from "vitest"

import { openLocalPath } from "./file-opening"
import { CoreAbsolutePath } from "@diffdash/core"

describe("file opening", () => {
  it("surfaces local shell errors and accepts an empty success result", async () => {
    const successfulOpen = vi.fn<(path: CoreAbsolutePath) => Promise<string>>(async () => "")
    await expect(
      openLocalPath(successfulOpen, CoreAbsolutePath.make("/repo/src/app.ts")),
    ).resolves.toBeUndefined()
    expect(successfulOpen).toHaveBeenCalledWith("/repo/src/app.ts")

    const failedOpen = vi.fn<(path: CoreAbsolutePath) => Promise<string>>(
      async () => "No application found",
    )
    await expect(
      openLocalPath(failedOpen, CoreAbsolutePath.make("/repo/src/app.ts")),
    ).rejects.toThrow("No application found")
  })
})
