import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type { ReviewSnapshotManifest } from "@diffdash/domain/review-context"
import type {
  ReviewFileId,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  REVIEW_SNAPSHOT_PAGE_FILE_LIMIT,
  type ReviewSnapshotPageCursor,
  ReviewSnapshotPageRequest,
  ReviewSnapshotPageResponse,
} from "@diffdash/protocol/review-snapshot"
import { Match, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

import { formatError, rendererTransportError } from "@/shared/errors"
import type { TransportError } from "@diffdash/protocol/transport-error"
import { ReviewPageCache } from "./review-page-cache"

const LOAD_ERROR_FALLBACK = "Could not load this diff"
const INCOMPLETE_PAGE_ERROR = "The snapshot returned an incomplete diff page. Retry this file."
const noop = (): void => undefined

/** Terminal state for one requested parsed file in a loader generation. */
export type ReviewSnapshotFileLoadStatus =
  | "loaded"
  | "tooLarge"
  | "failed"
  | "expired"
  | "cancelled"

/** Generation-aware result returned after every requested file reaches a terminal state. */
export interface ReviewSnapshotLoadResult {
  readonly snapshotId: ReviewSnapshotId
  readonly statuses: ReadonlyMap<ReviewFileId, ReviewSnapshotFileLoadStatus>
  readonly failureCauses: ReadonlyMap<ReviewFileId, TransportError>
}

/** Snapshot-level refresh lifecycle kept separate from per-file page failures. */
export type ReviewSnapshotRefreshStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "refreshing" }
  | { readonly _tag: "failed"; readonly message: string }

/** Read-only renderer-facing snapshot published by one page session. */
export interface ReviewSnapshotPageProjection {
  readonly projectId: ReviewProjectId
  readonly snapshotId: ReviewSnapshotId
  readonly files: readonly ParsedDiffFile[]
  readonly loadingFileIds: ReadonlySet<ReviewFileId>
  readonly tooLargeFileIds: ReadonlySet<ReviewFileId>
  readonly fileErrors: ReadonlyMap<ReviewFileId, string>
  readonly snapshotRefresh: ReviewSnapshotRefreshStatus
}

/** Narrow current-state and loading capability used by long-running viewport work. */
export interface ReviewSnapshotPageReader {
  readonly getFile: (fileId: ReviewFileId) => ParsedDiffFile | null
  readonly getProjection: () => ReviewSnapshotPageProjection
  readonly loadFiles: (fileIds: readonly ReviewFileId[]) => Promise<ReviewSnapshotLoadResult>
  readonly waitForManifestReplacement: (
    expectedSnapshotId: ReviewSnapshotId,
    signal: AbortSignal,
  ) => Promise<ReviewSnapshotId>
}

/** Private IPC and expiry callbacks retained outside atom values. */
export interface ReviewSnapshotPageRuntime {
  readonly getPage: (request: ReviewSnapshotPageRequest) => Promise<ReviewSnapshotPageResponse>
  readonly onExpired: () => void | Promise<void>
}

interface ReviewSnapshotPageModel {
  readonly revision: number
  readonly projection: ReviewSnapshotPageProjection
}

interface PendingFileLoad {
  readonly fileId: ReviewFileId
  readonly generation: number
  readonly promise: Promise<void>
  readonly snapshotId: ReviewSnapshotId
  readonly resolve: () => void
}

interface PendingManifestReplacement {
  readonly resolve: (snapshotId: ReviewSnapshotId) => void
  readonly reject: () => void
}

const IDLE_SNAPSHOT_REFRESH: ReviewSnapshotRefreshStatus = Object.freeze({ _tag: "idle" })
const REFRESHING_SNAPSHOT: ReviewSnapshotRefreshStatus = Object.freeze({ _tag: "refreshing" })

const emptyProjection = (manifest: ReviewSnapshotManifest): ReviewSnapshotPageProjection =>
  Object.freeze({
    projectId: manifest.projectId,
    snapshotId: manifest.snapshotId,
    files: Object.freeze([]),
    loadingFileIds: new Set<ReviewFileId>(),
    tooLargeFileIds: new Set<ReviewFileId>(),
    fileErrors: new Map<ReviewFileId, string>(),
    snapshotRefresh: IDLE_SNAPSHOT_REFRESH,
  })

const makePendingFileLoad = (
  fileId: ReviewFileId,
  generation: number,
  snapshotId: ReviewSnapshotId,
): PendingFileLoad => {
  let resolve: () => void = noop
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { fileId, generation, promise, snapshotId, resolve }
}

/**
 * Owns one explicitly disposable snapshot paging session while publishing only a
 * fixed pair of read-only Effect Atom values.
 */
export class ReviewSnapshotPageSession implements ReviewSnapshotPageReader {
  readonly #registry: AtomRegistry.AtomRegistry
  readonly #cache = new ReviewPageCache()
  readonly #modelAtom: Atom.Writable<ReviewSnapshotPageModel>
  readonly #releases: Array<() => void> = []
  readonly #inFlight = new Map<ReviewFileId, PendingFileLoad>()
  readonly #failureCauses = new Map<ReviewFileId, TransportError>()
  readonly #manifestReplacementWaiters = new Set<PendingManifestReplacement>()
  #manifest: ReviewSnapshotManifest
  #runtime: ReviewSnapshotPageRuntime | null
  #generation = 0
  #queued: PendingFileLoad[] = []
  #persistentPins: ReadonlySet<ReviewFileId> = new Set()
  #expired = false
  #drainingGeneration: number | null = null
  #drainScheduled = false
  #disposed = false

  /** Read-only page snapshot for React and non-React observers. */
  readonly projectionAtom: Atom.Atom<ReviewSnapshotPageProjection>

  /** Stable narrowed capability that omits manifest and lifecycle mutation. */
  readonly reader: ReviewSnapshotPageReader

  constructor(
    registry: AtomRegistry.AtomRegistry,
    manifest: ReviewSnapshotManifest,
    runtime: ReviewSnapshotPageRuntime,
  ) {
    this.#registry = registry
    this.#manifest = manifest
    this.#runtime = runtime
    this.#modelAtom = Atom.make({ revision: 0, projection: emptyProjection(manifest) })
    this.projectionAtom = Atom.readable((get) => get(this.#modelAtom).projection)
    this.reader = Object.freeze({
      getFile: this.getFile,
      getProjection: this.getProjection,
      loadFiles: this.loadFiles,
      waitForManifestReplacement: this.waitForManifestReplacement,
    })
  }

  /** Mounts the fixed atom bundle until explicit session disposal. */
  readonly mount = (): void => {
    if (this.#disposed || this.#releases.length > 0) return
    this.#releases.push(this.#registry.mount(this.#modelAtom))
    this.#releases.push(this.#registry.mount(this.projectionAtom))
  }

  /** Replaces private callbacks without changing atom identity or published state. */
  readonly updateRuntime = (runtime: ReviewSnapshotPageRuntime): void => {
    if (this.#disposed) return
    this.#runtime = runtime
  }

  /** Reports whether the exact manifest object currently owns this generation. */
  readonly isManifestActive = (manifest: ReviewSnapshotManifest): boolean =>
    !this.#disposed && this.#manifest === manifest

  /** Invalidates prior work and activates an exact replacement manifest, even with the same ID. */
  readonly replaceManifest = (manifest: ReviewSnapshotManifest): void => {
    if (this.#disposed || this.#manifest === manifest) return
    this.#generation += 1
    this.#manifest = manifest
    for (const pending of this.#inFlight.values()) pending.resolve()
    this.#inFlight.clear()
    this.#queued = []
    this.#expired = false
    this.#persistentPins = new Set()
    this.#failureCauses.clear()
    this.#cache.clear()
    this.#setProjection(emptyProjection(manifest))
    for (const waiter of this.#manifestReplacementWaiters) {
      waiter.resolve(manifest.snapshotId)
    }
  }

  /** Returns one cached file while preserving private LRU promotion semantics. */
  readonly getFile = (fileId: ReviewFileId): ParsedDiffFile | null =>
    this.#disposed || this.#expired ? null : this.#cache.get(fileId)

  /** Returns the latest read-only atom projection without relying on a React render. */
  readonly getProjection = (): ReviewSnapshotPageProjection =>
    this.#registry.get(this.projectionAtom)

  /** Waits for atom-driven manifest reacquisition without owning the acquisition itself. */
  readonly waitForManifestReplacement = (
    expectedSnapshotId: ReviewSnapshotId,
    signal: AbortSignal,
  ): Promise<ReviewSnapshotId> => {
    if (signal.aborted || this.#disposed) return Promise.reject(abortError())
    if (!this.#expired || this.#manifest.snapshotId !== expectedSnapshotId) {
      return Promise.resolve(this.#manifest.snapshotId)
    }
    return new Promise<ReviewSnapshotId>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort)
        this.#manifestReplacementWaiters.delete(waiter)
      }
      const waiter: PendingManifestReplacement = {
        resolve: (snapshotId) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(snapshotId)
        },
        reject: () => {
          if (settled) return
          settled = true
          cleanup()
          reject(abortError())
        },
      }
      const onAbort = waiter.reject
      this.#manifestReplacementWaiters.add(waiter)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /** Replaces persistent LRU pins and applies any newly available eviction capacity. */
  readonly setPinnedFileIds = (fileIds: ReadonlySet<ReviewFileId>): void => {
    if (this.#disposed) return
    if (
      fileIds.size === this.#persistentPins.size &&
      [...fileIds].every((fileId) => this.#persistentPins.has(fileId))
    ) {
      return
    }
    const previousFileCount = this.#cache.stats().files
    this.#persistentPins = new Set(fileIds)
    this.#cache.put([], this.#cachePins())
    if (this.#cache.stats().files !== previousFileCount) {
      this.#publish({ files: Object.freeze([...this.#cache.files()]) })
    }
  }

  /** Loads unique files through the serialized bounded queue and awaits every owner promise. */
  readonly loadFiles = async (
    requestedFileIds: readonly ReviewFileId[],
  ): Promise<ReviewSnapshotLoadResult> => {
    const generation = this.#generation
    const manifest = this.#manifest
    const snapshotId = manifest.snapshotId
    const uniqueFileIds = [...new Set(requestedFileIds)]
    const loadResult = (): ReviewSnapshotLoadResult => ({
      snapshotId,
      statuses: new Map(
        uniqueFileIds.map((fileId) => {
          let status: ReviewSnapshotFileLoadStatus
          if (
            this.#disposed ||
            generation !== this.#generation ||
            this.#manifest !== manifest ||
            this.#manifest.snapshotId !== snapshotId
          ) {
            status = "cancelled"
          } else if (this.#expired) {
            status = "expired"
          } else if (this.#cache.get(fileId) !== null) {
            status = "loaded"
          } else if (this.#projection().tooLargeFileIds.has(fileId)) {
            status = "tooLarge"
          } else if (this.#projection().fileErrors.has(fileId)) {
            status = "failed"
          } else {
            status = "cancelled"
          }
          return [fileId, status] as const
        }),
      ),
      failureCauses: new Map(
        uniqueFileIds.flatMap((fileId) => {
          const cause = this.#failureCauses.get(fileId)
          return cause === undefined ? [] : ([[fileId, cause]] as const)
        }),
      ),
    })
    if (this.#disposed) return loadResult()
    const requested = uniqueFileIds.filter(
      (fileId) =>
        this.#cache.get(fileId) === null && !this.#projection().tooLargeFileIds.has(fileId),
    )
    if (requested.length === 0) return loadResult()
    if (this.#expired) return loadResult()

    this.#updateFileErrors(requested, null)
    for (const fileId of requested) this.#failureCauses.delete(fileId)
    const promises: Promise<void>[] = []
    let added = false
    for (const fileId of requested) {
      const existing = this.#inFlight.get(fileId)
      if (existing !== undefined) {
        promises.push(existing.promise)
        continue
      }
      const pending = makePendingFileLoad(fileId, this.#generation, this.#manifest.snapshotId)
      this.#inFlight.set(fileId, pending)
      this.#queued.push(pending)
      promises.push(pending.promise)
      added = true
    }
    if (added) {
      this.#publish({ loadingFileIds: new Set(this.#inFlight.keys()) })
      this.#scheduleDrain()
    }
    await Promise.all(promises)
    return loadResult()
  }

  /**
   * Terminally invalidates work, settles callers as cancelled, clears state, and
   * releases only this session's atom mounts.
   */
  readonly dispose = (): void => {
    if (this.#disposed) return
    this.#generation += 1
    this.#disposed = true
    this.#drainScheduled = false
    this.#drainingGeneration = null
    this.#queued = []
    const pending = [...this.#inFlight.values()]
    this.#inFlight.clear()
    this.#cache.clear()
    this.#persistentPins = new Set()
    this.#failureCauses.clear()
    this.#expired = false
    this.#runtime = null
    this.#setProjection(emptyProjection(this.#manifest))
    for (const load of pending) load.resolve()
    for (const waiter of this.#manifestReplacementWaiters) waiter.reject()
    for (;;) {
      const release = this.#releases.pop()
      if (release === undefined) break
      try {
        release()
      } catch {
        // The owning React registry may already have completed delayed disposal.
      }
    }
  }

  readonly #projection = (): ReviewSnapshotPageProjection =>
    this.#registry.get(this.#modelAtom).projection

  readonly #setProjection = (projection: ReviewSnapshotPageProjection): void => {
    const current = this.#registry.get(this.#modelAtom)
    this.#registry.set(this.#modelAtom, { revision: current.revision + 1, projection })
  }

  readonly #publish = (patch: Partial<ReviewSnapshotPageProjection>): void => {
    if (this.#disposed) return
    this.#setProjection(Object.freeze({ ...this.#projection(), ...patch }))
  }

  readonly #cachePins = (responseFileIds: ReadonlySet<ReviewFileId> = new Set()) => {
    const pins = new Set<string>(this.#persistentPins)
    for (const fileId of responseFileIds) pins.add(fileId)
    return pins
  }

  readonly #updateFileErrors = (
    fileIds: readonly ReviewFileId[],
    message: string | null,
    generation = this.#generation,
  ): void => {
    if (this.#disposed || generation !== this.#generation || fileIds.length === 0) return
    const next = new Map(this.#projection().fileErrors)
    let changed = false
    for (const fileId of fileIds) {
      if (message === null) changed = next.delete(fileId) || changed
      else if (next.get(fileId) !== message) {
        next.set(fileId, message)
        changed = true
      }
    }
    if (changed) this.#publish({ fileErrors: new Map(next) })
  }

  readonly #settleLoads = (loads: readonly PendingFileLoad[]): void => {
    let changed = false
    for (const load of loads) {
      if (this.#inFlight.get(load.fileId) !== load) continue
      this.#inFlight.delete(load.fileId)
      load.resolve()
      changed = true
    }
    if (changed && !this.#disposed) {
      this.#publish({ loadingFileIds: new Set(this.#inFlight.keys()) })
    }
  }

  readonly #failFileIds = (
    fileIds: readonly ReviewFileId[],
    message: string,
    generation: number,
    cause?: TransportError,
  ): void => {
    if (!this.#disposed && generation === this.#generation) {
      for (const fileId of fileIds) {
        if (cause === undefined) this.#failureCauses.delete(fileId)
        else this.#failureCauses.set(fileId, cause)
      }
    }
    this.#updateFileErrors(fileIds, message, generation)
    this.#settleLoads(
      fileIds.flatMap((fileId) => {
        const pending = this.#inFlight.get(fileId)
        return pending?.generation === generation ? [pending] : []
      }),
    )
  }

  readonly #expireSnapshot = async (generation: number): Promise<void> => {
    if (this.#disposed || generation !== this.#generation) return
    const affected = [...this.#inFlight.values()].filter(
      (pending) => pending.generation === generation,
    )
    const affectedFileIds = affected.map((pending) => pending.fileId)
    this.#queued = this.#queued.filter((pending) => pending.generation !== generation)
    this.#updateFileErrors(affectedFileIds, null, generation)
    this.#settleLoads(affected)
    if (this.#expired || this.#disposed) return
    this.#expired = true
    this.#publish({ files: Object.freeze([]), snapshotRefresh: REFRESHING_SNAPSHOT })
    const onExpired = this.#runtime?.onExpired
    if (onExpired === undefined) return
    try {
      await onExpired()
    } catch (cause) {
      if (this.#disposed || generation !== this.#generation) return
      const message = formatError(cause, "Could not refresh the expired review snapshot")
      this.#publish({ snapshotRefresh: Object.freeze({ _tag: "failed", message }) })
    }
  }

  readonly #processSelection = async (loads: readonly PendingFileLoad[]): Promise<void> => {
    const first = loads[0]
    if (first === undefined) return
    const { generation, snapshotId } = first
    let selection = loads.map((pending) => pending.fileId)
    const remaining = new Set(selection)
    let cursor: ReviewSnapshotPageCursor | null = null

    while (remaining.size > 0) {
      if (
        this.#disposed ||
        generation !== this.#generation ||
        this.#manifest.snapshotId !== snapshotId ||
        this.#expired
      ) {
        this.#settleLoads(loads)
        return
      }

      let response: ReviewSnapshotPageResponse
      try {
        const getPage = this.#runtime?.getPage
        if (getPage === undefined) {
          this.#settleLoads(loads)
          return
        }
        response = Schema.decodeUnknownSync(ReviewSnapshotPageResponse)(
          // oxlint-disable-next-line eslint/no-await-in-loop -- Selection continuations must remain serialized and cursor-bound.
          await getPage(ReviewSnapshotPageRequest.make({ snapshotId, cursor, fileIds: selection })),
        )
      } catch (cause) {
        this.#failFileIds(
          [...remaining],
          formatError(cause, LOAD_ERROR_FALLBACK),
          generation,
          rendererTransportError(cause, "reviewSnapshots:getPage"),
        )
        return
      }

      if (
        this.#disposed ||
        generation !== this.#generation ||
        this.#manifest.snapshotId !== snapshotId
      ) {
        return
      }
      if (
        Match.valueTags(response, {
          expired: () => true,
          fileTooLarge: () => false,
          available: () => false,
        })
      ) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Expiry recovery must settle before this serialized queue can advance.
        await this.#expireSnapshot(generation)
        return
      }
      if (response.snapshotId !== snapshotId) {
        this.#failFileIds([...remaining], INCOMPLETE_PAGE_ERROR, generation)
        return
      }
      const tooLarge = Match.valueTags(response, {
        fileTooLarge: (value) => value,
        expired: () => null,
        available: () => null,
      })
      if (tooLarge !== null) {
        const fileId = tooLarge.file.fileId
        if (!remaining.has(fileId) || !selection.includes(fileId)) {
          this.#failFileIds([...remaining], INCOMPLETE_PAGE_ERROR, generation)
          return
        }
        this.#publish({
          tooLargeFileIds: new Set([...this.#projection().tooLargeFileIds, fileId]),
        })
        this.#updateFileErrors([fileId], null, generation)
        remaining.delete(fileId)
        const pending = this.#inFlight.get(fileId)
        if (pending?.generation === generation) this.#settleLoads([pending])

        // A too-large response has no cursor, so continue with a fresh remaining selection.
        selection = selection.filter((candidate) => remaining.has(candidate))
        cursor = null
        continue
      }

      const available = Match.valueTags(response, {
        available: (value) => value,
        expired: () => null,
        fileTooLarge: () => null,
      })
      if (available === null) return

      const responseFileIds = new Set(available.files.map((file) => file.fileId))
      if (
        (available.files.length === 0 && available.nextCursor !== null) ||
        available.files.some(
          (file) => !remaining.has(file.fileId) || !selection.includes(file.fileId),
        )
      ) {
        this.#failFileIds([...remaining], INCOMPLETE_PAGE_ERROR, generation)
        return
      }

      try {
        this.#cache.put(available.files, this.#cachePins(responseFileIds))
        this.#publish({ files: Object.freeze([...this.#cache.files()]) })
      } catch (cause) {
        this.#failFileIds(
          [...remaining],
          formatError(cause, LOAD_ERROR_FALLBACK),
          generation,
          rendererTransportError(cause, "reviewSnapshots:getPage"),
        )
        return
      }

      const completed = available.files.flatMap((file) => {
        remaining.delete(file.fileId)
        const pending = this.#inFlight.get(file.fileId)
        return pending?.generation === generation ? [pending] : []
      })
      this.#settleLoads(completed)

      if (available.nextCursor !== null) {
        // Keep the exact selection paired with its opaque cursor.
        cursor = available.nextCursor
        continue
      }
      if (remaining.size > 0) {
        this.#failFileIds([...remaining], INCOMPLETE_PAGE_ERROR, generation)
      }
      return
    }
  }

  readonly #drainQueue = async (): Promise<void> => {
    const ownerGeneration = this.#generation
    if (this.#disposed || this.#drainingGeneration === ownerGeneration) return
    this.#drainingGeneration = ownerGeneration
    try {
      while (!this.#disposed && this.#generation === ownerGeneration && this.#queued.length > 0) {
        const first = this.#queued.shift()
        if (
          first === undefined ||
          first.generation !== ownerGeneration ||
          this.#inFlight.get(first.fileId) !== first
        ) {
          continue
        }
        const batch = [first]
        while (batch.length < REVIEW_SNAPSHOT_PAGE_FILE_LIMIT && this.#queued.length > 0) {
          const pending = this.#queued[0]
          if (pending === undefined) break
          if (this.#inFlight.get(pending.fileId) !== pending) {
            this.#queued.shift()
            continue
          }
          if (pending.generation !== first.generation || pending.snapshotId !== first.snapshotId) {
            break
          }
          batch.push(pending)
          this.#queued.shift()
        }
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- One queue owner per manifest generation serializes active IPC and cache writes.
          await this.#processSelection(batch)
        } catch (cause) {
          this.#failFileIds(
            batch.map((pending) => pending.fileId),
            formatError(cause, LOAD_ERROR_FALLBACK),
            first.generation,
            rendererTransportError(cause, "reviewSnapshots:getPage"),
          )
        }
      }
    } finally {
      if (this.#drainingGeneration === ownerGeneration) this.#drainingGeneration = null
      if (!this.#disposed && this.#queued.length > 0) this.#scheduleDrain()
    }
  }

  readonly #scheduleDrain = (): void => {
    if (this.#disposed || this.#drainScheduled || this.#drainingGeneration === this.#generation) {
      return
    }
    this.#drainScheduled = true
    queueMicrotask(() => {
      this.#drainScheduled = false
      if (!this.#disposed) void this.#drainQueue()
    })
  }
}

const abortError = (): DOMException =>
  new DOMException("Snapshot page session aborted", "AbortError")
