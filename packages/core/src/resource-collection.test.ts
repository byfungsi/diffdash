import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CatalogResource,
  CatalogResourceId,
  ResourceCatalog,
  ResourceRecoveryToken,
  ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Result } from "effect"
import { TestClock } from "effect/testing"

import {
  makeBoundedLogicalResourceAdapter,
  makeFilesystemResourceAdapter,
  makeResourceCollection,
  makeUpdaterPartialResourceAdapter,
  ResourceAdapterError,
  type ResourceMutationAdapter,
} from "./resource-collection"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-resource-collection-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (databasePath: string) =>
  ResourceCatalog.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const logicalAdapter = makeBoundedLogicalResourceAdapter(() => Effect.void, 1_000)

describe("resource collection", () => {
  it.effect("quarantines and deletes only inside a registered non-symlink root", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const root = join(directory, "root")
      const target = join(root, "cache", "snapshot")
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, "block"), "managed bytes")
      const databasePath = join(directory, "catalog.sqlite")
      const rootId = ResourceRootId.make("cache-root")

      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        yield* catalog.registerRoot({ id: rootId, path: root, createdAtMs: 1 })
        const resource = yield* catalog.register({
          id: CatalogResourceId.make("snapshot-1"),
          parentId: null,
          kind: "snapshot-block",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: { kind: "filesystem", rootId, relativePath: "cache/snapshot" },
          bytes: 13,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        const collection = makeResourceCollection(catalog, {
          filesystem: makeFilesystemResourceAdapter(new Map([[rootId, root]])),
          gitRef: logicalAdapter,
          updaterPartial: logicalAdapter,
        })

        yield* collection.collect({
          resourceId: resource.id,
          recoveryToken: ResourceRecoveryToken.make("collection-1"),
          nowMs: 2,
          retryAtMs: 100,
        })

        expect(yield* catalog.get(resource.id)).toMatchObject({ state: "deleted", bytes: 0 })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("rejects path traversal and symlink traversal before mutation", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const root = join(directory, "root")
      const outside = join(directory, "outside")
      mkdirSync(root)
      mkdirSync(outside)
      writeFileSync(join(outside, "keep"), "keep")
      symlinkSync(outside, join(root, "linked"))
      const rootId = ResourceRootId.make("root")
      const adapter = makeFilesystemResourceAdapter(new Map([[rootId, root]]))
      const base = {
        id: CatalogResourceId.make("unsafe"),
        parentId: null,
        kind: "agentTemp",
        policyClass: "cache" as const,
        state: "collecting" as const,
        generation: 1,
        bytes: 1,
        reservedBytes: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
        lastUsedAtMs: 1,
        checksum: null,
        validation: null,
        recoveryToken: ResourceRecoveryToken.make("unsafe-token"),
        failure: null,
        retryAtMs: null,
        leases: [],
      }
      const unsafe = [
        CatalogResource.make({
          ...base,
          location: { kind: "filesystem", rootId, relativePath: "../outside" },
        }),
        CatalogResource.make({
          ...base,
          location: { kind: "filesystem", rootId, relativePath: "linked/keep" },
        }),
      ]
      for (const resource of unsafe) {
        const result = yield* Effect.result(
          adapter.quarantine(resource, ResourceRecoveryToken.make("unsafe-token")),
        )
        expect(Result.isFailure(result)).toBe(true)
      }
    }),
  )

  it.effect("retries deletion from durable failed intent without dropping accounted bytes", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const databasePath = join(directory, "catalog.sqlite")
      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = yield* catalog.register({
          id: CatalogResourceId.make("logical-1"),
          parentId: null,
          kind: "reviewRef",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: { kind: "gitRef", identity: "refs/diffdash/logical-1" },
          bytes: 500,
          nowMs: 1,
          checksum: null,
          validation: null,
        })
        let failDelete = true
        const fake: ResourceMutationAdapter = {
          quarantine: () => Effect.void,
          delete: () =>
            failDelete
              ? Effect.fail(
                  ResourceAdapterError.make({
                    operation: "delete",
                    resourceId: resource.id,
                    reason: "injected crash boundary",
                    cause: new Error("injected crash boundary"),
                  }),
                )
              : Effect.void,
        }
        const collection = makeResourceCollection(catalog, {
          filesystem: fake,
          gitRef: fake,
          updaterPartial: fake,
        })

        yield* collection.collect({
          resourceId: resource.id,
          recoveryToken: ResourceRecoveryToken.make("retry-token"),
          nowMs: 2,
          retryAtMs: 3,
        })
        expect(yield* catalog.get(resource.id)).toMatchObject({
          state: "deletionFailed",
          bytes: 500,
        })

        failDelete = false
        yield* collection.reconcile(3, 10)
        expect(yield* catalog.get(resource.id)).toMatchObject({ state: "deleted", bytes: 0 })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("bounds updater mutations and never forwards another location kind", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const adapter = makeUpdaterPartialResourceAdapter(
        (operation, identity) =>
          Effect.sync(() => {
            calls.push(`${operation}:${identity}`)
          }),
        { timeoutMs: 1_000, maximumIdentityBytes: 8 },
      )
      const base = CatalogResource.make({
        id: CatalogResourceId.make("updater"),
        parentId: null,
        kind: "updaterPartial",
        policyClass: "temporary",
        state: "collecting",
        generation: 1,
        bytes: 1,
        reservedBytes: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
        lastUsedAtMs: 1,
        checksum: null,
        validation: null,
        recoveryToken: ResourceRecoveryToken.make("updater-token"),
        failure: null,
        retryAtMs: null,
        leases: [],
        location: { kind: "updaterPartial", identity: "partial" },
      })
      const token = ResourceRecoveryToken.make("updater-token")

      yield* adapter.quarantine(base, token)
      expect(calls).toEqual(["quarantine:partial"])

      const oversized = CatalogResource.make({
        ...base,
        location: { kind: "updaterPartial", identity: "too-large" },
      })
      const wrongKind = CatalogResource.make({
        ...base,
        location: { kind: "gitRef", identity: "partial" },
      })
      expect(Result.isFailure(yield* Effect.result(adapter.delete(oversized, token)))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(adapter.delete(wrongKind, token)))).toBe(true)
      expect(calls).toHaveLength(1)

      const stalled = makeUpdaterPartialResourceAdapter(() => Effect.never, {
        timeoutMs: 5,
        maximumIdentityBytes: 8,
      })
      const stalledMutation = yield* stalled
        .delete(base, token)
        .pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(6)
      expect(Result.isFailure(yield* Fiber.join(stalledMutation))).toBe(true)
    }),
  )
})
