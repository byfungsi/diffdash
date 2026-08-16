import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import {
  makeReviewSnapshotId,
  ReviewDiffIdentity,
  ReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { FileDeltaId, StoredSnapshotId } from "@diffdash/persistence/snapshot-block-store"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { ProcessService, processRequest } from "@diffdash/process"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"

import {
  SNAPSHOT_GIT_MAX_FILE_BYTES,
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
      if (file === undefined) return yield* Effect.die("Expected one changed file")
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
        const blocks = yield* git.generateFile({
          snapshot: stored,
          file: placement,
          maximumBlockBytes: 512 * 1_024,
        })
        expect(blocks).toHaveLength(1)
        expect(new TextDecoder().decode(blocks[0]?.bytes)).toContain("-old\n+new\n")
        expect(blocks[0]?.bytes.byteLength).toBeLessThanOrEqual(512 * 1_024)
        expect(SNAPSHOT_GIT_MAX_FILE_BYTES).toBe(16 * 1_024 * 1_024)
      }).pipe(Effect.provide(makeLayer(directory)))
    }).pipe(Effect.provide(ProcessService.layer)),
  )
})

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
