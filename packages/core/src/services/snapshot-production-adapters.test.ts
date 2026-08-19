import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  makeReviewSnapshotId,
  makeReviewFileId,
  ReviewDiffIdentity,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { FileDeltaId, StoredSnapshotId } from "@diffdash/persistence/snapshot-block-store"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ProcessResult, ProcessService, processRequest } from "@diffdash/process"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Result, Stream } from "effect"

import {
  snapshotGitRangeSourceLayer,
  snapshotProjectAuthorityLayer,
} from "./snapshot-production-adapters"
import { SnapshotGitRangeSource, SnapshotProjectAuthority } from "./snapshot-repository"
import { testReviewDescriptor } from "../test-review-descriptor"

const projectId = ReviewProjectId.make("local:production-adapter")
const unusedRepositoryOperation = () => Effect.die("Repository operation is unused")

describe("snapshot production adapters", () => {
  it.effect("authorizes the acquisition project and regenerates bounded exact-Git blocks", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "diffdash-snapshot-adapter-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const processes = yield* ProcessService
      const runGit = (args: readonly string[]) =>
        processes.run(processRequest("git", ["-C", directory, ...args]))

      yield* runGit(["init", "-q"])
      yield* runGit(["config", "user.name", "DiffDash Test"])
      yield* runGit(["config", "user.email", "diffdash@example.invalid"])
      yield* Effect.promise(() => writeFile(join(directory, "file.ts"), "old\n"))
      yield* runGit(["add", "file.ts"])
      yield* runGit(["commit", "-qm", "base"])
      const baseObject = (yield* runGit(["rev-parse", "HEAD"])).stdout.trim()
      yield* Effect.promise(() => writeFile(join(directory, "file.ts"), "new\n"))
      yield* runGit(["commit", "-qam", "head"])
      const headObject = (yield* runGit(["rev-parse", "HEAD"])).stdout.trim()
      const rawDiff = (yield* runGit(["diff", baseObject, headObject, "--", "file.ts"])).stdout
      const parsedDiff = parseUnifiedDiff(rawDiff)
      const reviewKey = ReviewKey.make("local:production-adapter")
      const baseRevision = ReviewRevision.make(baseObject)
      const headRevision = ReviewRevision.make(headObject)
      const diffIdentity = ReviewDiffIdentity.make(
        createHash("sha256").update(rawDiff).digest("hex"),
      )
      const snapshotId = makeReviewSnapshotId({
        reviewKey,
        baseRevision,
        headRevision,
        diffIdentity,
      })
      const commonDirectory = (yield* runGit([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])).stdout.trim()
      const stored = {
        id: StoredSnapshotId.make(snapshotId),
        projectId,
        reviewKey,
        baseRevision,
        headRevision,
        semanticIdentity: diffIdentity,
        descriptor: testReviewDescriptor,
        source: {
          kind: "exactGit" as const,
          repositoryIdentity: createHash("sha256").update(commonDirectory).digest("hex"),
          baseObject,
          headObject,
          diffPolicyIdentity: "local-git-unified-v1",
        },
        createdAtMs: 1,
      }
      const file = parsedDiff.files[0]
      if (file === undefined) throw new Error("Expected one changed file")
      const placement = {
        ordinal: 0,
        deltaId: FileDeltaId.make("delta:test"),
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
        visibility: file.visibility,
        patchHash: ReviewFilePatchHash.make(file.patchHash),
        hunkCount: file.hunks.length,
      }

      yield* Effect.gen(function* () {
        const authority = yield* SnapshotProjectAuthority
        const git = yield* SnapshotGitRangeSource
        expect(yield* authority.contains(projectId, stored)).toBe(true)
        const generateFileBlocks = requireStreamingSource(git)
        const blocks = yield* generateFileBlocks({
          snapshot: stored,
          file: placement,
          maximumBlockBytes: 512 * 1_024,
        }).pipe(Stream.runCollect)
        expect(blocks).toHaveLength(1)
        expect(new TextDecoder().decode(blocks[0]?.bytes)).toContain("-old\n+new\n")
        expect(blocks[0]?.bytes.byteLength).toBeLessThanOrEqual(512 * 1_024)
      }).pipe(Effect.provide(makeLayer(directory)))
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.effect("streams a file larger than the aggregate lazy reservation", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "diffdash-snapshot-large-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const groups = 55
      const changedLines = 4_000
      const base: string[] = []
      const head: string[] = []
      for (let group = 0; group < groups; group += 1) {
        for (let line = 0; line < changedLines; line += 1) {
          base.push(`old-${group}-${line}-${"x".repeat(28)}`)
          head.push(`new-${group}-${line}-${"y".repeat(28)}`)
        }
        for (let line = 0; line < 10; line += 1) {
          const unchanged = `gap-${group}-${line}`
          base.push(unchanged)
          head.push(unchanged)
        }
      }
      const fixture = yield* initializeGit(
        directory,
        `${base.join("\n")}\n`,
        `${head.join("\n")}\n`,
      )
      const placement = makePlacement(groups, groups * changedLines, groups * changedLines)
      const stored = makeStored(fixture)

      yield* Effect.gen(function* () {
        const git = yield* SnapshotGitRangeSource
        const generate = requireStreamingSource(git)
        const summary = yield* generate({
          snapshot: stored,
          file: placement,
          maximumBlockBytes: 512 * 1_024,
        }).pipe(
          Stream.runFold(
            () => ({ blocks: 0, bytes: 0 }),
            (total, block) => ({
              blocks: total.blocks + 1,
              bytes: total.bytes + block.bytes.byteLength,
            }),
          ),
        )
        expect(summary.blocks).toBe(groups)
        expect(summary.bytes).toBeGreaterThan(16 * 1_024 * 1_024)
      }).pipe(Effect.provide(makeLayer(directory)))
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.effect("returns a typed failure for an enormous hunk", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "diffdash-snapshot-hunk-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const lineCount = 9_000
      const fixture = yield* initializeGit(
        directory,
        `${Array.from({ length: lineCount }, (_, line) => `old-${line}-${"x".repeat(30)}`).join("\n")}\n`,
        `${Array.from({ length: lineCount }, (_, line) => `new-${line}-${"y".repeat(30)}`).join("\n")}\n`,
      )

      yield* Effect.gen(function* () {
        const git = yield* SnapshotGitRangeSource
        const generate = requireStreamingSource(git)
        const result = yield* generate({
          snapshot: makeStored(fixture),
          file: makePlacement(1, lineCount, lineCount),
          maximumBlockBytes: 512 * 1_024,
        }).pipe(Stream.runDrain, Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: "SnapshotRepositorySourceError" })
        }
      }).pipe(Effect.provide(makeLayer(directory)))
    }).pipe(Effect.provide(ProcessService.layer)),
  )

  it.effect("finalizes the process stream when regeneration is cancelled", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const finalized = yield* Ref.make(false)
      const directory = "/tmp/diffdash-cancelled-source"
      const fixture = {
        baseObject: "base",
        headObject: "head",
        commonDirectory: directory,
      }
      const bytes = new TextEncoder().encode("diff --git a/file.ts b/file.ts\n")
      const processes = ProcessService.of({
        run: () =>
          Effect.succeed(
            ProcessResult.make({
              command: "git",
              args: [],
              cwd: null,
              stdout: directory,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              outputTruncated: false,
              exitCode: 0,
              signal: null,
            }),
          ),
        streamLines: () => Stream.empty,
        streamBytes: () =>
          Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
            Stream.flatMap(() => Stream.make({ _tag: "ProcessByteChunk" as const, bytes })),
            Stream.concat(Stream.never),
            Stream.ensuring(Ref.set(finalized, true)),
          ),
      })
      const layer = makeLayer(directory).pipe(
        Layer.provide(Layer.succeed(ProcessService, processes)),
      )

      yield* Effect.gen(function* () {
        const git = yield* SnapshotGitRangeSource
        const generate = requireStreamingSource(git)
        const fiber = yield* generate({
          snapshot: makeStored(fixture),
          file: makePlacement(0, 0, 0),
          maximumBlockBytes: 512 * 1_024,
        }).pipe(Stream.runDrain, Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(yield* Ref.get(finalized)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("does not depend on complete unified-diff parsing in production", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        readFile(new URL("snapshot-production-adapters.ts", import.meta.url), "utf8"),
      )
      expect(source).not.toContain("parseUnifiedDiff")
      expect(source).not.toContain("SNAPSHOT_GIT_MAX_FILE_BYTES")
    }),
  )
})

const initializeGit = Effect.fn("SnapshotProductionAdaptersTest.initializeGit")(function* (
  directory: string,
  baseContent: string,
  headContent: string,
) {
  const processes = yield* ProcessService
  const runGit = (args: readonly string[]) =>
    processes.run(processRequest("git", ["-C", directory, ...args]))
  yield* runGit(["init", "-q"])
  yield* runGit(["config", "user.name", "DiffDash Test"])
  yield* runGit(["config", "user.email", "diffdash@example.invalid"])
  yield* Effect.promise(() => writeFile(join(directory, "file.ts"), baseContent))
  yield* runGit(["add", "file.ts"])
  yield* runGit(["commit", "-qm", "base"])
  const baseObject = (yield* runGit(["rev-parse", "HEAD"])).stdout.trim()
  yield* Effect.promise(() => writeFile(join(directory, "file.ts"), headContent))
  yield* runGit(["commit", "-qam", "head"])
  const headObject = (yield* runGit(["rev-parse", "HEAD"])).stdout.trim()
  const commonDirectory = (yield* runGit([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).stdout.trim()
  return { baseObject, headObject, commonDirectory }
})

const makeStored = (fixture: {
  readonly baseObject: string
  readonly headObject: string
  readonly commonDirectory: string
}) => {
  const reviewKey = ReviewKey.make("local:production-adapter")
  const baseRevision = ReviewRevision.make(fixture.baseObject)
  const headRevision = ReviewRevision.make(fixture.headObject)
  const diffIdentity = ReviewDiffIdentity.make("streaming-exact-git")
  return {
    id: StoredSnapshotId.make(
      makeReviewSnapshotId({ reviewKey, baseRevision, headRevision, diffIdentity }),
    ),
    projectId,
    reviewKey,
    baseRevision,
    headRevision,
    semanticIdentity: diffIdentity,
    descriptor: testReviewDescriptor,
    source: {
      kind: "exactGit" as const,
      repositoryIdentity: createHash("sha256").update(fixture.commonDirectory).digest("hex"),
      baseObject: fixture.baseObject,
      headObject: fixture.headObject,
      diffPolicyIdentity: "local-git-unified-v1",
    },
    createdAtMs: 1,
  }
}

const makePlacement = (hunkCount: number, additions: number, deletions: number) => ({
  ordinal: 0,
  deltaId: FileDeltaId.make("delta:test"),
  fileId: makeReviewFileId(RepositoryRelativePath.make("file.ts"), null),
  path: "file.ts",
  oldPath: null,
  additions,
  deletions,
  status: "modified" as const,
  visibility: { _tag: "Visible" as const },
  patchHash: ReviewFilePatchHash.make("streaming-patch"),
  hunkCount,
})

const requireStreamingSource = (source: SnapshotGitRangeSource["Service"]) => {
  if (source.generateFileBlocks === undefined)
    throw new Error("Expected streaming exact-Git source")
  return source.generateFileBlocks
}

const makeLayer = (directory: string) => {
  const repository = Repo.make({
    id: projectId,
    source: LocalRepositorySource.make(),
    checkout: LinkedCheckout.make({
      path: RepositoryCheckoutPath.make(directory),
      remoteUrl: `file://${directory}`,
    }),
    isFavorite: false,
    lastOpenedAt: null,
    lastSyncedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  })
  const repositories = RepositoryStore.of({
    getById: () => Effect.succeed(repository),
    list: () => Effect.succeed([repository]),
    findByLocalPath: () => Effect.succeed(Option.some(repository)),
    findHosted: () => Effect.succeed(Option.none()),
    findByProviderRepositoryId: () => Effect.succeed(Option.none()),
    attachResolvedIdentity: unusedRepositoryOperation,
    reconcileLocalAliases: unusedRepositoryOperation,
    repairLocalAliases: unusedRepositoryOperation,
    setIdentityRepairStatus: unusedRepositoryOperation,
    upsertRepository: unusedRepositoryOperation,
    setFavorite: unusedRepositoryOperation,
    touch: unusedRepositoryOperation,
    forget: unusedRepositoryOperation,
  })
  return Layer.merge(snapshotProjectAuthorityLayer, snapshotGitRangeSourceLayer).pipe(
    Layer.provide(Layer.succeed(RepositoryStore, repositories)),
  )
}
