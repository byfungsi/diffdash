import { Option, Schema } from "effect"

import type { DiffFileStatus } from "@diffdash/domain/diff"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  makeReviewFileId,
} from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { REVIEW_DIFF_MAX_CHUNK_BYTES, REVIEW_DIFF_MAX_LINE_BYTES } from "@diffdash/git-provider"

/** Maximum parser events in one batch returned to the worker boundary. */
export const REVIEW_DIFF_MAX_BATCH_ITEMS = 128

/** Maximum UTF-8 payload bytes in one parser batch returned to the worker boundary. */
export const REVIEW_DIFF_MAX_BATCH_BYTES = 512 * 1024

const REVIEW_DIFF_MAX_FILE_PRELUDE_BYTES = 128 * 1024
const REVIEW_DIFF_MAX_FILE_METADATA_BYTES = 128 * 1024
const REVIEW_DIFF_MAX_FILE_HUNKS = 16 * 1024

const encoder = new TextEncoder()

/** A malformed or oversized unified-diff byte stream. */
export class IncrementalDiffParseError extends Schema.TaggedError<IncrementalDiffParseError>()(
  "IncrementalDiffParseError",
  {
    reason: Schema.Literals([
      "chunkTooLarge",
      "lineTooLarge",
      "invalidUtf8",
      "parserClosed",
      "parserStateTooLarge",
    ]),
    message: Schema.String,
    limit: Schema.Number,
    actual: Schema.Number,
  },
) {}

/** Metadata retained for a closed file so v1 patch identity can be computed by bounded replay. */
export interface ClosedDiffFile {
  readonly ordinal: number
  readonly fileId: ReviewFileId
  readonly path: RepositoryRelativePath
  readonly oldPath: RepositoryRelativePath | null
  readonly status: DiffFileStatus
  readonly additions: number
  readonly deletions: number
  readonly metadata: ReadonlyArray<string>
  readonly hunkLineCounts: ReadonlyArray<number>
}

/** Incremental parser event. Hunk identity is deliberately absent until `HunkClosed`. */
export type IncrementalDiffEvent =
  | {
      readonly _tag: "FileStarted"
      readonly fileOrdinal: number
      readonly gitOldPath: string
      readonly gitNewPath: string
      readonly status: DiffFileStatus
      readonly line: string
    }
  | {
      readonly _tag: "FilePrelude"
      readonly fileOrdinal: number
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "HunkStarted"
      readonly fileOrdinal: number
      readonly hunkOrdinal: number
      readonly header: string
      readonly oldStart: number
      readonly oldLines: number
      readonly newStart: number
      readonly newLines: number
      readonly fingerprint: null
    }
  | {
      readonly _tag: "HunkLine"
      readonly fileOrdinal: number
      readonly hunkOrdinal: number
      readonly line: string
    }
  | {
      readonly _tag: "HunkClosed"
      readonly fileOrdinal: number
      readonly hunkOrdinal: number
      readonly id: ReviewHunkId
      readonly fingerprint: ReviewHunkFingerprint
      readonly lineCount: number
    }
  | { readonly _tag: "FileClosed"; readonly file: ClosedDiffFile | null }

/** One Core-facing parser batch with independently bounded item and payload counts. */
export interface IncrementalDiffBatch {
  readonly events: ReadonlyArray<IncrementalDiffEvent>
  readonly byteCount: number
}

/** Explicit success/failure result used by the synchronous parser boundary. */
export type IncrementalDiffParseResult =
  | { readonly _tag: "Success"; readonly batches: ReadonlyArray<IncrementalDiffBatch> }
  | { readonly _tag: "Failure"; readonly error: IncrementalDiffParseError }

interface DraftFile {
  readonly ordinal: number
  readonly gitOldPath: string
  readonly gitNewPath: string
  readonly startLine: string
  additions: number
  deletions: number
  hunkLineCounts: number[]
  metadata: string[]
  metadataBytes: number
  prelude: string[]
  preludeBytes: number
  preludeEmitted: boolean
  newPath: string | null
  oldPath: string | null
  renameFrom: string | null
  renameTo: string | null
  status: DiffFileStatus | null
}

interface DraftHunk {
  readonly ordinal: number
  readonly header: string
  readonly contentHash: StableReviewHash
  readonly identityHash: StableReviewHash
  lineCount: number
  normalizedLineCount: number
}

/**
 * Parses UTF-8 unified-diff chunks without retaining a review string or any finalized file's lines.
 * Callers must not publish file-scoped provisional events unless the corresponding close event is valid.
 */
export class IncrementalUnifiedDiffParser {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true })
  readonly #limits: { readonly maxChunkBytes: number; readonly maxLineBytes: number }
  #pending = ""
  #file: DraftFile | null = null
  #hunk: DraftHunk | null = null
  #nextFileOrdinal = 0
  #closed = false
  #failed = false
  #events: IncrementalDiffEvent[] = []
  #eventBytes = 0
  #batches: IncrementalDiffBatch[] = []
  #oversizedEventBytes: number | null = null

  /** Creates a parser whose caller-selected limits can only tighten SDK hard bounds. */
  constructor(limits: { readonly maxChunkBytes?: number; readonly maxLineBytes?: number } = {}) {
    this.#limits = {
      maxChunkBytes: Math.min(
        limits.maxChunkBytes ?? REVIEW_DIFF_MAX_CHUNK_BYTES,
        REVIEW_DIFF_MAX_CHUNK_BYTES,
      ),
      maxLineBytes: Math.min(
        limits.maxLineBytes ?? REVIEW_DIFF_MAX_LINE_BYTES,
        REVIEW_DIFF_MAX_LINE_BYTES,
      ),
    }
  }

  /** Accepts one source-validated byte chunk and returns zero or more bounded event batches. */
  accept(chunk: Uint8Array): IncrementalDiffParseResult {
    if (this.#closed || this.#failed) return this.#failure("parserClosed", 0, 0)
    if (chunk.byteLength === 0 || chunk.byteLength > this.#limits.maxChunkBytes)
      return this.#failure("chunkTooLarge", this.#limits.maxChunkBytes, chunk.byteLength)
    let text: string
    try {
      text = this.#decoder.decode(chunk, { stream: true })
    } catch {
      return this.#failure("invalidUtf8", 0, chunk.byteLength)
    }
    this.#pending += text
    let newline = this.#pending.indexOf("\n")
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline)
      const lineError = this.#acceptLine(line)
      if (lineError !== null) return lineError
      if (this.#oversizedEventBytes !== null) return this.#batchSizeFailure()
      this.#pending = this.#pending.slice(newline + 1)
      newline = this.#pending.indexOf("\n")
    }
    if (encoder.encode(this.#pending).byteLength > this.#limits.maxLineBytes)
      return this.#failure(
        "lineTooLarge",
        this.#limits.maxLineBytes,
        encoder.encode(this.#pending).byteLength,
      )
    return this.#oversizedEventBytes === null ? this.#drain() : this.#batchSizeFailure()
  }

  /** Flushes the final UTF-8 sequence and closes the final hunk and file. */
  finish(): IncrementalDiffParseResult {
    if (this.#closed || this.#failed) return this.#failure("parserClosed", 0, 0)
    try {
      this.#pending += this.#decoder.decode()
    } catch {
      return this.#failure("invalidUtf8", 0, 0)
    }
    if (encoder.encode(this.#pending).byteLength > this.#limits.maxLineBytes)
      return this.#failure(
        "lineTooLarge",
        this.#limits.maxLineBytes,
        encoder.encode(this.#pending).byteLength,
      )
    if (this.#pending.length > 0) {
      const lineError = this.#acceptLine(this.#pending)
      if (lineError !== null) return lineError
    }
    this.#closeFile()
    if (this.#oversizedEventBytes !== null) return this.#batchSizeFailure()
    this.#flushBatch()
    this.#closed = true
    return this.#drain()
  }

  #acceptLine(line: string): IncrementalDiffParseResult | null {
    const lineBytes = encoder.encode(line).byteLength
    if (lineBytes > this.#limits.maxLineBytes)
      return this.#failure("lineTooLarge", this.#limits.maxLineBytes, lineBytes)
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (fileMatch !== null) {
      this.#closeFile()
      const gitOldPath = fileMatch[1] ?? ""
      const gitNewPath = fileMatch[2] ?? ""
      this.#file = {
        ordinal: this.#nextFileOrdinal,
        gitOldPath,
        gitNewPath,
        startLine: line,
        additions: 0,
        deletions: 0,
        hunkLineCounts: [],
        metadata: [],
        metadataBytes: 0,
        prelude: [line],
        preludeBytes: lineBytes,
        preludeEmitted: false,
        newPath: null,
        oldPath: null,
        renameFrom: null,
        renameTo: null,
        status: null,
      }
      this.#nextFileOrdinal += 1
      return null
    }
    const file = this.#file
    if (file === null) return null
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkMatch === null && this.#hunk === null && !file.preludeEmitted) {
      const nextPreludeBytes = file.preludeBytes + lineBytes
      if (nextPreludeBytes > REVIEW_DIFF_MAX_FILE_PRELUDE_BYTES)
        return this.#failure(
          "parserStateTooLarge",
          REVIEW_DIFF_MAX_FILE_PRELUDE_BYTES,
          nextPreludeBytes,
        )
      file.prelude.push(line)
      file.preludeBytes = nextPreludeBytes
    }
    if (
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ")
    ) {
      if (file.metadataBytes + lineBytes > REVIEW_DIFF_MAX_FILE_METADATA_BYTES)
        return this.#failure(
          "parserStateTooLarge",
          REVIEW_DIFF_MAX_FILE_METADATA_BYTES,
          file.metadataBytes + lineBytes,
        )
      file.metadata.push(line)
      file.metadataBytes += lineBytes
    }
    if (line.startsWith("new file mode ")) file.status = "added"
    else if (line.startsWith("deleted file mode ")) file.status = "deleted"
    else if (line.startsWith("rename from ")) {
      file.renameFrom = line.slice("rename from ".length)
      file.status = "renamed"
    } else if (line.startsWith("rename to ")) {
      file.renameTo = line.slice("rename to ".length)
      file.status = "renamed"
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.status = "binary"
      this.#emitPrelude(file)
    } else if (line.startsWith("index ")) {
      // Binary object metadata is derived if this later proves to be a binary file.
      const rawIndex = `raw-${line}`
      const rawIndexBytes = encoder.encode(rawIndex).byteLength
      if (file.metadataBytes + rawIndexBytes > REVIEW_DIFF_MAX_FILE_METADATA_BYTES)
        return this.#failure(
          "parserStateTooLarge",
          REVIEW_DIFF_MAX_FILE_METADATA_BYTES,
          file.metadataBytes + rawIndexBytes,
        )
      file.metadata.push(rawIndex)
      file.metadataBytes += rawIndexBytes
    } else if (line.startsWith("--- ")) file.oldPath = normalizeDiffPath(line.slice(4))
    else if (line.startsWith("+++ ")) file.newPath = normalizeDiffPath(line.slice(4))

    if (hunkMatch !== null) {
      this.#closeHunk()
      this.#emitPrelude(file)
      if (file.hunkLineCounts.length >= REVIEW_DIFF_MAX_FILE_HUNKS)
        return this.#failure(
          "parserStateTooLarge",
          REVIEW_DIFF_MAX_FILE_HUNKS,
          file.hunkLineCounts.length + 1,
        )
      const hunkOrdinal = file.hunkLineCounts.length
      this.#hunk = {
        ordinal: hunkOrdinal,
        header: line,
        contentHash: new StableReviewHash(),
        identityHash: hunkIdentityHash(file, line),
        lineCount: 0,
        normalizedLineCount: 0,
      }
      this.#emit({
        _tag: "HunkStarted",
        fileOrdinal: file.ordinal,
        hunkOrdinal,
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newLines: Number(hunkMatch[4] ?? "1"),
        fingerprint: null,
      })
      return null
    }
    const hunk = this.#hunk
    if (hunk === null) return null
    hunk.lineCount += 1
    if (line !== "\\ No newline at end of file") {
      if (hunk.normalizedLineCount > 0) hunk.contentHash.update("\n")
      if (hunk.normalizedLineCount > 0) hunk.identityHash.update("\n")
      hunk.contentHash.update(line)
      hunk.identityHash.update(line)
      hunk.normalizedLineCount += 1
    }
    if (line.startsWith("+") && !line.startsWith("+++")) file.additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) file.deletions += 1
    this.#emit({ _tag: "HunkLine", fileOrdinal: file.ordinal, hunkOrdinal: hunk.ordinal, line })
    return null
  }

  #closeHunk(): void {
    const file = this.#file
    const hunk = this.#hunk
    if (file === null || hunk === null) return
    file.hunkLineCounts.push(hunk.lineCount)
    const fingerprint = ReviewHunkFingerprint.make(`hunk-content:${hunk.contentHash.digest()}`)
    const path = parsedFilePaths(file)
    if (path !== null) {
      const id = ReviewHunkId.make(`hunk:${hunk.identityHash.digest()}`)
      this.#emit({
        _tag: "HunkClosed",
        fileOrdinal: file.ordinal,
        hunkOrdinal: hunk.ordinal,
        id,
        fingerprint,
        lineCount: hunk.lineCount,
      })
    }
    this.#hunk = null
  }

  #closeFile(): void {
    const file = this.#file
    if (file === null) return
    this.#closeHunk()
    this.#emitPrelude(file)
    const paths = parsedFilePaths(file)
    const metadata = canonicalMetadata(file)
    this.#emit({
      _tag: "FileClosed",
      file:
        paths === null
          ? null
          : {
              ordinal: file.ordinal,
              fileId: makeReviewFileId(paths.path, paths.oldPath),
              path: paths.path,
              oldPath: paths.oldPath,
              status: inferStatus(file),
              additions: file.additions,
              deletions: file.deletions,
              metadata,
              hunkLineCounts: [...file.hunkLineCounts],
            },
    })
    this.#file = null
  }

  #emitPrelude(file: DraftFile): void {
    if (file.preludeEmitted) return
    file.preludeEmitted = true
    this.#emit({
      _tag: "FileStarted",
      fileOrdinal: file.ordinal,
      gitOldPath: file.gitOldPath,
      gitNewPath: file.gitNewPath,
      status: inferStatus(file),
      line: file.startLine,
    })
    this.#emit({ _tag: "FilePrelude", fileOrdinal: file.ordinal, lines: file.prelude })
    file.prelude = []
    file.preludeBytes = 0
  }

  #emit(event: IncrementalDiffEvent): void {
    const bytes = eventBytes(event)
    if (bytes > REVIEW_DIFF_MAX_BATCH_BYTES) {
      this.#oversizedEventBytes = bytes
      return
    }
    if (
      this.#events.length > 0 &&
      (this.#events.length >= REVIEW_DIFF_MAX_BATCH_ITEMS ||
        this.#eventBytes + bytes > REVIEW_DIFF_MAX_BATCH_BYTES)
    )
      this.#flushBatch()
    this.#events.push(event)
    this.#eventBytes += bytes
  }

  #flushBatch(): void {
    if (this.#events.length === 0) return
    this.#batches.push({ events: this.#events, byteCount: this.#eventBytes })
    this.#events = []
    this.#eventBytes = 0
  }

  #drain(): IncrementalDiffParseResult {
    this.#flushBatch()
    const batches = this.#batches
    this.#batches = []
    return { _tag: "Success", batches }
  }

  #failure(
    reason: IncrementalDiffParseError["reason"],
    limit: number,
    actual: number,
  ): IncrementalDiffParseResult {
    this.#failed = true
    return {
      _tag: "Failure",
      error: IncrementalDiffParseError.make({
        reason,
        message: `Incremental diff parser rejected input: ${reason}`,
        limit,
        actual,
      }),
    }
  }

  #batchSizeFailure(): IncrementalDiffParseResult {
    return this.#failure(
      "parserStateTooLarge",
      REVIEW_DIFF_MAX_BATCH_BYTES,
      this.#oversizedEventBytes ?? 0,
    )
  }
}

/** Returns the exact JSON wire-byte upper bound used for parser batch validation. */
export const eventBytes = (event: IncrementalDiffEvent): number =>
  encoder.encode(JSON.stringify(event)).byteLength

/** Rejects malformed or oversized batches before Core consumes worker output. */
export const isBoundedIncrementalDiffBatch = (batch: IncrementalDiffBatch): boolean => {
  if (batch.events.length === 0 || batch.events.length > REVIEW_DIFF_MAX_BATCH_ITEMS) return false
  const byteCount = batch.events.reduce((total, event) => total + eventBytes(event), 0)
  return byteCount === batch.byteCount && byteCount <= REVIEW_DIFF_MAX_BATCH_BYTES
}

const normalizeDiffPath = (path: string): string | null => {
  if (path === "/dev/null") return null
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2)
  return path
}

const parsedFilePaths = (
  file: DraftFile,
): {
  readonly path: RepositoryRelativePath
  readonly oldPath: RepositoryRelativePath | null
} | null => {
  const path = Option.getOrNull(
    Schema.decodeUnknownOption(RepositoryRelativePath)(
      file.renameTo ?? file.newPath ?? file.gitNewPath,
    ),
  )
  const candidate = file.renameFrom ?? deletedOldPath(file)
  const oldPath =
    candidate === null
      ? null
      : Option.getOrNull(Schema.decodeUnknownOption(RepositoryRelativePath)(candidate))
  return path === null || (candidate !== null && oldPath === null) ? null : { path, oldPath }
}

const deletedOldPath = (file: DraftFile): string | null => {
  if (file.newPath === null) return file.oldPath ?? file.gitOldPath
  if (file.oldPath !== null && file.oldPath !== file.newPath) return file.oldPath
  return null
}

const inferStatus = (file: DraftFile): DiffFileStatus => {
  if (file.status !== null) return file.status
  if (file.oldPath === null && file.newPath !== null) return "added"
  if (file.newPath === null && file.oldPath !== null) return "deleted"
  return "modified"
}

const binaryObjectMetadata = (line: string): string => {
  const index = /^index ([^.]+)\.\.([^\s]+)(?:\s+(.+))?$/.exec(line)
  return index === null ? "" : `binary-object:${/^0+$/.test(index[2] ?? "") ? index[1] : index[2]}`
}

const canonicalMetadata = (file: DraftFile): ReadonlyArray<string> => {
  const status = inferStatus(file)
  return file.metadata.flatMap((line) => {
    if (line.startsWith("raw-index "))
      return status === "binary" ? [binaryObjectMetadata(line.slice(4))] : []
    return line === "" ? [] : [line]
  })
}

const hunkIdentityHash = (file: DraftFile, header: string): StableReviewHash => {
  const hash = new StableReviewHash()
  const paths = parsedFilePaths(file)
  hash.update(paths === null ? "" : makeReviewFileId(paths.path, paths.oldPath))
  hash.update("\u0000")
  hash.update(header)
  hash.update("\u0000")
  return hash
}

class StableReviewHash {
  #hash = 0xcbf29ce484222325n

  update(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.#hash ^= BigInt(value.charCodeAt(index))
      this.#hash = BigInt.asUintN(64, this.#hash * 0x100000001b3n)
    }
  }

  digest(): string {
    return this.#hash.toString(16).padStart(16, "0")
  }
}
