import { ReviewFilePatchHash, ReviewHunkId } from "@diffdash/domain/review-identity"
import { Match } from "effect"

import type { ClosedDiffFile, IncrementalDiffEvent } from "./incremental-diff-parser"

/** Final v1 identities produced while replaying one closed file's bounded parser events. */
export interface ReplayedV1Identities {
  readonly patchHash: ReviewFilePatchHash
  readonly hunkIds: ReadonlyArray<ReviewHunkId>
}

/**
 * Reproduces existing v1 file and hunk identities from a bounded second pass over staged bytes.
 * The caller supplies one closed file's events in order; this function retains only hash state.
 */
export const replayV1Identities = (
  file: ClosedDiffFile,
  events: Iterable<IncrementalDiffEvent>,
): ReplayedV1Identities => {
  const patch = new StablePatchHash()
  patch.part(file.status)
  patch.part(file.oldPath ?? "")
  patch.part(file.path)
  for (const metadata of file.metadata) patch.part(metadata)
  patch.part(String(file.hunkLineCounts.length))
  const hunkIds: ReviewHunkId[] = []
  let hunkOrdinal = -1
  let hunkHash: StableReviewHash | null = null
  for (const event of events) {
    Match.value(event).pipe(
      Match.tag("HunkStarted", (started) => {
        if (started.fileOrdinal !== file.ordinal) return
        hunkOrdinal = started.hunkOrdinal
        patch.part(normalizedHunkHeader(started.header))
        patch.part(String(file.hunkLineCounts[hunkOrdinal] ?? 0))
        hunkHash = new StableReviewHash()
        hunkHash.part(file.fileId)
        hunkHash.part(started.header)
      }),
      Match.tag("HunkLine", (line) => {
        if (line.fileOrdinal !== file.ordinal) return
        patch.part(line.line)
        if (line.line !== "\\ No newline at end of file") hunkHash?.content(line.line)
      }),
      Match.tag("HunkClosed", (closed) => {
        if (closed.fileOrdinal !== file.ordinal || hunkHash === null) return
        hunkHash.finishContent()
        hunkIds.push(ReviewHunkId.make(`hunk:${hunkHash.digest()}`))
        hunkHash = null
      }),
      Match.orElse(() => undefined),
    )
  }
  return {
    patchHash: ReviewFilePatchHash.make(`file-patch:v1:${patch.digest()}`),
    hunkIds,
  }
}

const normalizedHunkHeader = (header: string): string =>
  header.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@ @@")

class StableReviewHash {
  #hash = 0xcbf29ce484222325n
  #parts = 0
  #contentLines = 0

  part(value: string): void {
    if (this.#parts > 0) this.#update("\u0000")
    this.#update(value)
    this.#parts += 1
  }

  content(value: string): void {
    if (this.#contentLines === 0 && this.#parts > 0) this.#update("\u0000")
    else if (this.#contentLines > 0) this.#update("\n")
    this.#update(value)
    this.#contentLines += 1
  }

  finishContent(): void {
    if (this.#contentLines === 0 && this.#parts > 0) this.#update("\u0000")
  }

  digest(): string {
    return this.#hash.toString(16).padStart(16, "0")
  }

  #update(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.#hash ^= BigInt(value.charCodeAt(index))
      this.#hash = BigInt.asUintN(64, this.#hash * 0x100000001b3n)
    }
  }
}

class StablePatchHash {
  #first = 1_779_033_703
  #second = 3_144_134_277
  #third = 1_013_904_242
  #fourth = 2_773_480_762
  #parts = 0

  part(value: string): void {
    if (this.#parts > 0) this.#update(0)
    for (let index = 0; index < value.length; index += 1) this.#update(value.charCodeAt(index))
    this.#parts += 1
  }

  digest(): string {
    let first = Math.imul(this.#third ^ (this.#first >>> 18), 597_399_067)
    let second = Math.imul(this.#fourth ^ (this.#second >>> 22), 2_869_860_233)
    let third = Math.imul(first ^ (this.#third >>> 17), 951_274_213)
    let fourth = Math.imul(second ^ (this.#fourth >>> 19), 2_716_044_179)
    first ^= second ^ third ^ fourth
    second ^= first
    third ^= first
    fourth ^= first
    return [first, second, third, fourth]
      .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
      .join("")
  }

  #update(code: number): void {
    const first = this.#second ^ Math.imul(this.#first ^ code, 597_399_067)
    const second = this.#third ^ Math.imul(this.#second ^ code, 2_869_860_233)
    const third = this.#fourth ^ Math.imul(this.#third ^ code, 951_274_213)
    const fourth = first ^ Math.imul(this.#fourth ^ code, 2_716_044_179)
    this.#first = first
    this.#second = second
    this.#third = third
    this.#fourth = fourth
  }
}
