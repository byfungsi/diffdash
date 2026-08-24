import { describe, expect, it } from "@effect/vitest"
import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import {
  CodeWorkspaceFileContent,
  CodeWorkspaceFileReadResult,
  LocalReviewSnapshotCodeWorkspaceTarget,
  ProjectHeadCodeWorkspaceTarget,
  ProjectRevisionCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import {
  LastCommitComparison,
  LocalReviewTarget,
  WorkingTreeComparison,
} from "@diffdash/domain/local-review"
import { LocalReviewDescriptor } from "@diffdash/domain/review-context"
import {
  LanguageAdapterId,
  LanguageId,
  LanguageOperationError,
  LanguagePosition,
  RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { ManagedWorkspaceFiles } from "@diffdash/local-git/managed-workspace-files"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import {
  SnapshotBlockStore,
  SnapshotBlockStoreError,
  SnapshotStorageSource,
  StoredSnapshotId,
} from "@diffdash/persistence/snapshot-block-store"
import { CatalogResourceId, ResourceCatalog } from "@diffdash/persistence/resource-catalog"
import { LanguageAdapterRegistry } from "@diffdash/language-provider/registry"
import {
  LanguageAdapterCapabilities,
  LanguageAdapterDescriptor,
  type LanguageAdapterRegistration,
} from "@diffdash/language-provider"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Result } from "effect"
import { TestClock } from "effect/testing"

import { AgentWorkspaceResources } from "../agent-workspace-resources"
import { ResourceCollection } from "../resource-collection"
import { CodeWorkspaceService } from "./code-workspace"
import { CodeWorkspaceSnapshotSource } from "./code-workspace-snapshot"
import { GitProvider } from "./git-provider"
import { GitService, LocalGitWorkingTreeChange } from "@diffdash/local-git/local-git"

const projectId = ReviewProjectId.make("code-workspace-project")
const revision = GitCommitSha.make("a".repeat(40))
const workspacePath = RepositoryCheckoutPath.make("/managed/revision-workspace")
const owner = {
  applicationInstanceId: ApplicationInstanceId.make("application"),
  processEpoch: CoreProcessEpoch.make("epoch"),
}

const repository = Repo.make({
  id: projectId,
  source: LocalRepositorySource.make(),
  checkout: LinkedCheckout.make({
    path: RepositoryCheckoutPath.make("/source"),
    remoteUrl: "file:///source",
  }),
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
})

const unusedSnapshotLayer = Layer.mock(CodeWorkspaceSnapshotSource, {})

const layer = CodeWorkspaceService.layer.pipe(
  Layer.provide(Layer.mock(RepositoryStore, { getById: () => Effect.succeed(repository) })),
  Layer.provide(Layer.mock(GitProvider, {})),
  Layer.provide(Layer.mock(GitService, {})),
  Layer.provide(
    Layer.mock(HostedReviewWorkspacePool, {
      useRevision: (_input, use) => use(workspacePath),
    }),
  ),
  Layer.provide(Layer.mock(AgentWorkspaceResources, { protect: (_input, use) => use })),
  Layer.provide(
    Layer.mock(ManagedWorkspaceFiles, {
      indexFiles: () =>
        Effect.succeed([
          RepositoryRelativePath.make("src/a.ts"),
          RepositoryRelativePath.make("src/b.ts"),
          RepositoryRelativePath.make("src/c.ts"),
        ]),
    }),
  ),
  Layer.provide(Layer.mock(LocalCheckoutFiles, {})),
  Layer.provide(Layer.mock(ResourceCollection, { collectPolicy: () => Effect.succeed(0) })),
  Layer.provide(LanguageAdapterRegistry.layer([])),
  Layer.provide(unusedSnapshotLayer),
)

describe("CodeWorkspaceService", () => {
  it.effect(
    "uses the linked checkout for project-head files and changes without materializing a copy",
    () =>
      Effect.gen(function* () {
        const statusPath = yield* Ref.make(Option.none<RepositoryCheckoutPath>())
        const lineChangePath = yield* Ref.make(Option.none<RepositoryCheckoutPath>())
        const indexedPath = yield* Ref.make(Option.none<RepositoryCheckoutPath>())
        const readPath = yield* Ref.make(Option.none<RepositoryCheckoutPath>())
        const changesLayer = CodeWorkspaceService.layer.pipe(
          Layer.provide(Layer.mock(RepositoryStore, { getById: () => Effect.succeed(repository) })),
          Layer.provide(Layer.mock(GitProvider, {})),
          Layer.provide(
            Layer.mock(GitService, {
              resolveLastCommit: (rootPath) =>
                Effect.succeed(
                  LocalReviewTarget.make({
                    kind: "local",
                    rootPath,
                    comparison: LastCommitComparison.make({
                      baseSha: ReviewRevision.make("b".repeat(40)),
                      headSha: ReviewRevision.make(revision),
                    }),
                  }),
                ),
              workingTreeChanges: (rootPath) =>
                Ref.set(statusPath, Option.some(rootPath)).pipe(
                  Effect.as([
                    LocalGitWorkingTreeChange.make({
                      path: RepositoryRelativePath.make("src/a.ts"),
                      status: "modified",
                    }),
                  ]),
                ),
              workingTreeFileLineChanges: (rootPath) =>
                Ref.set(lineChangePath, Option.some(rootPath)).pipe(
                  Effect.as([
                    CodeLineChangeRange.make({ kind: "modified", startLine: 1, endLine: 1 }),
                  ]),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(HostedReviewWorkspacePool, {
              useRevision: () => Effect.die("project head must not use a managed workspace"),
            }),
          ),
          Layer.provide(
            Layer.mock(AgentWorkspaceResources, {
              protect: () => Effect.die("project head must not protect the linked checkout"),
            }),
          ),
          Layer.provide(
            Layer.mock(ManagedWorkspaceFiles, {
              indexFiles: (rootPath) =>
                Ref.set(indexedPath, Option.some(rootPath)).pipe(
                  Effect.as([RepositoryRelativePath.make("src/a.ts")]),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(LocalCheckoutFiles, {
              read: (rootPath, path) =>
                Ref.set(readPath, Option.some(rootPath)).pipe(
                  Effect.as(CodeWorkspaceFileContent.make({ path, content: "changed\n" })),
                ),
            }),
          ),
          Layer.provide(Layer.mock(ResourceCollection, { collectPolicy: () => Effect.succeed(0) })),
          Layer.provide(LanguageAdapterRegistry.layer([])),
          Layer.provide(unusedSnapshotLayer),
        )

        yield* Effect.gen(function* () {
          const workspaces = yield* CodeWorkspaceService
          const lease = yield* workspaces.open(
            ProjectHeadCodeWorkspaceTarget.make({ projectId }),
            owner,
          )
          expect(yield* workspaces.changes(lease.id, owner)).toMatchObject({
            changes: [{ path: "src/a.ts", status: "modified" }],
            truncated: false,
          })
          expect(yield* Ref.get(statusPath)).toEqual(Option.some(repository.localPath))
          expect(yield* Ref.get(statusPath)).not.toEqual(Option.some(workspacePath))
          const path = RepositoryRelativePath.make("src/a.ts")
          expect(
            CodeWorkspaceFileReadResult.match(yield* workspaces.readFile(lease.id, owner, path), {
              content: ({ content }) => content,
              rejected: () => "rejected",
            }),
          ).toBe("changed\n")
          expect(yield* workspaces.lineChanges(lease.id, owner, path)).toMatchObject({
            changes: [{ kind: "modified", startLine: 1, endLine: 1 }],
            truncated: false,
          })
          yield* workspaces.search(lease.id, owner, "src", 0, 10)
          expect(yield* Ref.get(indexedPath)).toEqual(Option.some(repository.localPath))
          expect(yield* Ref.get(readPath)).toEqual(Option.some(repository.localPath))
          expect(yield* Ref.get(lineChangePath)).toEqual(Option.some(repository.localPath))
        }).pipe(Effect.provide(changesLayer))
      }),
  )

  it.effect("materializes a persisted local review patch over its exact Git base", () =>
    Effect.gen(function* () {
      const snapshotId = ReviewSnapshotId.make(`snapshot:v1:${"1".repeat(32)}`)
      const snapshotRevision = ReviewRevision.make("d".repeat(64))
      const resourceId = CatalogResourceId.make("snapshot-spool:code-workspace")
      const reviewRoot = RepositoryCheckoutPath.make("/source/worktree")
      const patch = new TextEncoder().encode("diff --git a/new.ts b/new.ts\n")
      const lifecycle = yield* Ref.make<readonly string[]>([])
      const spoolAvailable = yield* Ref.make(true)
      const checkoutRevision = yield* Ref.make(Option.none<GitCommitSha>())
      const checkoutSourcePath = yield* Ref.make(Option.none<RepositoryCheckoutPath>())
      const snapshotLayer = CodeWorkspaceService.layer.pipe(
        Layer.provide(Layer.mock(RepositoryStore, { getById: () => Effect.succeed(repository) })),
        Layer.provide(Layer.mock(GitProvider, {})),
        Layer.provide(
          Layer.mock(GitService, {
            applyWorkspacePatch: (localPath, appliedPatch) =>
              Effect.gen(function* () {
                expect(localPath).toBe(workspacePath)
                expect(appliedPatch).toEqual(patch)
                yield* Ref.update(lifecycle, (events) => [...events, "patchApplied"])
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(HostedReviewWorkspacePool, {
            useRevision: (input, use) =>
              Ref.set(checkoutRevision, Option.some(input.revision)).pipe(
                Effect.andThen(Ref.set(checkoutSourcePath, Option.fromNullishOr(input.sourcePath))),
                Effect.andThen(use(workspacePath)),
              ),
          }),
        ),
        Layer.provide(Layer.mock(AgentWorkspaceResources, { protect: (_input, use) => use })),
        Layer.provide(
          Layer.mock(ManagedWorkspaceFiles, {
            indexFiles: () => Effect.succeed([RepositoryRelativePath.make("new.ts")]),
          }),
        ),
        Layer.provide(
          Layer.mock(LocalCheckoutFiles, {
            read: (_root, path) =>
              Effect.succeed(
                CodeWorkspaceFileContent.make({ path, content: "export const added = 1\n" }),
              ),
          }),
        ),
        Layer.provide(Layer.mock(ResourceCollection, { collectPolicy: () => Effect.succeed(0) })),
        Layer.provide(LanguageAdapterRegistry.layer([])),
        Layer.provide(
          CodeWorkspaceSnapshotSource.layer.pipe(
            Layer.provide(
              Layer.mock(SnapshotBlockStore, {
                getSnapshotHeader: () =>
                  Effect.succeed({
                    id: StoredSnapshotId.make(snapshotId),
                    projectId,
                    reviewKey: "local:review",
                    baseRevision: revision,
                    headRevision: snapshotRevision,
                    semanticIdentity: snapshotRevision,
                    descriptor: LocalReviewDescriptor.make({
                      target: LocalReviewTarget.make({
                        kind: "local",
                        rootPath: reviewRoot,
                        comparison: WorkingTreeComparison.make({}),
                      }),
                      repoName: "worktree",
                      branchName: null,
                      title: "Local changes",
                      fetchedAt: "2026-08-22T00:00:00.000Z",
                    }),
                    source: SnapshotStorageSource.cases.managedSpool.make({
                      kind: "managedSpool",
                      resourceId,
                    }),
                    createdAtMs: 0,
                  }),
                readSnapshotSpool: () =>
                  Ref.get(spoolAvailable).pipe(
                    Effect.flatMap((available) => {
                      if (!available) {
                        return Ref.update(lifecycle, (events) => [...events, "spoolRejected"]).pipe(
                          Effect.andThen(
                            Effect.fail(
                              SnapshotBlockStoreError.make({
                                operation: "readSnapshotSpool",
                                cause: new Error("Snapshot spool checksum does not match metadata"),
                              }),
                            ),
                          ),
                        )
                      }
                      return Ref.update(lifecycle, (events) => [...events, "spoolResolved"]).pipe(
                        Effect.as(patch),
                      )
                    }),
                  ),
              }),
            ),
            Layer.provide(
              Layer.mock(ResourceCatalog, {
                acquireLease: () => Ref.update(lifecycle, (events) => [...events, "spoolLeased"]),
                releaseLease: () => Ref.update(lifecycle, (events) => [...events, "spoolReleased"]),
              }),
            ),
            Layer.provide(
              Layer.mock(GitService, {
                applyWorkspacePatch: (localPath, appliedPatch) =>
                  Effect.gen(function* () {
                    expect(localPath).toBe(workspacePath)
                    expect(appliedPatch).toEqual(patch)
                    yield* Ref.update(lifecycle, (events) => [...events, "patchApplied"])
                  }),
              }),
            ),
          ),
        ),
      )

      yield* Effect.gen(function* () {
        const workspaces = yield* CodeWorkspaceService
        const lease = yield* workspaces.open(
          LocalReviewSnapshotCodeWorkspaceTarget.make({ projectId, snapshotId }),
          owner,
        )
        expect(lease.revision).toBe(snapshotRevision)
        expect(lease.gitRevision).toEqual(Option.none())
        expect(yield* Ref.get(checkoutRevision)).toEqual(Option.some(revision))
        expect(yield* Ref.get(checkoutSourcePath)).toEqual(Option.some(reviewRoot))
        expect(yield* Ref.get(lifecycle)).toEqual([
          "spoolLeased",
          "spoolResolved",
          "patchApplied",
          "spoolReleased",
        ])
        expect(
          CodeWorkspaceFileReadResult.match(
            yield* workspaces.readFile(lease.id, owner, RepositoryRelativePath.make("new.ts")),
            {
              content: ({ content }) => content,
              rejected: () => "rejected",
            },
          ),
        ).toBe("export const added = 1\n")
        yield* workspaces.release(lease.id, owner)

        yield* Ref.set(spoolAvailable, false)
        yield* Ref.set(lifecycle, [])
        expect(
          Result.isFailure(
            yield* Effect.result(
              workspaces.open(
                LocalReviewSnapshotCodeWorkspaceTarget.make({ projectId, snapshotId }),
                owner,
              ),
            ),
          ),
        ).toBe(true)
        expect(yield* Ref.get(lifecycle)).toEqual(["spoolLeased", "spoolRejected", "spoolReleased"])
      }).pipe(Effect.provide(snapshotLayer))
    }),
  )

  it.effect("pages search results and keeps release authoritative over concurrent heartbeat", () =>
    Effect.gen(function* () {
      const workspaces = yield* CodeWorkspaceService
      const lease = yield* workspaces.open(
        ProjectRevisionCodeWorkspaceTarget.make({
          projectId,
          revision,
        }),
        owner,
      )

      expect(yield* workspaces.search(lease.id, owner, "src", 0, 2)).toEqual({
        paths: ["src/a.ts", "src/b.ts"],
        nextOffset: 2,
      })
      expect(yield* workspaces.search(lease.id, owner, "src", 2, 2)).toEqual({
        paths: ["src/c.ts"],
        nextOffset: null,
      })

      const otherOwner = { ...owner, processEpoch: CoreProcessEpoch.make("other-epoch") }
      expect(
        Result.isFailure(yield* Effect.result(workspaces.heartbeat(lease.id, otherOwner))),
      ).toBe(true)

      yield* Effect.all(
        [
          workspaces.heartbeat(lease.id, owner).pipe(Effect.ignore),
          workspaces.release(lease.id, owner),
        ],
        { concurrency: "unbounded" },
      )
      const afterRelease = yield* Effect.result(workspaces.heartbeat(lease.id, owner))
      expect(Result.isFailure(afterRelease)).toBe(true)
      if (Result.isFailure(afterRelease)) expect(afterRelease.failure.reason).toBe("leaseNotFound")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("expires an abandoned logical lease after one hour", () =>
    Effect.gen(function* () {
      const workspaces = yield* CodeWorkspaceService
      const lease = yield* workspaces.open(
        ProjectRevisionCodeWorkspaceTarget.make({
          projectId,
          revision,
        }),
        owner,
      )

      yield* TestClock.adjust("61 minutes")
      const heartbeat = yield* Effect.result(workspaces.heartbeat(lease.id, owner))
      expect(Result.isFailure(heartbeat)).toBe(true)
      if (Result.isFailure(heartbeat)) expect(heartbeat.failure.reason).toBe("leaseNotFound")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("releases workspace protection when open is interrupted before readiness", () =>
    Effect.gen(function* () {
      const workerStarted = yield* Deferred.make<void>()
      const continueWorker = yield* Deferred.make<void>()
      const protectionReleased = yield* Deferred.make<void>()
      const interruptionLayer = CodeWorkspaceService.layer.pipe(
        Layer.provide(Layer.mock(RepositoryStore, { getById: () => Effect.succeed(repository) })),
        Layer.provide(Layer.mock(GitProvider, {})),
        Layer.provide(Layer.mock(GitService, {})),
        Layer.provide(
          Layer.mock(HostedReviewWorkspacePool, {
            useRevision: (_input, use) =>
              Deferred.succeed(workerStarted, undefined).pipe(
                Effect.andThen(Deferred.await(continueWorker)),
                Effect.andThen(use(workspacePath)),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(AgentWorkspaceResources, {
            protect: (_input, use) =>
              use.pipe(Effect.ensuring(Deferred.succeed(protectionReleased, undefined))),
          }),
        ),
        Layer.provide(
          Layer.mock(ManagedWorkspaceFiles, {
            indexFiles: () => Effect.succeed([]),
          }),
        ),
        Layer.provide(Layer.mock(LocalCheckoutFiles, {})),
        Layer.provide(Layer.mock(ResourceCollection, { collectPolicy: () => Effect.succeed(0) })),
        Layer.provide(LanguageAdapterRegistry.layer([])),
        Layer.provide(unusedSnapshotLayer),
      )

      yield* Effect.gen(function* () {
        const workspaces = yield* CodeWorkspaceService
        const opening = yield* workspaces
          .open(
            ProjectRevisionCodeWorkspaceTarget.make({
              projectId,
              revision,
            }),
            owner,
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(workerStarted)
        yield* Fiber.interrupt(opening)
        yield* Deferred.succeed(continueWorker, undefined)
        yield* Deferred.await(protectionReleased)
      }).pipe(Effect.provide(interruptionLayer))
    }),
  )

  it.effect("owns one lazy language session and closes it before workspace cleanup", () =>
    Effect.gen(function* () {
      const languagePath = RepositoryRelativePath.make("src/a.ts")
      const lifecycle = yield* Ref.make<readonly string[]>([])
      const workspaceReleased = yield* Deferred.make<void>()
      const probeCount = yield* Ref.make(0)
      const openCount = yield* Ref.make(0)
      const definitionCount = yield* Ref.make(0)
      const referenceCount = yield* Ref.make(0)
      const result = new RepositoryLanguageLocationResult({ locations: [], truncated: false })
      const registration: LanguageAdapterRegistration = {
        descriptor: new LanguageAdapterDescriptor({
          id: LanguageAdapterId.make("test-typescript"),
          displayName: "Test TypeScript",
          languageIds: [LanguageId.make("typescript")],
          extensions: [".ts"],
          capabilities: new LanguageAdapterCapabilities({
            definitions: true,
            documentSymbols: false,
            references: true,
            workspaceSymbols: false,
          }),
        }),
        probe: Ref.update(probeCount, (count) => count + 1),
        openSession: () =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Ref.update(openCount, (count) => count + 1)
              yield* Ref.update(lifecycle, (events) => [...events, "opened"])
              return {
                definitions: () =>
                  Effect.gen(function* () {
                    const definitions = yield* Ref.updateAndGet(
                      definitionCount,
                      (count) => count + 1,
                    )
                    const opens = yield* Ref.get(openCount)
                    if (opens === 1 && definitions === 3) {
                      return yield* Effect.fail(
                        new LanguageOperationError({
                          operation: "definitions",
                          reason: "serverUnavailable",
                          message: "Test server exited",
                        }),
                      )
                    }
                    return result
                  }),
                documentSymbols: () => Effect.die("Not used by this test"),
                references: () =>
                  Ref.update(referenceCount, (count) => count + 1).pipe(Effect.as(result)),
                workspaceSymbols: () => Effect.die("Not used by this test"),
              }
            }),
            () => Ref.update(lifecycle, (events) => [...events, "languageClosed"]),
          ),
      }
      const languageLayer = CodeWorkspaceService.layer.pipe(
        Layer.provide(Layer.mock(RepositoryStore, { getById: () => Effect.succeed(repository) })),
        Layer.provide(Layer.mock(GitProvider, {})),
        Layer.provide(Layer.mock(GitService, {})),
        Layer.provide(
          Layer.mock(HostedReviewWorkspacePool, {
            useRevision: (_input, use) =>
              use(workspacePath).pipe(
                Effect.ensuring(
                  Ref.update(lifecycle, (events) => [...events, "workspaceReleased"]).pipe(
                    Effect.andThen(Deferred.succeed(workspaceReleased, undefined)),
                  ),
                ),
              ),
          }),
        ),
        Layer.provide(Layer.mock(AgentWorkspaceResources, { protect: (_input, use) => use })),
        Layer.provide(
          Layer.mock(ManagedWorkspaceFiles, {
            indexFiles: () => Effect.succeed([languagePath]),
          }),
        ),
        Layer.provide(
          Layer.mock(LocalCheckoutFiles, {
            read: (_root, path) =>
              Effect.succeed(
                CodeWorkspaceFileContent.make({ path, content: "export const a = 1" }),
              ),
          }),
        ),
        Layer.provide(Layer.mock(ResourceCollection, { collectPolicy: () => Effect.succeed(0) })),
        Layer.provide(LanguageAdapterRegistry.layer([registration])),
        Layer.provide(unusedSnapshotLayer),
      )

      yield* Effect.gen(function* () {
        const workspaces = yield* CodeWorkspaceService
        const lease = yield* workspaces.open(
          ProjectRevisionCodeWorkspaceTarget.make({
            projectId,
            revision,
          }),
          owner,
        )
        expect(yield* Ref.get(openCount)).toBe(0)
        expect(
          yield* workspaces.definitions(
            lease.id,
            owner,
            languagePath,
            new LanguagePosition({ line: 0, character: 1 }),
          ),
        ).toBe(result)
        expect(
          yield* workspaces.definitions(
            lease.id,
            owner,
            languagePath,
            new LanguagePosition({ line: 0, character: 2 }),
          ),
        ).toBe(result)
        expect(yield* Ref.get(probeCount)).toBe(1)
        expect(yield* Ref.get(openCount)).toBe(1)
        expect(yield* Ref.get(definitionCount)).toBe(2)
        expect(
          yield* workspaces.definitions(
            lease.id,
            owner,
            languagePath,
            new LanguagePosition({ line: 0, character: 3 }),
          ),
        ).toBe(result)
        expect(yield* Ref.get(openCount)).toBe(2)
        expect(yield* Ref.get(definitionCount)).toBe(4)
        expect(
          yield* workspaces.references(
            lease.id,
            owner,
            languagePath,
            new LanguagePosition({ line: 0, character: 4 }),
          ),
        ).toBe(result)
        expect(yield* Ref.get(referenceCount)).toBe(1)

        yield* workspaces.release(lease.id, owner)
        yield* Deferred.await(workspaceReleased)
        expect(yield* Ref.get(lifecycle)).toEqual([
          "opened",
          "languageClosed",
          "opened",
          "languageClosed",
          "workspaceReleased",
        ])
      }).pipe(Effect.provide(languageLayer))
    }),
  )
})
