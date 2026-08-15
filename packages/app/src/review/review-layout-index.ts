/** Bit flags stored once per file by the compact review index. */
export const ReviewFileFlag = {
  Hidden: 1 << 0,
  Viewed: 1 << 1,
} as const

/** Filters combined into the single tree and canvas visibility projection. */
export interface ReviewVisibilityPolicy {
  readonly showHidden: boolean
  readonly showViewed: boolean
  readonly pathMatches?: Uint8Array
  readonly walkthrough?: Uint8Array
  readonly revealed?: Uint8Array
}

/** Compact mapping shared by the file tree and review canvas. */
export class ReviewVisibilityProjection {
  readonly visibleFiles: Uint32Array
  readonly visibleIndexByFile: Int32Array

  constructor(flags: Uint8Array, policy: ReviewVisibilityPolicy) {
    validatePolicyLength(flags.length, policy.pathMatches, "pathMatches")
    validatePolicyLength(flags.length, policy.walkthrough, "walkthrough")
    validatePolicyLength(flags.length, policy.revealed, "revealed")

    const visibleIndexByFile = new Int32Array(flags.length)
    visibleIndexByFile.fill(-1)
    let count = 0
    for (let file = 0; file < flags.length; file += 1) {
      if (isVisible(flags[file] ?? 0, file, policy)) count += 1
    }
    const visibleFiles = new Uint32Array(count)
    let visibleIndex = 0
    for (let file = 0; file < flags.length; file += 1) {
      if (!isVisible(flags[file] ?? 0, file, policy)) continue
      visibleFiles[visibleIndex] = file
      visibleIndexByFile[file] = visibleIndex
      visibleIndex += 1
    }
    this.visibleFiles = visibleFiles
    this.visibleIndexByFile = visibleIndexByFile
  }

  /** Bytes held by projection metadata, excluding shared input flags. */
  get byteLength(): number {
    return this.visibleFiles.byteLength + this.visibleIndexByFile.byteLength
  }
}

/** A semantic position that survives width and diff-mode remeasurement. */
export interface ReviewSemanticAnchor {
  readonly fileIndex: number
  readonly row: number
  readonly rowFraction: number
}

/** Width/mode-sensitive height estimator used without allocating file objects. */
export type ReviewHeightEstimator = (
  fileIndex: number,
  rowCount: number,
  width: number,
  mode: "unified" | "split",
) => number

/** Typed-array global file layout with logarithmic updates and offset lookup. */
export class CompactReviewLayoutIndex {
  readonly rowCounts: Uint32Array
  readonly flags: Uint8Array
  readonly #heights: Float64Array
  readonly #tree: Float64Array

  constructor(rowCounts: Uint32Array, flags: Uint8Array, estimateHeight: ReviewHeightEstimator) {
    if (rowCounts.length !== flags.length) throw new RangeError("Review index arrays must align")
    this.rowCounts = rowCounts
    this.flags = flags
    this.#heights = new Float64Array(rowCounts.length)
    this.#tree = new Float64Array(rowCounts.length + 1)
    for (let file = 0; file < rowCounts.length; file += 1) {
      this.setHeight(file, estimateHeight(file, rowCounts[file] ?? 0, 1, "unified"))
    }
  }

  /** Number of files represented without per-file objects. */
  get fileCount(): number {
    return this.rowCounts.length
  }

  /** Current total logical review height. */
  get logicalHeight(): number {
    return this.prefix(this.fileCount)
  }

  /** Exact bytes held by compact numeric index storage. */
  get byteLength(): number {
    return (
      this.rowCounts.byteLength +
      this.flags.byteLength +
      this.#heights.byteLength +
      this.#tree.byteLength
    )
  }

  /** Returns the logical top of a file, including the final-file endpoint. */
  topOf(fileIndex: number): number {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > this.fileCount) {
      throw new RangeError("File index is outside the review")
    }
    return this.prefix(fileIndex)
  }

  /** Returns the current measured or estimated file height. */
  heightOf(fileIndex: number): number {
    this.assertFile(fileIndex)
    return this.#heights[fileIndex] ?? 0
  }

  /** Replaces one estimate after measurement in logarithmic time. */
  setHeight(fileIndex: number, height: number): void {
    this.assertFile(fileIndex)
    if (!Number.isFinite(height) || height <= 0)
      throw new RangeError("File height must be positive")
    const previous = this.#heights[fileIndex] ?? 0
    this.#heights[fileIndex] = height
    for (let cursor = fileIndex + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
      this.#tree[cursor] = (this.#tree[cursor] ?? 0) + height - previous
    }
  }

  /** Locates the file containing a logical offset in logarithmic time. */
  fileAt(logicalTop: number): number {
    if (this.fileCount === 0) return -1
    const target = Math.min(
      Math.max(0, logicalTop),
      Math.max(0, this.logicalHeight - Number.EPSILON),
    )
    let index = 0
    let sum = 0
    let bit = 1
    while (bit * 2 < this.#tree.length) bit *= 2
    for (; bit !== 0; bit = Math.floor(bit / 2)) {
      const next = index + bit
      const nextSum = sum + (this.#tree[next] ?? 0)
      if (next < this.#tree.length && nextSum <= target) {
        index = next
        sum = nextSum
      }
    }
    return Math.min(index, this.fileCount - 1)
  }

  /** Captures a row-relative anchor rather than a brittle pixel-only position. */
  captureAnchor(logicalTop: number): ReviewSemanticAnchor {
    const fileIndex = this.fileAt(logicalTop)
    if (fileIndex < 0) return { fileIndex: 0, row: 0, rowFraction: 0 }
    const rows = Math.max(1, this.rowCounts[fileIndex] ?? 0)
    const rowPosition = ((logicalTop - this.topOf(fileIndex)) / this.heightOf(fileIndex)) * rows
    const row = Math.min(rows - 1, Math.max(0, Math.floor(rowPosition)))
    return { fileIndex, row, rowFraction: rowPosition - row }
  }

  /** Resolves a semantic anchor against current measurements. */
  resolveAnchor(anchor: ReviewSemanticAnchor): number {
    if (this.fileCount === 0) return 0
    const fileIndex = Math.min(Math.max(0, anchor.fileIndex), this.fileCount - 1)
    const rows = Math.max(1, this.rowCounts[fileIndex] ?? 0)
    const rowPosition = Math.min(rows, Math.max(0, anchor.row + anchor.rowFraction))
    return this.topOf(fileIndex) + (rowPosition / rows) * this.heightOf(fileIndex)
  }

  /** Re-estimates all shells while preserving a semantic anchor. */
  reflow(
    anchor: ReviewSemanticAnchor,
    width: number,
    mode: "unified" | "split",
    estimateHeight: ReviewHeightEstimator,
  ): number {
    if (!Number.isFinite(width) || width <= 0) throw new RangeError("Review width must be positive")
    for (let file = 0; file < this.fileCount; file += 1) {
      this.setHeight(file, estimateHeight(file, this.rowCounts[file] ?? 0, width, mode))
    }
    return this.resolveAnchor(anchor)
  }

  private prefix(end: number): number {
    let sum = 0
    for (let cursor = end; cursor > 0; cursor -= cursor & -cursor) sum += this.#tree[cursor] ?? 0
    return sum
  }

  private assertFile(fileIndex: number): void {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= this.fileCount) {
      throw new RangeError("File index is outside the review")
    }
  }
}

const isVisible = (flags: number, file: number, policy: ReviewVisibilityPolicy): boolean => {
  if (policy.revealed?.[file] === 1) return true
  if (!policy.showHidden && (flags & ReviewFileFlag.Hidden) !== 0) return false
  if (!policy.showViewed && (flags & ReviewFileFlag.Viewed) !== 0) return false
  if (policy.pathMatches !== undefined && policy.pathMatches[file] !== 1) return false
  return policy.walkthrough === undefined || policy.walkthrough[file] === 1
}

const validatePolicyLength = (fileCount: number, values: Uint8Array | undefined, name: string) => {
  if (values !== undefined && values.length !== fileCount) {
    throw new RangeError(`${name} must align with the review index`)
  }
}
