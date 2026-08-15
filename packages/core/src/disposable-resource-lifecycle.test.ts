import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as DatabaseNode from "@diffdash/persistence/database-node"
import {
  CatalogResourceId,
  ResourceCatalog,
  ResourceLeaseId,
  ResourceRecoveryToken,
  ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import {
  makeDisposableResourceLifecycle,
  type AgentWorkspaceLeaseInput,
} from "./disposable-resource-lifecycle"
import {
  makeBoundedLogicalResourceAdapter,
  makeFilesystemResourceAdapter,
  makeResourceCollection,
} from "./resource-collection"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-resource-lifecycle-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (databasePath: string) =>
  ResourceCatalog.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

describe("disposable resource lifecycle", () => {
  it.effect("reports safe class aggregates and clears only unleased cataloged cache paths", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const root = join(directory, "managed")
      const unknown = join(root, "unknown-old-artifact")
      const repositoryPath = join(root, "repositories", "repo")
      const worktreePath = join(repositoryPath, "worktree")
      const remotePath = join(root, "remote", "repo")
      const backupPath = join(root, "backups", "database.sqlite")
      for (const path of [unknown, worktreePath, remotePath, backupPath]) {
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, "bytes"), path)
      }
      const databasePath = join(directory, "catalog.sqlite")
      const rootId = ResourceRootId.make("managed-root")

      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        yield* catalog.registerRoot({ id: rootId, path: root, createdAtMs: 1 })
        const repository = yield* catalog.register({
          id: CatalogResourceId.make("repository"),
          parentId: null,
          kind: "bareRepository",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: {
            kind: "filesystem",
            rootId,
            relativePath: "repositories/repo",
          },
          bytes: 100,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        const worktree = yield* catalog.register({
          id: CatalogResourceId.make("worktree"),
          parentId: repository.id,
          kind: "localWorktreePool",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: {
            kind: "filesystem",
            rootId,
            relativePath: "repositories/repo/worktree",
          },
          bytes: 40,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        yield* catalog.register({
          id: CatalogResourceId.make("remote"),
          parentId: null,
          kind: "remoteWorktreePool",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: { kind: "filesystem", rootId, relativePath: "remote/repo" },
          bytes: 60,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        yield* catalog.register({
          id: CatalogResourceId.make("backup"),
          parentId: null,
          kind: "migrationBackup",
          policyClass: "migrationBackup",
          state: "ready",
          generation: 1,
          location: { kind: "filesystem", rootId, relativePath: "backups/database.sqlite" },
          bytes: 80,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        const failedTemporary = yield* catalog.register({
          id: CatalogResourceId.make("failed-temp"),
          parentId: null,
          kind: "processTemp",
          policyClass: "temporary",
          state: "ready",
          generation: 1,
          location: { kind: "updaterPartial", identity: "opaque-failed-temp" },
          bytes: 20,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        const failedToken = ResourceRecoveryToken.make("failed-token")
        yield* catalog.beginCollection({
          resourceId: failedTemporary.id,
          recoveryToken: failedToken,
          nowMs: 2,
        })
        yield* catalog.failDeletion({
          resourceId: failedTemporary.id,
          recoveryToken: failedToken,
          failure: "classified-failure",
          retryAtMs: 100,
          nowMs: 2,
        })

        const logical = makeBoundedLogicalResourceAdapter(() => Effect.void, 1_000)
        const collection = makeResourceCollection(catalog, {
          filesystem: makeFilesystemResourceAdapter(new Map([[rootId, root]])),
          gitRef: logical,
          updaterPartial: logical,
        })
        const lifecycle = makeDisposableResourceLifecycle(catalog, collection)
        const lease: AgentWorkspaceLeaseInput = {
          repositoryResourceId: repository.id,
          repositoryLeaseId: ResourceLeaseId.make("repository-lease"),
          worktreeResourceId: worktree.id,
          worktreeLeaseId: ResourceLeaseId.make("worktree-lease"),
          agentRunId: "agent-run",
          applicationInstanceId: "core-app",
          processEpoch: "core-epoch",
          acquiredAtMs: 2,
          expiresAtMs: 100,
        }
        yield* lifecycle.acquireAgentWorkspace(lease)

        const diagnostics = yield* lifecycle.diagnostics(10)
        expect(diagnostics).toMatchObject({
          bytes: 300,
          activeLeases: 2,
          failures: 1,
        })
        expect(diagnostics.classes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ resourceClass: "localWorktreePool", bytes: 40 }),
            expect.objectContaining({ resourceClass: "remoteWorktreePool", bytes: 60 }),
          ]),
        )
        expect(JSON.stringify(diagnostics)).not.toContain(root)
        expect(JSON.stringify(diagnostics)).not.toContain("agent-run")
        expect(JSON.stringify(diagnostics)).not.toContain("classified-failure")

        const first = yield* lifecycle.clearCache({
          nowMs: 10,
          retryAtMs: 20,
          recoveryToken: (id) => ResourceRecoveryToken.make(`first-${id}`),
        })
        expect(first.collected).toEqual([CatalogResourceId.make("remote")])
        expect(first.protected).toEqual(expect.arrayContaining([repository.id, worktree.id]))
        expect(existsSync(remotePath)).toBe(false)
        expect(existsSync(worktreePath)).toBe(true)
        expect(existsSync(backupPath)).toBe(true)
        expect(existsSync(unknown)).toBe(true)

        yield* lifecycle.releaseAgentWorkspace(lease)
        yield* lifecycle.clearCache({
          nowMs: 11,
          retryAtMs: 20,
          recoveryToken: (id) => ResourceRecoveryToken.make(`second-${id}`),
        })
        expect(existsSync(repositoryPath)).toBe(false)
        expect(existsSync(backupPath)).toBe(true)
        expect(existsSync(unknown)).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
