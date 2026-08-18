import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  ReviewSnapshotFileInventory,
  type ReviewSnapshotManifest,
} from "@diffdash/domain/review-context"
import type {
  ReviewFileId,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import { ReviewKey } from "@diffdash/domain/review-identity"
import type {
  ProgressiveReviewApi,
  ResolvedReviewSessionTarget,
  ReviewSessionFile,
  ReviewSessionIdentity,
  ReviewSessionRange,
  ReviewSessionRangeRequest,
  ReviewSessionState,
  ReviewSessionTargetRequest,
} from "@diffdash/protocol/review-session"
import { Match } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

import { formatError } from "@/shared/errors"
import type { ReviewSessionGateway } from "./progressive-review-session"

const LOAD_ERROR_FALLBACK = "Could not load this diff"
const INVENTORY_ERROR_FALLBACK = "Could not load changed files"
const EAGER_FILE_LOAD_CONCURRENCY = 8

/** Terminal state for one progressive file load. */
export type ProgressiveReviewFileLoadStatus = "loaded" | "failed" | "expired" | "cancelled"

/** Result returned after every requested progressive file reaches a terminal state. */
export interface ProgressiveReviewLoadResult {
  readonly snapshotId: ReviewSnapshotId
  readonly statuses: ReadonlyMap<ReviewFileId, ProgressiveReviewFileLoadStatus>
  readonly failureCauses: ReadonlyMap<ReviewFileId, Error>
}

/** Session-level refresh lifecycle shown by unloaded file placeholders. */
export type ProgressiveReviewRefreshStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "refreshing" }
  | { readonly _tag: "failed"; readonly message: string }

/** Current progressive review content published to React. */
export interface ProgressiveReviewContentProjection {
  readonly projectId: ReviewProjectId
  readonly snapshotId: ReviewSnapshotId
  readonly identity: ReviewSessionIdentity | null
  readonly inventory: readonly ReviewSnapshotFileInventory[]
  readonly inventoryLoading: boolean
  readonly inventoryError: string | null
  readonly files: readonly ParsedDiffFile[]
  readonly loadingFileIds: ReadonlySet<ReviewFileId>
  readonly fileErrors: ReadonlyMap<ReviewFileId, string>
  readonly snapshotRefresh: ProgressiveReviewRefreshStatus
}

/** Narrow current-state and loading capability used by viewport navigation. */
export interface ProgressiveReviewContentReader {
  readonly getFile: (fileId: ReviewFileId) => ParsedDiffFile | null
  readonly getProjection: () => ProgressiveReviewContentProjection
  readonly loadFiles: (fileIds: readonly ReviewFileId[]) => Promise<ProgressiveReviewLoadResult>
  readonly readRange: (
    request: Omit<ReviewSessionRangeRequest, "identity">,
    wait: boolean,
    signal: AbortSignal,
  ) => Promise<ReviewSessionRange>
  readonly resolveTarget: (
    request: Omit<ReviewSessionTargetRequest, "identity">,
    signal: AbortSignal,
  ) => Promise<ResolvedReviewSessionTarget>
  readonly waitForManifestReplacement: (
    expectedSnapshotId: ReviewSnapshotId,
    signal: AbortSignal,
  ) => Promise<ReviewSnapshotId>
}

interface ManifestWaiter {
  readonly expectedSnapshotId: ReviewSnapshotId
  readonly resolve: (snapshotId: ReviewSnapshotId) => void
  readonly reject: (cause: Error) => void
}

const emptyProjection = (manifest: ReviewSnapshotManifest): ProgressiveReviewContentProjection => ({
  projectId: manifest.projectId,
  snapshotId: manifest.snapshotId,
  identity: null,
  inventory: [],
  inventoryLoading: true,
  inventoryError: null,
  files: [],
  loadingFileIds: new Set(),
  fileErrors: new Map(),
  snapshotRefresh: { _tag: "idle" },
})

/** Owns one progressive Core session and admits only exact current-session publications. */
export class ProgressiveReviewContentSession implements ProgressiveReviewContentReader {
  readonly #registry: AtomRegistry.AtomRegistry
  readonly #api: ProgressiveReviewApi
  readonly #gateway: ReviewSessionGateway
  readonly #projectionAtom: Atom.Writable<ProgressiveReviewContentProjection>
  readonly #releases: Array<() => void> = []
  readonly #files = new Map<ReviewFileId, ParsedDiffFile>()
  readonly #inFlight = new Map<ReviewFileId, Promise<ProgressiveReviewFileLoadStatus>>()
  readonly #abortControllers = new Set<AbortController>()
  readonly #manifestWaiters = new Set<ManifestWaiter>()
  #manifest: ReviewSnapshotManifest
  #onExpired: () => void | Promise<void>
  #releaseConnection: (() => void) | null = null
  #identity: ReviewSessionIdentity | null = null
  #inventoryLoaded = false
  #inventoryRequestActive = false
  #generation = 0
  #disposed = false

  /** Read-only projection consumed by the React adapter. */
  readonly projectionAtom: Atom.Atom<ProgressiveReviewContentProjection>

  /** Stable reader passed into viewport navigation. */
  readonly reader: ProgressiveReviewContentReader

  constructor(
    registry: AtomRegistry.AtomRegistry,
    manifest: ReviewSnapshotManifest,
    api: ProgressiveReviewApi,
    gateway: ReviewSessionGateway,
    onExpired: () => void | Promise<void>,
  ) {
    this.#registry = registry
    this.#manifest = manifest
    this.#api = api
    this.#gateway = gateway
    this.#onExpired = onExpired
    this.#projectionAtom = Atom.make(emptyProjection(manifest))
    this.projectionAtom = Atom.readable((get) => get(this.#projectionAtom))
    this.reader = Object.freeze({
      getFile: this.getFile,
      getProjection: this.getProjection,
      loadFiles: this.loadFiles,
      readRange: this.readRange,
      resolveTarget: this.resolveTarget,
      waitForManifestReplacement: this.waitForManifestReplacement,
    })
  }

  /** Mounts atoms and starts the progressive session. */
  readonly mount = (): void => {
    if (this.#disposed || this.#releases.length > 0) return
    this.#releases.push(this.#registry.mount(this.#projectionAtom))
    this.#releases.push(this.#registry.mount(this.projectionAtom))
    void this.#open(this.#generation)
  }

  /** Replaces callbacks without changing session or atom identity. */
  readonly updateRuntime = (onExpired: () => void | Promise<void>): void => {
    this.#onExpired = onExpired
  }

  /** Replaces the active snapshot and cancels every older operation. */
  readonly replaceManifest = (manifest: ReviewSnapshotManifest): void => {
    if (this.#disposed || this.#manifest === manifest) return
    const previousSnapshotId = this.#manifest.snapshotId
    this.#manifest = manifest
    this.#generation += 1
    this.#cancelOperations()
    void this.#closeConnection()
    this.#files.clear()
    this.#inventoryLoaded = false
    this.#inventoryRequestActive = false
    this.#publish(emptyProjection(manifest))
    for (const waiter of this.#manifestWaiters) {
      if (waiter.expectedSnapshotId === previousSnapshotId) {
        this.#manifestWaiters.delete(waiter)
        waiter.resolve(manifest.snapshotId)
      }
    }
    void this.#open(this.#generation)
  }

  /** Returns the complete parsed file retained for this review session. */
  readonly getFile = (fileId: ReviewFileId): ParsedDiffFile | null =>
    this.#files.get(fileId) ?? null

  /** Returns the current immutable projection. */
  readonly getProjection = (): ProgressiveReviewContentProjection =>
    this.#registry.get(this.#projectionAtom)

  /** Loads requested files through sequential bounded persisted ranges. */
  readonly loadFiles = async (
    fileIds: readonly ReviewFileId[],
  ): Promise<ProgressiveReviewLoadResult> => {
    const snapshotId = this.#manifest.snapshotId
    const statuses = new Map<ReviewFileId, ProgressiveReviewFileLoadStatus>()
    const failureCauses = new Map<ReviewFileId, Error>()
    let nextIndex = 0
    const loadNext = async (): Promise<void> => {
      const fileId = fileIds[nextIndex]
      nextIndex += 1
      if (fileId === undefined) return
      if (this.#files.has(fileId)) {
        statuses.set(fileId, "loaded")
      } else {
        const existing = this.#inFlight.get(fileId)
        try {
          const status = await (existing ?? this.#startFileLoad(fileId))
          statuses.set(fileId, status)
        } catch (cause) {
          const error = new Error(formatError(cause, LOAD_ERROR_FALLBACK))
          statuses.set(fileId, "failed")
          failureCauses.set(fileId, error)
        }
      }
      return loadNext()
    }
    await Promise.all(
      Array.from({ length: Math.min(EAGER_FILE_LOAD_CONCURRENCY, fileIds.length) }, loadNext),
    )
    return { snapshotId, statuses, failureCauses }
  }

  /** Reads one legal bounded persisted range without reconstructing its complete file. */
  readonly readRange = async (
    request: Omit<ReviewSessionRangeRequest, "identity">,
    wait: boolean,
    signal: AbortSignal,
  ): Promise<ReviewSessionRange> => {
    const identity = this.#identity
    const generation = this.#generation
    if (identity === null || signal.aborted) throw new DOMException("Cancelled", "AbortError")
    const range = await (wait
      ? this.#api.waitForRange({ ...request, identity })
      : this.#api.readRange({ ...request, identity }))
    if (
      signal.aborted ||
      !this.#isIdentityCurrent(generation, identity) ||
      !sameIdentity(range.identity, identity)
    ) {
      throw new DOMException("Cancelled", "AbortError")
    }
    return range
  }

  /** Resolves an exact semantic target to its persisted legal block. */
  readonly resolveTarget = async (
    request: Omit<ReviewSessionTargetRequest, "identity">,
    signal: AbortSignal,
  ): Promise<ResolvedReviewSessionTarget> => {
    const identity = this.#identity
    const generation = this.#generation
    if (identity === null || signal.aborted) throw new DOMException("Cancelled", "AbortError")
    const target = await this.#api.resolveTarget({ ...request, identity })
    if (
      signal.aborted ||
      !this.#isIdentityCurrent(generation, identity) ||
      !sameIdentity(target.identity, identity)
    ) {
      throw new DOMException("Cancelled", "AbortError")
    }
    return target
  }

  /** Waits until React replaces the expired manifest. */
  readonly waitForManifestReplacement = (
    expectedSnapshotId: ReviewSnapshotId,
    signal: AbortSignal,
  ): Promise<ReviewSnapshotId> => {
    if (this.#manifest.snapshotId !== expectedSnapshotId)
      return Promise.resolve(this.#manifest.snapshotId)
    if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"))
    return new Promise((resolve, reject) => {
      let waiter: ManifestWaiter
      const abort = () => {
        this.#manifestWaiters.delete(waiter)
        reject(new DOMException("Cancelled", "AbortError"))
      }
      signal.addEventListener("abort", abort, { once: true })
      waiter = {
        expectedSnapshotId,
        resolve: (snapshotId) => {
          signal.removeEventListener("abort", abort)
          resolve(snapshotId)
        },
        reject,
      }
      this.#manifestWaiters.add(waiter)
    })
  }

  /** Cancels all work and closes the exact Core session. */
  readonly dispose = (): void => {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#cancelOperations()
    void this.#closeConnection()
    for (const waiter of this.#manifestWaiters)
      waiter.reject(new DOMException("Disposed", "AbortError"))
    this.#manifestWaiters.clear()
    for (;;) {
      const release = this.#releases.pop()
      if (release === undefined) break
      release()
    }
  }

  readonly #open = async (generation: number): Promise<void> => {
    try {
      const connection = await this.#gateway.openSession({
        projectId: this.#manifest.projectId,
        reviewKey: this.#manifest.reviewKey,
        snapshotId: this.#manifest.snapshotId,
      })
      if (!this.#isGenerationCurrent(generation)) {
        connection.subscribe(() => undefined)()
        return
      }
      this.#releaseConnection = connection.subscribe((state) =>
        this.#acceptState(generation, state),
      )
    } catch (cause) {
      if (!this.#isGenerationCurrent(generation)) return
      this.#publish({
        ...this.getProjection(),
        inventoryLoading: false,
        inventoryError: formatError(cause, INVENTORY_ERROR_FALLBACK),
      })
    }
  }

  readonly #acceptState = (generation: number, state: ReviewSessionState): void => {
    if (!this.#isGenerationCurrent(generation)) return
    if (
      state.identity.projectId !== this.#manifest.projectId ||
      state.identity.reviewKey !== this.#manifest.reviewKey ||
      state.identity.snapshotId !== this.#manifest.snapshotId
    ) {
      return
    }
    this.#identity = state.identity
    this.#publish({ ...this.getProjection(), identity: state.identity })
    Match.valueTags(state, {
      negotiation: () => undefined,
      reservation: () => void this.#loadInventory(generation, state.identity),
      indexing: () => void this.#loadInventory(generation, state.identity),
      verification: () => void this.#loadInventory(generation, state.identity),
      ready: () => void this.#loadInventory(generation, state.identity),
      invalidated: () => void this.#expire(generation),
      disposed: () => void this.#expire(generation),
      failed: (failure) =>
        this.#publish({
          ...this.getProjection(),
          inventoryLoading: false,
          inventoryError: failure.safeMessage,
        }),
    })
  }

  readonly #loadInventory = async (
    generation: number,
    identity: ReviewSessionIdentity,
  ): Promise<void> => {
    if (this.#inventoryLoaded || this.#inventoryRequestActive) return
    this.#inventoryRequestActive = true
    try {
      const files: ReviewSessionFile[] = []
      let offset = 0
      while (this.#isIdentityCurrent(generation, identity)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Inventory offsets are authoritative and sequential.
        const page = await this.#api.inventory({ identity, offset, limit: 256 })
        if (
          !this.#isIdentityCurrent(generation, identity) ||
          !sameIdentity(page.identity, identity)
        )
          return
        files.push(...page.files)
        if (page.nextOffset === null) break
        offset = page.nextOffset
      }
      if (!this.#isIdentityCurrent(generation, identity)) return
      const inventory = files.map((file) =>
        ReviewSnapshotFileInventory.make({
          fileId: file.fileId,
          patchHash: file.patchHash,
          reviewKey: ReviewKey.make(
            file.oldPath === null ? file.path : `${file.oldPath}->${file.path}`,
          ),
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          visibility: file.visibility,
          additions: file.additions,
          deletions: file.deletions,
          hunkCount: file.hunkCount,
        }),
      )
      this.#inventoryLoaded = true
      this.#publish({
        ...this.getProjection(),
        inventory,
        inventoryLoading: false,
        inventoryError: null,
      })
    } catch (cause) {
      if (!this.#isIdentityCurrent(generation, identity)) return
      this.#publish({
        ...this.getProjection(),
        inventoryLoading: false,
        inventoryError: formatError(cause, INVENTORY_ERROR_FALLBACK),
      })
    } finally {
      this.#inventoryRequestActive = false
    }
  }

  readonly #startFileLoad = (fileId: ReviewFileId): Promise<ProgressiveReviewFileLoadStatus> => {
    const generation = this.#generation
    const identity = this.#identity
    if (identity === null) return Promise.resolve("cancelled")
    const controller = new AbortController()
    this.#abortControllers.add(controller)
    this.#publish({
      ...this.getProjection(),
      loadingFileIds: new Set([...this.getProjection().loadingFileIds, fileId]),
      fileErrors: withoutKey(this.getProjection().fileErrors, fileId),
    })
    const promise = this.#readFile(generation, identity, fileId, controller.signal)
      .then((file) => {
        if (file === null) return "cancelled" as const
        this.#files.set(fileId, file)
        const inventory = this.getProjection().inventory
        const files = inventory.flatMap((entry) => {
          const retained = this.#files.get(entry.fileId)
          return retained === undefined ? [] : [retained]
        })
        this.#publish({ ...this.getProjection(), files })
        return "loaded" as const
      })
      .catch((cause) => {
        if (controller.signal.aborted || !this.#isGenerationCurrent(generation))
          return "cancelled" as const
        const message = formatError(cause, LOAD_ERROR_FALLBACK)
        this.#publish({
          ...this.getProjection(),
          fileErrors: new Map([...this.getProjection().fileErrors, [fileId, message]]),
        })
        throw cause
      })
      .finally(() => {
        this.#abortControllers.delete(controller)
        this.#inFlight.delete(fileId)
        if (this.#isGenerationCurrent(generation)) {
          this.#publish({
            ...this.getProjection(),
            loadingFileIds: withoutValue(this.getProjection().loadingFileIds, fileId),
          })
        }
      })
    this.#inFlight.set(fileId, promise)
    return promise
  }

  readonly #readFile = async (
    generation: number,
    identity: ReviewSessionIdentity,
    fileId: ReviewFileId,
    signal: AbortSignal,
  ): Promise<ParsedDiffFile | null> => {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const chunks: string[] = []
    const readNext = async (startLine: number): Promise<boolean> => {
      if (!this.#isIdentityCurrent(generation, identity) || signal.aborted) return false
      const range = await this.#api.waitForRange({ identity, fileId, startLine })
      if (!this.#isIdentityCurrent(generation, identity) || !sameIdentity(range.identity, identity))
        return false
      for (const block of range.blocks) chunks.push(decoder.decode(block.bytes, { stream: true }))
      if (range.complete) return true
      const last = range.blocks.at(-1)
      if (last === undefined || last.firstLine + last.lineCount <= startLine) {
        throw new Error("Progressive review returned an incomplete range")
      }
      return readNext(last.firstLine + last.lineCount)
    }
    if (!(await readNext(0))) return null
    chunks.push(decoder.decode())
    const parsed = parseUnifiedDiff(chunks.join("")).files[0]
    if (parsed === undefined || parsed.fileId !== fileId) {
      throw new Error("Progressive review range did not match its inventory file")
    }
    const inventory = this.getProjection().inventory.find((file) => file.fileId === fileId)
    if (inventory === undefined) {
      throw new Error("Progressive review inventory is missing the loaded file")
    }
    if (parsed.hunks.length !== inventory.hunkCount) {
      throw new Error("Progressive review range metadata did not match persisted inventory")
    }
    return { ...parsed, ...inventory, hunks: parsed.hunks, patch: parsed.patch }
  }

  readonly #expire = async (generation: number): Promise<void> => {
    if (!this.#isGenerationCurrent(generation)) return
    this.#generation += 1
    this.#cancelOperations()
    this.#files.clear()
    this.#publish({
      ...this.getProjection(),
      identity: null,
      files: [],
      snapshotRefresh: { _tag: "refreshing" },
    })
    try {
      await this.#onExpired()
    } catch (cause) {
      if (this.#disposed) return
      this.#publish({
        ...this.getProjection(),
        snapshotRefresh: {
          _tag: "failed",
          message: formatError(cause, "Could not refresh the expired review snapshot"),
        },
      })
    }
  }

  readonly #closeConnection = async (): Promise<void> => {
    this.#releaseConnection?.()
    this.#releaseConnection = null
    const identity = this.#identity
    this.#identity = null
    if (identity !== null) {
      try {
        await this.#gateway.closeSession({ identity })
      } catch {
        // Closing a superseded Core process is best-effort; stale output is already rejected locally.
      }
    }
  }

  readonly #cancelOperations = (): void => {
    for (const controller of this.#abortControllers) controller.abort()
    this.#abortControllers.clear()
    this.#inFlight.clear()
  }

  readonly #isGenerationCurrent = (generation: number): boolean =>
    !this.#disposed && generation === this.#generation

  readonly #isIdentityCurrent = (generation: number, identity: ReviewSessionIdentity): boolean =>
    this.#isGenerationCurrent(generation) &&
    this.#identity !== null &&
    sameIdentity(this.#identity, identity)

  readonly #publish = (projection: ProgressiveReviewContentProjection): void => {
    if (!this.#disposed) this.#registry.set(this.#projectionAtom, Object.freeze(projection))
  }
}

/** Exact progressive identity comparison, including authoritative state version. */
export const sameProgressiveReviewIdentity = (
  left: ReviewSessionIdentity,
  right: ReviewSessionIdentity,
): boolean => sameIdentity(left, right)

const sameIdentity = (left: ReviewSessionIdentity, right: ReviewSessionIdentity): boolean =>
  left.projectId === right.projectId &&
  left.reviewKey === right.reviewKey &&
  left.snapshotId === right.snapshotId &&
  left.processId === right.processId &&
  left.sessionId === right.sessionId &&
  left.stateVersion === right.stateVersion

const withoutValue = <A>(values: ReadonlySet<A>, removed: A): ReadonlySet<A> => {
  const next = new Set(values)
  next.delete(removed)
  return next
}

const withoutKey = <K, V>(values: ReadonlyMap<K, V>, removed: K): ReadonlyMap<K, V> => {
  const next = new Map(values)
  next.delete(removed)
  return next
}
