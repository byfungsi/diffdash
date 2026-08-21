import { describe, expect, it } from "@effect/vitest"
import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { ProjectRevisionCodeWorkspaceTarget } from "@diffdash/domain/code-workspace"
import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { ManagedWorkspaceFiles } from "@diffdash/local-git/managed-workspace-files"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import { TestClock } from "effect/testing"

import { AgentWorkspaceResources } from "../agent-workspace-resources"
import { ResourceCollection } from "../resource-collection"
import { CodeWorkspaceService } from "./code-workspace"
import { GitProvider } from "./git-provider"
import { GitService } from "@diffdash/local-git/local-git"

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
)

describe("CodeWorkspaceService", () => {
  it.effect("pages search results and keeps release authoritative over concurrent heartbeat", () =>
    Effect.gen(function* () {
      const workspaces = yield* CodeWorkspaceService
      const lease = yield* workspaces.open(
        ProjectRevisionCodeWorkspaceTarget.make({
          projectId,
          revision: ReviewRevision.make(revision),
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
          revision: ReviewRevision.make(revision),
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
      )

      yield* Effect.gen(function* () {
        const workspaces = yield* CodeWorkspaceService
        const opening = yield* workspaces
          .open(
            ProjectRevisionCodeWorkspaceTarget.make({
              projectId,
              revision: ReviewRevision.make(revision),
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
})
