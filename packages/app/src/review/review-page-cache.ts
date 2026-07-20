import { ParsedDiffFile } from "@diffdash/domain/diff"
import { jsonSafeUtf8ByteLength } from "@diffdash/protocol/payload-budget"
import { Schema } from "effect"

/** Explicit renderer memory bounds for parsed diff pages. */
const DEFAULT_REVIEW_PAGE_CACHE_CONFIG = {
  maxBytes: 8 * 1_024 * 1_024,
  maxFiles: 32,
} as const

/** Renderer parsed-file cache bounds. */
interface ReviewPageCacheConfig {
  readonly maxBytes: number
  readonly maxFiles: number
}

interface CachedReviewFile {
  readonly bytes: number
  readonly file: ParsedDiffFile
}

/** Bounded LRU cache for complete parsed files loaded from snapshot page IPC. */
export class ReviewPageCache {
  readonly #config: ReviewPageCacheConfig
  readonly #entries = new Map<string, CachedReviewFile>()
  #bytes = 0

  constructor(config: ReviewPageCacheConfig = DEFAULT_REVIEW_PAGE_CACHE_CONFIG) {
    if (
      !Number.isSafeInteger(config.maxBytes) ||
      config.maxBytes <= 0 ||
      !Number.isSafeInteger(config.maxFiles) ||
      config.maxFiles <= 0
    ) {
      throw new Error("Review page cache bounds must be positive safe integers")
    }
    this.#config = config
  }

  /** Clears every cached parsed file. */
  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }

  /** Returns one parsed file while promoting it to most recently used. */
  get(fileId: string): ParsedDiffFile | null {
    const entry = this.#entries.get(fileId)
    if (entry === undefined) return null
    this.#entries.delete(fileId)
    this.#entries.set(fileId, entry)
    return entry.file
  }

  /** Adds complete parsed files and evicts least-recent entries under both bounds. */
  put(files: readonly ParsedDiffFile[], pinnedFileIds: ReadonlySet<string> = new Set()): void {
    for (const file of files) {
      const encoded = Schema.encodeSync(ParsedDiffFile)(file)
      const bytes = jsonSafeUtf8ByteLength(encoded)
      if (bytes > this.#config.maxBytes) continue
      const previous = this.#entries.get(file.fileId)
      if (previous !== undefined) {
        this.#entries.delete(file.fileId)
        this.#bytes -= previous.bytes
      }
      this.#entries.set(file.fileId, { bytes, file })
      this.#bytes += bytes
    }

    while (this.#entries.size > this.#config.maxFiles || this.#bytes > this.#config.maxBytes) {
      const evicted = [...this.#entries].find(([fileId]) => !pinnedFileIds.has(fileId))
      const fallback = this.#entries.entries().next().value
      const candidate = evicted ?? fallback
      if (candidate === undefined) break
      this.#entries.delete(candidate[0])
      this.#bytes -= candidate[1].bytes
    }
  }

  /** Returns cached files in current LRU order. */
  files(): readonly ParsedDiffFile[] {
    return [...this.#entries.values()].map(({ file }) => file)
  }

  /** Returns current cache utilization for tests and diagnostics. */
  stats(): { readonly bytes: number; readonly files: number } {
    return { bytes: this.#bytes, files: this.#entries.size }
  }
}
