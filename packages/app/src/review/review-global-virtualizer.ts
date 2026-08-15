import {
  type CompactReviewLayoutIndex,
  type ReviewHeightEstimator,
  type ReviewSemanticAnchor,
} from "./review-layout-index"

/** Independently budgeted renderer resource categories. */
export type ReviewCacheKind =
  | "text"
  | "syntax-ast"
  | "syntax-output"
  | "dom-container"
  | "annotation"
  | "measurement"
  | "prefetch"
  | "pin"

/** One resource participating in coordinated range eviction. */
export interface ReviewCacheResource {
  readonly kind: ReviewCacheKind
  readonly bytes: number
  readonly release: () => void
}

interface CacheEntry {
  readonly bytes: number
  readonly release: () => void
}

const CACHE_KINDS: readonly ReviewCacheKind[] = [
  "text",
  "syntax-ast",
  "syntax-output",
  "dom-container",
  "annotation",
  "measurement",
  "prefetch",
  "pin",
]

const MEBIBYTE = 1_024 * 1_024

/** D-12 independent renderer-cache ceilings. */
export const D12_REVIEW_CACHE_BUDGETS: Readonly<Record<ReviewCacheKind, number>> = {
  text: 128 * MEBIBYTE,
  "syntax-ast": 32 * MEBIBYTE,
  "syntax-output": 32 * MEBIBYTE,
  "dom-container": 32 * MEBIBYTE,
  annotation: 8 * MEBIBYTE,
  measurement: 8 * MEBIBYTE,
  prefetch: 16 * MEBIBYTE,
  pin: 8 * MEBIBYTE,
}

/** D-12 browser-safe logical page and mounted-row ceilings. */
export const D12_REVIEW_VIRTUALIZER_LIMITS = {
  browserPageHeight: 8_000_000,
  maximumMountedRows: 1_000,
} as const

/** Independent byte budgets with whole-range coordinated eviction. */
export class ReviewRendererCaches {
  readonly #entries = new Map<ReviewCacheKind, Map<string, CacheEntry>>()
  readonly #bytes = new Map<ReviewCacheKind, number>()

  constructor(private readonly budgets: Readonly<Record<ReviewCacheKind, number>>) {
    for (const kind of CACHE_KINDS) {
      const budget = budgets[kind]
      if (!Number.isSafeInteger(budget) || budget < 0)
        throw new RangeError(`Invalid ${kind} budget`)
      this.#entries.set(kind, new Map())
      this.#bytes.set(kind, 0)
    }
  }

  /** Adds a range atomically, then evicts whole least-recent ranges under each budget. */
  put(rangeKey: string, resources: readonly ReviewCacheResource[]): void {
    for (const resource of resources) {
      if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0) {
        throw new RangeError("Cache bytes must be a non-negative safe integer")
      }
    }
    this.delete(rangeKey)
    for (const resource of resources) {
      const entries = this.entries(resource.kind)
      const previous = entries.get(rangeKey)
      entries.set(
        rangeKey,
        previous === undefined
          ? { bytes: resource.bytes, release: resource.release }
          : {
              bytes: previous.bytes + resource.bytes,
              release: combineRelease(previous.release, resource.release),
            },
      )
      this.#bytes.set(resource.kind, this.bytes(resource.kind) + resource.bytes)
    }
    for (const kind of CACHE_KINDS) {
      while (this.bytes(kind) > this.budgets[kind]) {
        const oldest = this.entries(kind).keys().next().value
        if (oldest === undefined) break
        this.delete(oldest)
      }
    }
  }

  /** Promotes all resources for a range together. */
  touch(rangeKey: string): void {
    for (const kind of CACHE_KINDS) {
      const entries = this.entries(kind)
      const entry = entries.get(rangeKey)
      if (entry === undefined) continue
      entries.delete(rangeKey)
      entries.set(rangeKey, entry)
    }
  }

  /** Evicts and releases all independently accounted resources for a range. */
  delete(rangeKey: string): void {
    const failures: Error[] = []
    for (const kind of CACHE_KINDS) {
      const entries = this.entries(kind)
      const entry = entries.get(rangeKey)
      if (entry === undefined) continue
      entries.delete(rangeKey)
      this.#bytes.set(kind, this.bytes(kind) - entry.bytes)
      try {
        entry.release()
      } catch (error) {
        failures.push(new Error(`Could not release ${kind}`, { cause: error }))
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Could not release ${rangeKey}`)
  }

  /** Releases every retained range. */
  clear(): void {
    const keys = new Set<string>()
    for (const kind of CACHE_KINDS) for (const key of this.entries(kind).keys()) keys.add(key)
    for (const key of keys) this.delete(key)
  }

  /** Current bytes for one independently bounded category. */
  bytes(kind: ReviewCacheKind): number {
    return this.#bytes.get(kind) ?? 0
  }

  private entries(kind: ReviewCacheKind): Map<string, CacheEntry> {
    const entries = this.#entries.get(kind)
    if (entries === undefined) throw new Error(`Unknown cache kind: ${kind}`)
    return entries
  }
}

const combineRelease = (first: () => void, second: () => void) => () => {
  const failures: Error[] = []
  try {
    first()
  } catch (error) {
    failures.push(new Error("Could not release first cache resource", { cause: error }))
  }
  try {
    second()
  } catch (error) {
    failures.push(new Error("Could not release second cache resource", { cause: error }))
  }
  if (failures.length > 0) throw new AggregateError(failures, "Could not release cache resources")
}

/** A bounded browser scroll coordinate corresponding to an unbounded logical coordinate. */
export interface ReviewScrollPosition {
  readonly logicalTop: number
  readonly pageOrigin: number
  readonly physicalTop: number
}

/** Browser-height-safe logical scroll owner with exact rebasing and direct seeks. */
export class ReviewLogicalScroller {
  #pageOrigin = 0

  constructor(
    private readonly layout: CompactReviewLayoutIndex,
    readonly browserPageHeight: number,
  ) {
    if (!Number.isFinite(browserPageHeight) || browserPageHeight <= 0) {
      throw new RangeError("Browser page height must be positive")
    }
  }

  /** Directly seeks any file, including the final file, without walking intermediate shells. */
  seekFile(fileIndex: number): ReviewScrollPosition {
    return this.seek(this.layout.topOf(fileIndex))
  }

  /** Maps an exact logical target into the current bounded browser page. */
  seek(logicalTop: number): ReviewScrollPosition {
    const clamped = Math.min(Math.max(0, logicalTop), this.layout.logicalHeight)
    this.#pageOrigin = Math.floor(clamped / this.browserPageHeight) * this.browserPageHeight
    return {
      logicalTop: clamped,
      pageOrigin: this.#pageOrigin,
      physicalTop: clamped - this.#pageOrigin,
    }
  }

  /** Converts physical movement back to logical space and rebases near page edges. */
  updatePhysical(physicalTop: number): ReviewScrollPosition {
    if (!Number.isFinite(physicalTop)) throw new RangeError("Physical scroll top must be finite")
    return this.seek(this.#pageOrigin + Math.min(Math.max(0, physicalTop), this.browserPageHeight))
  }
}

/** Reset contract required before a renderer shell can return to the pool. */
export interface ReviewShellAdapter<Shell> {
  readonly create: () => Shell
  readonly reset: (shell: Shell) => void
  readonly destroy: (shell: Shell) => void
}

/** Small reset-safe shell pool; no observer is retained per review file. */
export class ReviewShellPool<Shell> {
  readonly #available: Shell[] = []

  constructor(
    private readonly maximum: number,
    private readonly adapter: ReviewShellAdapter<Shell>,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new RangeError("Invalid shell pool size")
  }

  /** Acquires a clean renderer shell. */
  acquire(): Shell {
    return this.#available.pop() ?? this.adapter.create()
  }

  /** Resets before pooling, destroying overflow shells. */
  release(shell: Shell): void {
    try {
      this.adapter.reset(shell)
    } catch (error) {
      try {
        this.adapter.destroy(shell)
      } catch (destroyError) {
        throw new AggregateError(
          [error, destroyError],
          "Could not reset or destroy a renderer shell",
        )
      }
      throw error
    }
    if (this.#available.length < this.maximum) this.#available.push(shell)
    else this.adapter.destroy(shell)
  }

  /** Destroys all idle shells. */
  clear(): void {
    for (const shell of this.#available) this.adapter.destroy(shell)
    this.#available.length = 0
  }

  /** Current idle shell count. */
  get size(): number {
    return this.#available.length
  }
}

/** One bounded global mount projection. */
export interface ReviewMountWindow {
  readonly files: Uint32Array
  readonly mountedRows: number
  readonly top: number
  readonly bottom: number
}

/** Review-wide virtualizer over compact layout and one bounded browser scroll page. */
export class ReviewGlobalVirtualizer {
  readonly scroller: ReviewLogicalScroller

  constructor(
    readonly layout: CompactReviewLayoutIndex,
    browserPageHeight: number,
    readonly maximumMountedRows: number,
  ) {
    if (!Number.isSafeInteger(maximumMountedRows) || maximumMountedRows <= 0) {
      throw new RangeError("Mounted row limit must be a positive safe integer")
    }
    this.scroller = new ReviewLogicalScroller(layout, browserPageHeight)
  }

  /** Primes estimated target geometry before I/O and performs an exact direct seek. */
  primeTargetShell(fileIndex: number, estimatedHeight: number): ReviewScrollPosition {
    this.layout.setHeight(fileIndex, estimatedHeight)
    return this.scroller.seekFile(fileIndex)
  }

  /** Computes a global file window while enforcing the mounted-row ceiling. */
  window(logicalTop: number, viewportHeight: number, overscan: number): ReviewMountWindow {
    if (this.layout.fileCount === 0) {
      return { files: new Uint32Array(), mountedRows: 0, top: 0, bottom: 0 }
    }
    const top = Math.max(0, logicalTop - Math.max(0, overscan))
    const bottom = Math.min(
      this.layout.logicalHeight,
      logicalTop + viewportHeight + Math.max(0, overscan),
    )
    const first = this.layout.fileAt(top)
    const files: number[] = []
    let rows = 0
    for (let file = first; file < this.layout.fileCount; file += 1) {
      if (this.layout.topOf(file) >= bottom && files.length > 0) break
      const fileRows = this.layout.rowCounts[file] ?? 0
      if (files.length > 0 && rows + fileRows > this.maximumMountedRows) break
      files.push(file)
      rows += Math.min(fileRows, this.maximumMountedRows - rows)
      if (rows >= this.maximumMountedRows) break
    }
    return { files: Uint32Array.from(files), mountedRows: rows, top, bottom }
  }

  /** Preserves a semantic row while width or unified/split mode changes estimates. */
  reflow(
    logicalTop: number,
    width: number,
    mode: "unified" | "split",
    estimateHeight: ReviewHeightEstimator,
  ): ReviewScrollPosition {
    const anchor: ReviewSemanticAnchor = this.layout.captureAnchor(logicalTop)
    return this.scroller.seek(this.layout.reflow(anchor, width, mode, estimateHeight))
  }

  /** Applies inverse-sticky correction only when changed content precedes the anchor. */
  correctMeasurement(
    logicalTop: number,
    anchorFile: number,
    measuredFile: number,
    nextHeight: number,
  ): ReviewScrollPosition {
    const previousHeight = this.layout.heightOf(measuredFile)
    this.layout.setHeight(measuredFile, nextHeight)
    const corrected =
      measuredFile < anchorFile ? logicalTop + nextHeight - previousHeight : logicalTop
    return this.scroller.seek(corrected)
  }
}
