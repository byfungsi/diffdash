import { createHash } from "node:crypto"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import type {
  SnapshotFilePlacement,
  StoredSnapshotHeader,
} from "@diffdash/persistence/snapshot-block-store"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ProcessService, processRequest } from "@diffdash/process"
import { Effect, Layer } from "effect"

import {
  type LazySnapshotBlock,
  SnapshotGitRangeSource,
  SnapshotProjectAuthority,
  SnapshotRepositorySourceError,
} from "./snapshot-repository"

/** Maximum exact-Git output retained while regenerating one collected file. */
export const SNAPSHOT_GIT_MAX_FILE_BYTES = 16 * 1_024 * 1_024

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
      generateFile: Effect.fn("SnapshotGitRangeSource.generateFile")(function* (input) {
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
    const result = yield* processes
      .run(
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
          SNAPSHOT_GIT_MAX_FILE_BYTES,
        ),
      )
      .pipe(Effect.mapError(() => sourceFailure("Git could not regenerate the snapshot file")))
    const parsed = parseUnifiedDiff(result.stdout).files.find(
      (candidate) => candidate.fileId === file.fileId,
    )
    if (parsed === undefined)
      return yield* sourceFailure("Git did not regenerate the expected snapshot file")

    let firstLine = 0
    const blocks: LazySnapshotBlock[] = []
    for (const [ordinal, hunk] of parsed.hunks.entries()) {
      const bytes = new TextEncoder().encode(
        `${hunk.header}\n${hunk.lines.map((line) => `${line}\n`).join("")}`,
      )
      if (bytes.byteLength === 0 || bytes.byteLength > maximumBlockBytes) {
        return yield* sourceFailure("Regenerated Git hunk exceeds the snapshot block limit")
      }
      blocks.push({
        hunkId: hunk.id,
        ordinal,
        firstLine,
        lineCount: hunk.lines.length,
        bytes,
      })
      firstLine += hunk.lines.length
    }
    return blocks
  },
)

const gitRequest = (args: readonly string[], maximumStdoutBytes = 4 * 1_024) =>
  processRequest("git", args, {
    timeoutMs: 60_000,
    unsetEnv: REPOSITORY_SCOPED_GIT_ENV,
    stdout: { maxBytes: maximumStdoutBytes, overflow: "error" },
    stderr: { maxBytes: 64 * 1_024, overflow: "truncate" },
  })

const sourceFailure = (message: string): SnapshotRepositorySourceError =>
  SnapshotRepositorySourceError.make({ message })
