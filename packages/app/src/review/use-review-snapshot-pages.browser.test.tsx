import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { LocalReviewDetail, workingTreeReviewTarget } from "@diffdash/domain/local-review"
import {
  LocalReviewSnapshotManifest,
  ReviewSnapshotFileInventory,
} from "@diffdash/domain/review-context"
import {
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import type { DiffDashApi } from "@diffdash/protocol/api"
import {
  ReviewSnapshotExpired,
  ReviewSnapshotFileTooLarge,
  ReviewSnapshotPageAvailable,
  ReviewSnapshotPageCursor,
  type ReviewSnapshotPageResponse,
} from "@diffdash/protocol/review-snapshot"
import { RegistryProvider } from "@effect-atom/atom-react"
import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ReviewSnapshotPages, useReviewSnapshotPages } from "./use-review-snapshot-pages"

const originalDiffDash = Object.getOwnPropertyDescriptor(window, "diffDash")
const target = workingTreeReviewTarget("/workspace/diffdash")
const noop = (): void => undefined

let root: Root | null = null
let currentPages: ReviewSnapshotPages | null = null

afterEach(() => {
  root?.unmount()
  root = null
  currentPages = null
  document.body.replaceChildren()
  if (originalDiffDash === undefined) Reflect.deleteProperty(window, "diffDash")
  else Object.defineProperty(window, "diffDash", originalDiffDash)
})

describe("useReviewSnapshotPages", () => {
  it("fully consumes continuations with the exact explicit selection", async () => {
    const fixture = snapshotFixture(3)
    const cursor = ReviewSnapshotPageCursor.make("page:v1:1:12345678")
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>()
    getPage
      .mockResolvedValueOnce(
        ReviewSnapshotPageAvailable.make({
          snapshotId: fixture.manifest.snapshotId,
          files: fixture.files.slice(0, 1),
          nextCursor: cursor,
        }),
      )
      .mockResolvedValueOnce(
        ReviewSnapshotPageAvailable.make({
          snapshotId: fixture.manifest.snapshotId,
          files: fixture.files.slice(1),
          nextCursor: null,
        }),
      )
    installPageApi(getPage)
    renderHook(fixture.manifest)
    const fileIds = fixture.files.map((file) => file.fileId)

    await pages().loadFiles(fileIds)

    expect(getPage).toHaveBeenCalledTimes(2)
    expect(getPage.mock.calls[0]?.[0].fileIds).toEqual(fileIds)
    expect(getPage.mock.calls[0]?.[0].cursor).toBeNull()
    expect(getPage.mock.calls[1]?.[0].fileIds).toEqual(fileIds)
    expect(getPage.mock.calls[1]?.[0].cursor).toBe(cursor)
    await vi.waitFor(() => expect(pages().files).toHaveLength(3))
  })

  it("shares owner promises across duplicate and mixed requests", async () => {
    const fixture = snapshotFixture(2)
    const firstResponse = deferred<ReviewSnapshotPageResponse>()
    const secondResponse = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>((request) =>
      request.fileIds[0] === fixture.files[0]?.fileId
        ? firstResponse.promise
        : secondResponse.promise,
    )
    installPageApi(getPage)
    renderHook(fixture.manifest)
    const firstFile = fixture.files[0]
    const secondFile = fixture.files[1]
    if (firstFile === undefined || secondFile === undefined)
      throw new Error("Missing fixture files")

    const owner = pages().loadFiles([firstFile.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(1))
    let duplicateSettled = false
    let mixedSettled = false
    const duplicate = pages()
      .loadFiles([firstFile.fileId])
      .then(() => {
        duplicateSettled = true
        return undefined
      })
    const mixed = pages()
      .loadFiles([firstFile.fileId, secondFile.fileId])
      .then(() => {
        mixedSettled = true
        return undefined
      })
    await Promise.resolve()
    expect(duplicateSettled).toBe(false)
    expect(mixedSettled).toBe(false)

    firstResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [firstFile],
        nextCursor: null,
      }),
    )
    await duplicate
    expect(duplicateSettled).toBe(true)
    expect(mixedSettled).toBe(false)
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))

    secondResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [secondFile],
        nextCursor: null,
      }),
    )
    await Promise.all([owner, mixed])
    expect(mixedSettled).toBe(true)
  })

  it("restarts a fresh remaining selection after a continued file is too large", async () => {
    const fixture = snapshotFixture(3)
    const cursor = ReviewSnapshotPageCursor.make("page:v1:1:87654321")
    const firstFile = fixture.files[0]
    const secondFile = fixture.files[1]
    const thirdFile = fixture.files[2]
    const secondInventory = fixture.manifest.files[1]
    if (
      firstFile === undefined ||
      secondFile === undefined ||
      thirdFile === undefined ||
      secondInventory === undefined
    ) {
      throw new Error("Missing fixture files")
    }
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>()
    getPage
      .mockResolvedValueOnce(
        ReviewSnapshotPageAvailable.make({
          snapshotId: fixture.manifest.snapshotId,
          files: [firstFile],
          nextCursor: cursor,
        }),
      )
      .mockResolvedValueOnce(
        ReviewSnapshotFileTooLarge.make({
          snapshotId: fixture.manifest.snapshotId,
          file: secondInventory,
          maxResponseBytes: 512,
        }),
      )
      .mockResolvedValueOnce(
        ReviewSnapshotPageAvailable.make({
          snapshotId: fixture.manifest.snapshotId,
          files: [thirdFile],
          nextCursor: null,
        }),
      )
    installPageApi(getPage)
    renderHook(fixture.manifest)
    const fileIds = [firstFile.fileId, secondFile.fileId, thirdFile.fileId]

    await pages().loadFiles(fileIds)

    expect(getPage).toHaveBeenCalledTimes(3)
    expect(getPage.mock.calls[1]?.[0]).toMatchObject({ cursor, fileIds })
    expect(getPage.mock.calls[2]?.[0]).toMatchObject({
      cursor: null,
      fileIds: [thirdFile.fileId],
    })
    await vi.waitFor(() => {
      expect(pages().tooLargeFileIds.has(secondFile.fileId)).toBe(true)
      expect(pages().files.map((file) => file.fileId)).toEqual([firstFile.fileId, thirdFile.fileId])
    })
  })

  it("coalesces independently queued files into bounded serialized batches", async () => {
    const fixture = snapshotFixture(10)
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>(async (request) =>
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: request.fileIds.flatMap((fileId) => {
          const file = fixture.files.find((candidate) => candidate.fileId === fileId)
          return file === undefined ? [] : [file]
        }),
        nextCursor: null,
      }),
    )
    installPageApi(getPage)
    renderHook(fixture.manifest)

    await Promise.all(fixture.files.map((file) => pages().loadFiles([file.fileId])))

    expect(getPage).toHaveBeenCalledTimes(2)
    expect(getPage.mock.calls.map(([request]) => request.fileIds.length)).toEqual([8, 2])
    expect(Math.max(...getPage.mock.calls.map(([request]) => request.fileIds.length))).toBe(8)
  })

  it("keeps a persistent active file resident while later batches cross the cache bound", async () => {
    const fixture = snapshotFixture(34)
    const activeFile = fixture.files[0]
    if (activeFile === undefined) throw new Error("Missing active fixture file")
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>(async (request) =>
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: request.fileIds.flatMap((fileId) => {
          const file = fixture.files.find((candidate) => candidate.fileId === fileId)
          return file === undefined ? [] : [file]
        }),
        nextCursor: null,
      }),
    )
    installPageApi(getPage)
    renderHook(fixture.manifest)
    pages().setPinnedFileIds(new Set([activeFile.fileId]))

    await Promise.all(fixture.files.map((file) => pages().loadFiles([file.fileId])))

    await vi.waitFor(() => {
      expect(pages().files.length).toBeLessThanOrEqual(32)
      expect(pages().getFile(activeFile.fileId)?.fileId).toBe(activeFile.fileId)
    })
  })

  it("clears cached files when a replacement manifest reuses the same snapshot id", async () => {
    const fixture = snapshotFixture(1)
    const replacement = snapshotFixture(1, " replacement")
    const file = fixture.files[0]
    const replacementFile = replacement.files[0]
    if (file === undefined || replacementFile === undefined) {
      throw new Error("Missing fixture file")
    }
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>()
    getPage
      .mockResolvedValueOnce(
        ReviewSnapshotPageAvailable.make({
          snapshotId: fixture.manifest.snapshotId,
          files: [file],
          nextCursor: null,
        }),
      )
      .mockResolvedValueOnce(
        ReviewSnapshotPageAvailable.make({
          snapshotId: replacement.manifest.snapshotId,
          files: [replacementFile],
          nextCursor: null,
        }),
      )
    installPageApi(getPage)
    renderHook(fixture.manifest)

    const initialResult = await pages().loadFiles([file.fileId])
    expect(initialResult.statuses.get(file.fileId)).toBe("loaded")
    expect(pages().getFile(file.fileId)).not.toBeNull()

    rerenderHook(replacement.manifest)

    await vi.waitFor(() => {
      expect(pages().files).toEqual([])
      expect(pages().getFile(file.fileId)).toBeNull()
    })
    const replacementResult = await pages().loadFiles([replacementFile.fileId])
    expect(replacementResult.statuses.get(replacementFile.fileId)).toBe("loaded")
    expect(pages().getFile(replacementFile.fileId)?.patchHash).toBe(replacementFile.patchHash)
    expect(getPage).toHaveBeenCalledTimes(2)
  })

  it("cancels an in-flight generation when a replacement manifest reuses the same snapshot id", async () => {
    const fixture = snapshotFixture(1)
    const replacement = snapshotFixture(1, " replacement")
    const staleFile = fixture.files[0]
    const replacementFile = replacement.files[0]
    if (staleFile === undefined || replacementFile === undefined) {
      throw new Error("Missing fixture file")
    }
    const staleResponse = deferred<ReviewSnapshotPageResponse>()
    const replacementResponse = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>()
    getPage.mockImplementationOnce(() => staleResponse.promise)
    getPage.mockImplementationOnce(() => replacementResponse.promise)
    installPageApi(getPage)
    renderHook(fixture.manifest)

    const staleLoad = pages().loadFiles([staleFile.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce())

    rerenderHook(replacement.manifest)
    const replacementLoad = pages().loadFiles([replacementFile.fileId])
    const staleResult = await staleLoad
    expect(staleResult.statuses.get(staleFile.fileId)).toBe("cancelled")

    await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))
    replacementResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: replacement.manifest.snapshotId,
        files: [replacementFile],
        nextCursor: null,
      }),
    )
    const replacementResult = await replacementLoad
    expect(replacementResult.statuses.get(replacementFile.fileId)).toBe("loaded")
    expect(pages().getFile(replacementFile.fileId)?.patchHash).toBe(replacementFile.patchHash)

    staleResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [staleFile],
        nextCursor: null,
      }),
    )
    await Promise.resolve()
    expect(pages().getFile(replacementFile.fileId)?.patchHash).toBe(replacementFile.patchHash)
  })

  it("keeps a request error visible until a later retry clears it", async () => {
    const fixture = snapshotFixture(1)
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const retryResponse = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>()
    getPage.mockRejectedValueOnce(new Error("Snapshot transport unavailable"))
    getPage.mockImplementationOnce(() => retryResponse.promise)
    installPageApi(getPage)
    renderHook(fixture.manifest)

    await pages().loadFiles([file.fileId])
    await vi.waitFor(() =>
      expect(pages().fileErrors.get(file.fileId)).toBe("Snapshot transport unavailable"),
    )

    const retry = pages().loadFiles([file.fileId])
    await vi.waitFor(() => expect(pages().fileErrors.has(file.fileId)).toBe(false))
    retryResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [file],
        nextCursor: null,
      }),
    )
    await retry
    await vi.waitFor(() => expect(pages().getFile(file.fileId)?.fileId).toBe(file.fileId))
  })

  it("shows an expired snapshot as refreshing without retrying the stale snapshot", async () => {
    const fixture = snapshotFixture(2)
    const firstFile = fixture.files[0]
    const secondFile = fixture.files[1]
    if (firstFile === undefined || secondFile === undefined)
      throw new Error("Missing fixture files")
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>(async () =>
      ReviewSnapshotExpired.make({
        snapshotId: fixture.manifest.snapshotId,
        reason: "evicted",
      }),
    )
    const onExpired = vi.fn<() => Promise<void>>(async () => undefined)
    installPageApi(getPage)
    renderHook(fixture.manifest, onExpired)

    await pages().loadFiles([firstFile.fileId])
    await pages().loadFiles([secondFile.fileId])

    expect(getPage).toHaveBeenCalledOnce()
    expect(onExpired).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(pages().snapshotRefresh).toEqual({ _tag: "refreshing" })
      expect(pages().fileErrors.size).toBe(0)
    })
  })

  it("survives Strict Mode's simulated effect cleanup", async () => {
    const fixture = snapshotFixture(1)
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const getPage = vi.fn<DiffDashApi["reviewSnapshots"]["getPage"]>(async () =>
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [file],
        nextCursor: null,
      }),
    )
    installPageApi(getPage)
    renderHook(fixture.manifest, noop, true)

    const result = await pages().loadFiles([file.fileId])

    expect(result.statuses.get(file.fileId)).toBe("loaded")
    expect(getPage).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(pages().getFile(file.fileId)?.fileId).toBe(file.fileId))
  })
})

const snapshotFixture = (fileCount: number, contentMarker = "") => {
  const parsed = parseUnifiedDiff(
    Array.from(
      { length: fileCount },
      (_, index) => `diff --git a/src/file-${index}.ts b/src/file-${index}.ts
--- a/src/file-${index}.ts
+++ b/src/file-${index}.ts
@@ -1 +1 @@
-old ${index}${contentMarker}
+new ${index}${contentMarker}`,
    ).join("\n"),
  )
  const manifest = LocalReviewSnapshotManifest.make({
    projectId: ReviewProjectId.make("local:local/diffdash"),
    snapshotId: ReviewSnapshotId.make("snapshot:v1:1234567890abcdef1234567890abcdef"),
    reviewKey: ReviewKey.make("local:/workspace/diffdash"),
    baseRevision: ReviewRevision.make("base"),
    headRevision: ReviewRevision.make("head"),
    detail: LocalReviewDetail.make({
      rootPath: target.rootPath,
      repoName: "diffdash",
      branchName: "snapshot-loader",
      comparison: target.comparison,
      baseSha: "base",
      headSha: "head",
      diffHash: "diff",
      title: "Snapshot loader",
      files: [],
      fetchedAt: "2026-08-01T00:00:00Z",
    }),
    files: parsed.files.map((file) =>
      ReviewSnapshotFileInventory.make({
        fileId: file.fileId,
        patchHash: file.patchHash,
        reviewKey: file.reviewKey,
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        hunkCount: file.hunks.length,
      }),
    ),
  })
  return { files: parsed.files, manifest }
}

const installPageApi = (getPage: DiffDashApi["reviewSnapshots"]["getPage"]) => {
  Object.defineProperty(window, "diffDash", {
    configurable: true,
    value: { reviewSnapshots: { getPage } },
  })
}

const renderHook = (
  manifest: LocalReviewSnapshotManifest,
  onExpired: () => void | Promise<void> = noop,
  strictMode = false,
) => {
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  const harness = (
    <RegistryProvider defaultIdleTTL={0}>
      <HookHarness manifest={manifest} onExpired={onExpired} />
    </RegistryProvider>
  )
  flushSync(() => root?.render(strictMode ? <StrictMode>{harness}</StrictMode> : harness))
}

const rerenderHook = (
  manifest: LocalReviewSnapshotManifest,
  onExpired: () => void | Promise<void> = noop,
) => {
  flushSync(() =>
    root?.render(
      <RegistryProvider defaultIdleTTL={0}>
        <HookHarness manifest={manifest} onExpired={onExpired} />
      </RegistryProvider>,
    ),
  )
}

const HookHarness = ({
  manifest,
  onExpired,
}: {
  readonly manifest: LocalReviewSnapshotManifest
  readonly onExpired: () => void | Promise<void>
}) => {
  currentPages = useReviewSnapshotPages(manifest, onExpired)
  return null
}

const pages = () => {
  if (currentPages === null) throw new Error("Hook was not rendered")
  return currentPages
}

const deferred = <Value,>() => {
  let resolve: (value: Value) => void = noop
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
