import { createHash } from "node:crypto"

import { makeReviewHunkId, ReviewFileId } from "@diffdash/domain/review-identity"
import type {
  SnapshotFilePlacement,
  StoredSnapshotHeader,
} from "@diffdash/persistence/snapshot-block-store"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ProcessService, processRequest } from "@diffdash/process"
import { Effect, Layer, Match, Stream } from "effect"

import {
  type LazySnapshotBlock,
  SnapshotGitRangeSource,
  SnapshotProjectAuthority,
  SnapshotRepositorySourceError,
} from "./snapshot-repository"

const SNAPSHOT_GIT_STREAM_CHUNK_BYTES = 64 * 1_024
const SNAPSHOT_GIT_STREAM_BUFFER_BYTES = 256 * 1_024

const REPOSITORY_SCOPED_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const

/** Authorizes persisted manifests against the project association established during acquisition. */
export const snapshotProjectAuthorityLayer = Layer.effect(
  SnapshotProjectAuthority,
  Effect.succeed(
    SnapshotProjectAuthority.of({
      contains: (projectId, stored) => Effect.succeed(stored.projectId === projectId),
    }),
  ),
)

/** Regenerates collected blocks from exact Git objects in the snapshot project's linked checkout. */
export const snapshotGitRangeSourceLayer = Layer.effect(
  SnapshotGitRangeSource,
  Effect.gen(function* () {
    const repositories = yield* RepositoryStore
    const processes = yield* ProcessService

    return SnapshotGitRangeSource.of({
      generateFileBlocks: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (input.snapshot.source.kind !== "exactGit") {
              return yield* sourceFailure("Snapshot does not retain exact Git objects")
            }
            const repository = yield* repositories
              .getById(input.snapshot.projectId)
              .pipe(Effect.mapError(() => sourceFailure("Snapshot repository is unavailable")))
            if (repository.localPath === null) {
              return yield* sourceFailure("Snapshot repository has no linked checkout")
            }
            return yield* generateFromRepository(
              processes,
              repository.localPath,
              input.snapshot,
              input.file,
              input.maximumBlockBytes,
            )
          }),
        ),
    })
  }),
)

const generateFromRepository = Effect.fn("SnapshotGitRangeSource.generateFromRepository")(
  function* (
    processes: ProcessService["Service"],
    repositoryPath: string,
    snapshot: StoredSnapshotHeader,
    file: SnapshotFilePlacement,
    maximumBlockBytes: number,
  ) {
    if (snapshot.source.kind !== "exactGit") {
      return yield* sourceFailure("Snapshot does not retain exact Git objects")
    }
    const commonDirectory = yield* processes
      .run(
        gitRequest([
          "-C",
          repositoryPath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      )
      .pipe(Effect.mapError(() => sourceFailure("Git repository identity is unavailable")))
    const repositoryIdentity = createHash("sha256")
      .update(commonDirectory.stdout.trim())
      .digest("hex")
    if (repositoryIdentity !== snapshot.source.repositoryIdentity) {
      return yield* sourceFailure("Git repository identity does not match the snapshot source")
    }

    const paths =
      file.oldPath === null || file.oldPath === file.path ? [file.path] : [file.oldPath, file.path]
    const chunkBytes = Math.min(SNAPSHOT_GIT_STREAM_CHUNK_BYTES, maximumBlockBytes)
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0)
      return yield* sourceFailure("Snapshot block limit is invalid")
    const parser = new ExactGitBlockParser(file, maximumBlockBytes)
    return processes
      .streamBytes(
        gitRequest(
          [
            "-C",
            repositoryPath,
            "diff",
            "--no-ext-diff",
            "--no-color",
            snapshot.source.baseObject,
            snapshot.source.headObject,
            "--",
            ...paths,
          ],
          0,
          {
            maxByteChunkBytes: chunkBytes,
            maxBufferedBytes: Math.max(
              chunkBytes,
              Math.min(SNAPSHOT_GIT_STREAM_BUFFER_BYTES, maximumBlockBytes),
            ),
            maxReservedBytes: chunkBytes,
          },
        ),
      )
      .pipe(
        Stream.mapError(() => sourceFailure("Git could not regenerate the snapshot file")),
        Stream.mapEffect((event) =>
          Effect.try({
            try: () =>
              Match.value(event).pipe(
                Match.tag("ProcessByteChunk", ({ bytes }) => parser.write(bytes)),
                Match.tag("ProcessExit", () => parser.finish()),
                Match.exhaustive,
              ),
            catch: () => sourceFailure("Git produced invalid or oversized snapshot output"),
          }),
        ),
        Stream.flatMap((blocks) => Stream.fromIterable(blocks)),
      )
  },
)

interface GitStreamOptions {
  readonly maxByteChunkBytes: number
  readonly maxBufferedBytes: number
  readonly maxReservedBytes: number
}

const gitRequest = (
  args: readonly string[],
  maximumStdoutBytes = 4 * 1_024,
  stream: GitStreamOptions | undefined = undefined,
) =>
  processRequest("git", args, {
    timeoutMs: 60_000,
    unsetEnv: REPOSITORY_SCOPED_GIT_ENV,
    stdout: {
      maxBytes: maximumStdoutBytes,
      overflow: stream === undefined ? "error" : "truncate",
    },
    stderr: { maxBytes: 64 * 1_024, overflow: "truncate" },
    ...stream,
  })

class ExactGitBlockParser {
  readonly #decoder = new TextDecoder()
  readonly #encoder = new TextEncoder()
  readonly #lineParts: Uint8Array[] = []
  #lineBytes = 0
  #fileSeen = false
  #status: SnapshotFilePlacement["status"] = "modified"
  #hunkHeader: string | null = null
  #hunkLines: string[] = []
  #hunkByteCount = 0
  #ordinal = 0
  #firstLine = 0
  #additions = 0
  #deletions = 0

  constructor(
    readonly file: SnapshotFilePlacement,
    readonly maximumBlockBytes: number,
  ) {}

  write(chunk: Uint8Array): ReadonlyArray<LazySnapshotBlock> {
    const blocks: LazySnapshotBlock[] = []
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue
      this.#appendLinePart(chunk.subarray(start, index))
      blocks.push(...this.#acceptLine(this.#takeLine()))
      start = index + 1
    }
    if (start < chunk.length) this.#appendLinePart(chunk.subarray(start))
    return blocks
  }

  finish(): ReadonlyArray<LazySnapshotBlock> {
    const blocks = this.#acceptLine(this.#takeLine())
    const final = this.#finishHunk()
    if (final !== null) blocks.push(final)
    if (
      !this.#fileSeen ||
      this.#status !== this.file.status ||
      this.#ordinal !== this.file.hunkCount ||
      this.#additions !== this.file.additions ||
      this.#deletions !== this.file.deletions
    ) {
      throw sourceFailure("Git did not regenerate the expected snapshot file")
    }
    return blocks
  }

  #appendLinePart(part: Uint8Array): void {
    if (part.length > this.maximumBlockBytes - this.#lineBytes)
      throw sourceFailure("Regenerated Git line exceeds the snapshot block limit")
    this.#lineParts.push(part.slice())
    this.#lineBytes += part.length
  }

  #takeLine(): string {
    const bytes = new Uint8Array(this.#lineBytes)
    let offset = 0
    for (const part of this.#lineParts) {
      bytes.set(part, offset)
      offset += part.length
    }
    this.#lineParts.length = 0
    this.#lineBytes = 0
    return this.#decoder.decode(bytes)
  }

  #acceptLine(line: string): LazySnapshotBlock[] {
    const expectedHeader = `diff --git a/${this.file.oldPath ?? this.file.path} b/${this.file.path}`
    if (line.startsWith("diff --git ")) {
      if (this.#fileSeen || line !== expectedHeader)
        throw sourceFailure("Git regenerated a different snapshot file")
      this.#fileSeen = true
      return []
    }
    if (!this.#fileSeen) return []

    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      const previous = this.#finishHunk()
      this.#hunkHeader = line
      this.#hunkByteCount = this.#encodedLineBytes(line)
      return previous === null ? [] : [previous]
    }
    if (this.#hunkHeader !== null) {
      const lineBytes = this.#encodedLineBytes(line)
      if (lineBytes > this.maximumBlockBytes - this.#hunkByteCount)
        throw sourceFailure("Regenerated Git hunk exceeds the snapshot block limit")
      this.#hunkLines.push(line)
      this.#hunkByteCount += lineBytes
      if (line.startsWith("+") && !line.startsWith("+++")) this.#additions += 1
      if (line.startsWith("-") && !line.startsWith("---")) this.#deletions += 1
      return []
    }

    if (line.startsWith("new file mode ")) this.#status = "added"
    else if (line.startsWith("deleted file mode ")) this.#status = "deleted"
    else if (line.startsWith("rename from ") || line.startsWith("rename to "))
      this.#status = "renamed"
    else if (line.startsWith("Binary files ")) this.#status = "binary"
    return []
  }

  #finishHunk(): LazySnapshotBlock | null {
    if (this.#hunkHeader === null) return null
    const header = this.#hunkHeader
    const lines = this.#hunkLines
    const bytes = this.#encoder.encode(`${header}\n${lines.map((line) => `${line}\n`).join("")}`)
    const block = {
      hunkId: makeReviewHunkId(ReviewFileId.make(this.file.fileId), header, lines),
      ordinal: this.#ordinal,
      firstLine: this.#firstLine,
      lineCount: lines.length,
      bytes,
    }
    this.#ordinal += 1
    this.#firstLine += lines.length
    this.#hunkHeader = null
    this.#hunkLines = []
    this.#hunkByteCount = 0
    return block
  }

  #encodedLineBytes(line: string): number {
    return this.#encoder.encode(line).length + 1
  }
}

const sourceFailure = (message: string): SnapshotRepositorySourceError =>
  SnapshotRepositorySourceError.make({ message })
