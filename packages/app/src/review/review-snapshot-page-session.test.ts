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
import {
  ReviewSnapshotExpired,
  ReviewSnapshotFileTooLarge,
  ReviewSnapshotPageAvailable,
  type ReviewSnapshotPageResponse,
} from "@diffdash/protocol/review-snapshot"
import { transportError } from "@diffdash/protocol/transport-error"
import { Atom, Registry } from "@effect-atom/atom-react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type ReviewSnapshotPageRuntime,
  ReviewSnapshotPageSession,
} from "./review-snapshot-page-session"

const target = workingTreeReviewTarget("/workspace/diffdash")
const registries: Registry.Registry[] = []
const sessions: ReviewSnapshotPageSession[] = []
const ignoreDeferredValue = <Value>(_value: Value): void => undefined
const ignoreDeferredCause = (_cause: unknown): void => undefined

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
  for (const registry of registries.splice(0)) registry.dispose()
})

describe("ReviewSnapshotPageSession", () => {
  it("publishes immutable loading, loaded, too-large, and failed projection transitions", async () => {
    const fixture = snapshotFixture(3)
    const first = fixture.files[0]
    const second = fixture.files[1]
    const third = fixture.files[2]
    const secondInventory = fixture.manifest.files[1]
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      secondInventory === undefined
    ) {
      throw new Error("Missing fixture files")
    }
    const firstResponse = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>()
    getPage
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(
        ReviewSnapshotFileTooLarge.make({
          snapshotId: fixture.manifest.snapshotId,
          file: secondInventory,
          maxResponseBytes: 512,
        }),
      )
      .mockRejectedValueOnce(new Error("Snapshot transport unavailable"))
    const { registry, session } = makeSession(fixture.manifest, getPage)
    const initial = registry.get(session.projectionAtom)

    const firstLoad = session.loadFiles([first.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce())
    const loading = registry.get(session.projectionAtom)
    expect(loading.loadingFileIds).not.toBe(initial.loadingFileIds)
    expect(loading.loadingFileIds.has(first.fileId)).toBe(true)
    expect(initial.loadingFileIds.size).toBe(0)

    firstResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [first],
        nextCursor: null,
      }),
    )
    await expect(firstLoad).resolves.toMatchObject({ snapshotId: fixture.manifest.snapshotId })
    const loaded = registry.get(session.projectionAtom)
    expect(loaded.files.map((file) => file.fileId)).toEqual([first.fileId])
    expect(loaded.loadingFileIds.size).toBe(0)
    expect(loading.loadingFileIds.has(first.fileId)).toBe(true)

    const tooLarge = await session.loadFiles([second.fileId])
    expect(tooLarge.statuses.get(second.fileId)).toBe("tooLarge")
    const tooLargeProjection = registry.get(session.projectionAtom)
    expect(tooLargeProjection.tooLargeFileIds.has(second.fileId)).toBe(true)
    expect(loaded.tooLargeFileIds.size).toBe(0)

    const failed = await session.loadFiles([third.fileId])
    expect(failed.statuses.get(third.fileId)).toBe("failed")
    const failedProjection = registry.get(session.projectionAtom)
    expect(failedProjection.fileErrors.get(third.fileId)).toBe("Snapshot transport unavailable")
    expect(tooLargeProjection.fileErrors.has(third.fileId)).toBe(false)
  })

  it("isolates two sessions in one registry and sessions in separate registries", async () => {
    const firstFixture = snapshotFixture(1, " first", "1")
    const secondFixture = snapshotFixture(1, " second", "2")
    const thirdFixture = snapshotFixture(1, " third", "3")
    const registryA = makeRegistry()
    const registryB = makeRegistry()
    const first = makeSessionInRegistry(registryA, firstFixture)
    const second = makeSessionInRegistry(registryA, secondFixture)
    const third = makeSessionInRegistry(registryB, thirdFixture)
    const firstFile = firstFixture.files[0]
    const thirdFile = thirdFixture.files[0]
    if (firstFile === undefined || thirdFile === undefined) throw new Error("Missing fixture files")

    await first.loadFiles([firstFile.fileId])

    expect(registryA.get(first.projectionAtom).files).toHaveLength(1)
    expect(registryA.get(second.projectionAtom).files).toHaveLength(0)
    expect(registryB.get(third.projectionAtom).files).toHaveLength(0)
    expect(registryA.getNodes().size).toBe(4)
    expect(registryB.getNodes().size).toBe(2)

    await third.loadFiles([thirdFile.fileId])
    expect(registryB.get(third.projectionAtom).files[0]?.patchHash).toBe(thirdFile.patchHash)
    expect(registryA.get(first.projectionAtom).files[0]?.patchHash).toBe(firstFile.patchHash)
  })

  it("invalidates an active same-ID manifest before accepting replacement data", async () => {
    const fixture = snapshotFixture(1)
    const replacement = snapshotFixture(1, " replacement")
    const staleFile = fixture.files[0]
    const replacementFile = replacement.files[0]
    if (staleFile === undefined || replacementFile === undefined) {
      throw new Error("Missing fixture files")
    }
    const staleResponse = deferred<ReviewSnapshotPageResponse>()
    const replacementResponse = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>()
    getPage.mockImplementationOnce(() => staleResponse.promise)
    getPage.mockImplementationOnce(() => replacementResponse.promise)
    const { registry, session } = makeSession(fixture.manifest, getPage)
    session.setPinnedFileIds(new Set([staleFile.fileId]))

    const staleLoad = session.loadFiles([staleFile.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce())
    session.replaceManifest(replacement.manifest)

    const staleResult = await staleLoad
    expect(staleResult.statuses.get(staleFile.fileId)).toBe("cancelled")
    expect(registry.get(session.projectionAtom)).toMatchObject({
      snapshotId: fixture.manifest.snapshotId,
      files: [],
    })

    const replacementLoad = session.loadFiles([replacementFile.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))
    replacementResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: replacement.manifest.snapshotId,
        files: [replacementFile],
        nextCursor: null,
      }),
    )
    expect((await replacementLoad).statuses.get(replacementFile.fileId)).toBe("loaded")

    staleResponse.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [staleFile],
        nextCursor: null,
      }),
    )
    await Promise.resolve()
    expect(session.getFile(replacementFile.fileId)?.patchHash).toBe(replacementFile.patchHash)

    const pressure = snapshotFixture(33, " pressure")
    session.replaceManifest(pressure.manifest)
    const pressureGetPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>(async (request) =>
      ReviewSnapshotPageAvailable.make({
        snapshotId: pressure.manifest.snapshotId,
        files: request.fileIds.flatMap((fileId) => {
          const file = pressure.files.find((candidate) => candidate.fileId === fileId)
          return file === undefined ? [] : [file]
        }),
        nextCursor: null,
      }),
    )
    session.updateRuntime({ getPage: pressureGetPage, onExpired: noop })
    await session.loadFiles(pressure.files.map((file) => file.fileId))
    expect(registry.get(session.projectionAtom).files).toHaveLength(32)
    expect(registry.get(session.projectionAtom).files).not.toContainEqual(
      expect.objectContaining({ fileId: pressure.files[0]?.fileId }),
    )
  })

  it("preserves private transport causes for navigation retry classification", async () => {
    const fixture = snapshotFixture(1)
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const cause = transportError("IPC_FAILURE", "Temporary page transport failure")
    const { session } = makeSession(fixture.manifest, async () => Promise.reject(cause))

    const result = await session.loadFiles([file.fileId])

    expect(result.statuses.get(file.fileId)).toBe("failed")
    expect(result.failureCauses.get(file.fileId)).toBe(cause)
  })

  it("waits for one atom-driven manifest replacement after expiry", async () => {
    const fixture = snapshotFixture(1)
    const replacement = snapshotFixture(1, " refreshed")
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const { session } = makeSession(fixture.manifest, async () =>
      ReviewSnapshotExpired.make({
        snapshotId: fixture.manifest.snapshotId,
        reason: "expired",
      }),
    )

    const result = await session.loadFiles([file.fileId])
    const refreshing = session.getProjection()
    const replacementWait = session.waitForManifestReplacement(
      fixture.manifest.snapshotId,
      new AbortController().signal,
    )
    session.replaceManifest(replacement.manifest)

    expect(result.statuses.get(file.fileId)).toBe("expired")
    expect(refreshing.snapshotRefresh).toEqual({ _tag: "refreshing" })
    expect(refreshing.fileErrors.size).toBe(0)
    await expect(replacementWait).resolves.toBe(replacement.manifest.snapshotId)
    expect(session.getProjection().snapshotRefresh).toEqual({ _tag: "idle" })
  })

  it("publishes a destructive state only when snapshot refresh fails", async () => {
    const fixture = snapshotFixture(1)
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const { session } = makeSession(
      fixture.manifest,
      async () =>
        ReviewSnapshotExpired.make({
          snapshotId: fixture.manifest.snapshotId,
          reason: "expired",
        }),
      async () => Promise.reject(new Error("Refresh transport unavailable")),
    )

    await session.loadFiles([file.fileId])

    await vi.waitFor(() =>
      expect(session.getProjection().snapshotRefresh).toEqual({
        _tag: "failed",
        message: "Refresh transport unavailable",
      }),
    )
    expect(session.getProjection().fileErrors.size).toBe(0)
  })

  it("disposal cancels active and queued callers and ignores late success", async () => {
    const fixture = snapshotFixture(2)
    const first = fixture.files[0]
    const second = fixture.files[1]
    if (first === undefined || second === undefined) throw new Error("Missing fixture files")
    const response = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>(() => response.promise)
    const { registry, session } = makeSession(fixture.manifest, getPage)

    const active = session.loadFiles([first.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce())
    const queued = session.loadFiles([second.fileId])
    expect(registry.get(session.projectionAtom).loadingFileIds.size).toBe(2)

    session.dispose()

    expect((await active).statuses.get(first.fileId)).toBe("cancelled")
    expect((await queued).statuses.get(second.fileId)).toBe("cancelled")
    expect(registry.get(session.projectionAtom).files).toEqual([])
    expect(registry.get(session.projectionAtom).loadingFileIds.size).toBe(0)
    expect((await session.loadFiles([first.fileId])).statuses.get(first.fileId)).toBe("cancelled")

    response.resolve(
      ReviewSnapshotPageAvailable.make({
        snapshotId: fixture.manifest.snapshotId,
        files: [first],
        nextCursor: null,
      }),
    )
    await Promise.resolve()
    expect(getPage).toHaveBeenCalledOnce()
    expect(registry.get(session.projectionAtom).files).toEqual([])
  })

  it("ignores a late transport error after disposal", async () => {
    const fixture = snapshotFixture(1)
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const response = deferred<ReviewSnapshotPageResponse>()
    const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>(() => response.promise)
    const { registry, session } = makeSession(fixture.manifest, getPage)

    const load = session.loadFiles([file.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce())
    session.dispose()
    response.reject(new Error("Late transport failure"))

    expect((await load).statuses.get(file.fileId)).toBe("cancelled")
    await Promise.resolve()
    expect(registry.get(session.projectionAtom).fileErrors.size).toBe(0)
  })

  it("ignores late expiry and never refreshes after disposal", async () => {
    const fixture = snapshotFixture(1)
    const file = fixture.files[0]
    if (file === undefined) throw new Error("Missing fixture file")
    const response = deferred<ReviewSnapshotPageResponse>()
    const onExpired = vi.fn<() => Promise<void>>(async () => undefined)
    const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>(() => response.promise)
    const { registry, session } = makeSession(fixture.manifest, getPage, onExpired)

    const load = session.loadFiles([file.fileId])
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce())
    session.dispose()
    response.resolve(
      ReviewSnapshotExpired.make({ snapshotId: fixture.manifest.snapshotId, reason: "evicted" }),
    )

    expect((await load).statuses.get(file.fileId)).toBe("cancelled")
    await Promise.resolve()
    expect(onExpired).not.toHaveBeenCalled()
    expect(registry.get(session.projectionAtom).fileErrors.size).toBe(0)
  })

  it("disposes idempotently without disposing its root registry", () => {
    const fixture = snapshotFixture(1)
    const unrelatedAtom = Atom.make(1)
    const registry = makeRegistry()
    const releaseUnrelated = registry.mount(unrelatedAtom)
    const session = makeSessionInRegistry(registry, fixture)

    session.dispose()
    session.dispose()
    registry.set(unrelatedAtom, 2)

    expect(registry.get(unrelatedAtom)).toBe(2)
    releaseUnrelated()
  })

  it("keeps atom cardinality fixed while paging beyond the cache bound", async () => {
    const fixture = snapshotFixture(40)
    const { getPage, registry, session } = makeFixtureSession(fixture)
    const nodeCount = registry.getNodes().size

    await session.loadFiles(fixture.files.map((file) => file.fileId))

    expect(getPage).toHaveBeenCalledTimes(5)
    expect(getPage.mock.calls.every(([request]) => request.fileIds.length <= 8)).toBe(true)
    expect(registry.get(session.projectionAtom).files.length).toBeLessThanOrEqual(32)
    expect(registry.getNodes().size).toBe(nodeCount)
    expect(nodeCount).toBe(2)
  })
})

const makeRegistry = () => {
  const registry = Registry.make()
  registries.push(registry)
  return registry
}

const makeSession = (
  manifest: LocalReviewSnapshotManifest,
  getPage: ReviewSnapshotPageRuntime["getPage"],
  onExpired: ReviewSnapshotPageRuntime["onExpired"] = noop,
) => {
  const registry = makeRegistry()
  const session = new ReviewSnapshotPageSession(registry, manifest, { getPage, onExpired })
  session.mount()
  sessions.push(session)
  return { registry, session }
}

const makeSessionInRegistry = (
  registry: Registry.Registry,
  fixture: ReturnType<typeof snapshotFixture>,
) => {
  const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>(async (request) =>
    ReviewSnapshotPageAvailable.make({
      snapshotId: fixture.manifest.snapshotId,
      files: request.fileIds.flatMap((fileId) => {
        const file = fixture.files.find((candidate) => candidate.fileId === fileId)
        return file === undefined ? [] : [file]
      }),
      nextCursor: null,
    }),
  )
  const session = new ReviewSnapshotPageSession(registry, fixture.manifest, {
    getPage,
    onExpired: noop,
  })
  session.mount()
  sessions.push(session)
  return session
}

const makeFixtureSession = (fixture: ReturnType<typeof snapshotFixture>) => {
  const getPage = vi.fn<ReviewSnapshotPageRuntime["getPage"]>(async (request) =>
    ReviewSnapshotPageAvailable.make({
      snapshotId: fixture.manifest.snapshotId,
      files: request.fileIds.flatMap((fileId) => {
        const file = fixture.files.find((candidate) => candidate.fileId === fileId)
        return file === undefined ? [] : [file]
      }),
      nextCursor: null,
    }),
  )
  return { ...makeSession(fixture.manifest, getPage), getPage }
}

const snapshotFixture = (fileCount: number, contentMarker = "", identityMarker = "0") => {
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
    projectId: ReviewProjectId.make(`local:local/diffdash-${identityMarker}`),
    snapshotId: ReviewSnapshotId.make(`snapshot:v1:${identityMarker.repeat(32).slice(0, 32)}`),
    reviewKey: ReviewKey.make(`local:/workspace/diffdash-${identityMarker}`),
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

const deferred = <Value>() => {
  let resolve: (value: Value) => void = ignoreDeferredValue
  let reject: (cause: unknown) => void = ignoreDeferredCause
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, reject, resolve }
}

const noop = (): void => undefined
