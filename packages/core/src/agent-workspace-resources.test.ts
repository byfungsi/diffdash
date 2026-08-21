import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { AgentRunId } from "@diffdash/domain/review-agent"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import {
  CatalogResourceId,
  ResourceCatalog,
  ResourceReservationId,
  ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"

import { AgentWorkspaceResources, agentWorkspaceResourcesLayer } from "./agent-workspace-resources"
import {
  DisposableResourceLifecycle,
  makeDisposableResourceLifecycle,
} from "./disposable-resource-lifecycle"
import { ResourceCollection } from "./resource-collection"

const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-agent-workspace-resources-"))
    const local = join(directory, "local")
    const remote = join(directory, "remote")
    mkdirSync(local, { recursive: true })
    mkdirSync(remote, { recursive: true })
    return { database: join(directory, "catalog.sqlite"), directory, local, remote }
  }),
  ({ directory }) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeWorkspace = (root: string, digest: string, slot: string) => {
  const repository = join(root, "repositories", digest, "repository.git")
  const worktree = join(root, "repositories", digest, slot)
  mkdirSync(repository, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(repository, "pack"), "repository bytes")
  writeFileSync(join(worktree, "tracked.txt"), "worktree bytes")
  return RepositoryCheckoutPath.make(worktree)
}

const makeLayer = (input: {
  readonly database: string
  readonly local: string
  readonly remote: string
}) => {
  const catalog = ResourceCatalog.layer.pipe(Layer.provideMerge(DatabaseNode.layer(input.database)))
  const collection = Layer.succeed(
    ResourceCollection,
    ResourceCollection.of({
      collect: () => Effect.die(new Error("collection is not used by workspace registration")),
      reconcile: () => Effect.void,
      collectPolicy: () => Effect.succeed(0),
    }),
  )
  const lifecycle = Layer.effect(
    DisposableResourceLifecycle,
    Effect.gen(function* () {
      return makeDisposableResourceLifecycle(yield* ResourceCatalog, yield* ResourceCollection)
    }),
  ).pipe(Layer.provideMerge(catalog), Layer.provideMerge(collection))
  return agentWorkspaceResourcesLayer({
    local: { rootId: ResourceRootId.make("local-root"), rootPath: input.local },
    remote: { rootId: ResourceRootId.make("remote-root"), rootPath: input.remote },
  }).pipe(Layer.provideMerge(lifecycle))
}

const ownership = {
  agentRunId: AgentRunId.make("agent-run"),
  applicationInstanceId: ApplicationInstanceId.make("application"),
  processEpoch: CoreProcessEpoch.make("epoch"),
}

describe("AgentWorkspaceResources", () => {
  it.effect("catalogs both pools and protects each worktree with its parent repository", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const localPath = makeWorkspace(value.local, "a".repeat(64), "slot-local")
      const remotePath = makeWorkspace(value.remote, "b".repeat(64), "slot-remote")

      yield* Effect.gen(function* () {
        const resources = yield* AgentWorkspaceResources
        const catalog = yield* ResourceCatalog
        for (const workspacePath of [localPath, remotePath]) {
          yield* resources.protect(
            {
              ...ownership,
              localPath: workspacePath,
              leaseLifetimeMs: 60 * 60 * 1_000,
              leaseRenewalMs: 20 * 60 * 1_000,
            },
            Effect.gen(function* () {
              const active = (yield* catalog.list()).filter(
                (resource) => resource.leases.length > 0,
              )
              expect(active).toHaveLength(2)
              expect(
                active.every(({ leases }) =>
                  leases.every(
                    ({ acquiredAtMs, expiresAtMs }) =>
                      expiresAtMs - acquiredAtMs === 60 * 60 * 1_000,
                  ),
                ),
              ).toBe(true)
              const repository = active.find(({ kind }) => kind === "bareRepository")
              const worktree = active.find(({ kind }) => kind !== "bareRepository")
              expect(worktree?.parentId).toBe(repository?.id)
            }),
          )
        }

        const cataloged = yield* catalog.list()
        expect(cataloged.map(({ kind }) => kind)).toEqual(
          expect.arrayContaining([
            "bareRepository",
            "localWorktreePool",
            "bareRepository",
            "remoteWorktreePool",
          ]),
        )
        expect(cataloged.every((resource) => resource.bytes > 0)).toBe(true)
        expect(cataloged.every((resource) => resource.leases.length === 0)).toBe(true)
        const accountedBytes = cataloged.reduce((total, resource) => total + resource.bytes, 0)
        const writer = yield* catalog.register({
          id: CatalogResourceId.make("shared-pool-writer"),
          parentId: null,
          kind: "remoteWorktreePool",
          policyClass: "cache",
          state: "writing",
          generation: 1,
          location: { kind: "updaterPartial", identity: "shared-pool-writer" },
          bytes: 0,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        expect(
          yield* catalog.reserve({
            id: ResourceReservationId.make("shared-pool-reservation"),
            resourceId: writer.id,
            bytes: 1,
            nowMs: 2,
            expiresAtMs: 100,
            quotaBytes: accountedBytes,
          }),
        ).toEqual({ kind: "quotaExceeded", requiredBytes: 1, availableBytes: 0 })
      }).pipe(Effect.provide(makeLayer(value)))
    }),
  )

  it.effect("rejects paths outside generated pool layout without adopting older artifacts", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const unknown = join(value.local, "unknown-older-artifact")
      mkdirSync(unknown)

      yield* Effect.gen(function* () {
        const resources = yield* AgentWorkspaceResources
        const catalog = yield* ResourceCatalog
        const result = yield* Effect.result(
          resources.protect(
            { ...ownership, localPath: RepositoryCheckoutPath.make(unknown) },
            Effect.void,
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
        expect(yield* catalog.list()).toEqual([])
      }).pipe(Effect.provide(makeLayer(value)))
    }),
  )
})
