import { describe, expect, it, vi } from "vitest"

import { openAllowedExternalUrl, openLocalPath, openProviderFile } from "./file-opening"
import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"

describe("file opening", () => {
  it("surfaces local shell errors and accepts an empty success result", async () => {
    const successfulOpen = vi.fn<(path: string) => Promise<string>>(async () => "")
    await expect(openLocalPath(successfulOpen, "/repo/src/app.ts")).resolves.toBeUndefined()
    expect(successfulOpen).toHaveBeenCalledWith("/repo/src/app.ts")

    const failedOpen = vi.fn<(path: string) => Promise<string>>(async () => "No application found")
    await expect(openLocalPath(failedOpen, "/repo/src/app.ts")).rejects.toThrow(
      "No application found",
    )
  })

  it("delegates only allowed external URLs and propagates shell rejection", async () => {
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined)
    await expect(openAllowedExternalUrl(openExternal, "https://example.com/file")).resolves.toBe(
      true,
    )
    await expect(openAllowedExternalUrl(openExternal, "file:///tmp/secret")).resolves.toBe(false)
    expect(openExternal).toHaveBeenCalledTimes(1)

    const failure = new Error("Browser unavailable")
    openExternal.mockRejectedValueOnce(failure)
    await expect(openAllowedExternalUrl(openExternal, "https://example.com/fail")).rejects.toBe(
      failure,
    )
  })

  it("prefers the immutable provider head and falls back to the branch name", async () => {
    const repository = HostedRepositoryLocator.make({
      providerId: GitProviderId.make("example"),
      namespace: RepositoryNamespace.make("fungsi"),
      name: HostedRepositoryName.make("diffdash"),
    })
    const fileUrl = vi.fn<
      (repository: HostedRepositoryLocator, filePath: string, ref: string) => Promise<string>
    >(
      async (locator, filePath, ref) =>
        `https://example.com/${locator.namespace}/${locator.name}/${ref}/${filePath}`,
    )
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined)

    await openProviderFile(
      fileUrl,
      openExternal,
      repository,
      "src/app.ts",
      "feature/review",
      "abc123",
    )
    await openProviderFile(fileUrl, openExternal, repository, "src/app.ts", "feature/review", null)

    expect(fileUrl.mock.calls.map((call) => call[2])).toEqual(["abc123", "feature/review"])
    expect(openExternal).toHaveBeenNthCalledWith(
      1,
      "https://example.com/fungsi/diffdash/abc123/src/app.ts",
    )
  })
})
