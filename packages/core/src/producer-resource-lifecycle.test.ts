import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { ResourceCatalog, ResourceRootId } from "@diffdash/persistence/resource-catalog"
import { TempResources } from "@diffdash/process/temp-resource"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import {
  makeFilesystemResourceAdapter,
  makeResourceCollection,
  ResourceCollection,
  type ResourceMutationAdapter,
} from "./resource-collection"
import { makeProducerResourceLifecycles } from "./producer-resource-lifecycle"

const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-producer-resources-"))
    return {
      database: join(directory, "catalog.sqlite"),
      directory,
      tempRoot: join(directory, "temp"),
    }
  }),
  ({ directory }) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
)

const inertMutation: ResourceMutationAdapter = {
  quarantine: () => Effect.void,
  delete: () => Effect.void,
}

const makeLayer = (database: string, tempRoot: string) => {
  const rootId = ResourceRootId.make("test:producer-temp")
  const catalogLayer = ResourceCatalog.layer.pipe(Layer.provideMerge(DatabaseNode.layer(database)))
  const collectionLayer = Layer.effect(
    ResourceCollection,
    Effect.gen(function* () {
      return makeResourceCollection(yield* ResourceCatalog, {
        filesystem: makeFilesystemResourceAdapter(new Map([[rootId, tempRoot]])),
        gitRef: inertMutation,
        updaterPartial: inertMutation,
      })
    }),
  ).pipe(Layer.provideMerge(catalogLayer))
  return Layer.unwrap(
    Effect.gen(function* () {
      const lifecycle = makeProducerResourceLifecycles(
        yield* ResourceCatalog,
        yield* ResourceCollection,
        { tempRootId: rootId, tempRootPath: tempRoot },
      )
      return TempResources.layerWithLifecycle(lifecycle.tempResources).pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      )
    }),
  ).pipe(Layer.provideMerge(collectionLayer))
}

describe("producer resource lifecycle", () => {
  it.effect("catalogs, renews, releases, and collects only producer-created temp paths", () =>
    Effect.gen(function* () {
      const value = yield* fixture
      const unknown = join(value.tempRoot, "unknown-older-artifact")
      let processDirectory = ""
      let agentDirectory = ""

      yield* Effect.gen(function* () {
        const resources = yield* ResourceCatalog
        const tempResources = yield* TempResources
        mkdirSync(value.tempRoot, { recursive: true })
        writeFileSync(unknown, "leave untouched")

        yield* Effect.scoped(
          Effect.gen(function* () {
            processDirectory = yield* tempResources.makeTempDirectoryScoped({
              parentDirectory: value.tempRoot,
              prefix: "process-",
            })
            agentDirectory = yield* tempResources.makeTempFileScoped("agent input", {
              parentDirectory: value.tempRoot,
              prefix: "agent-",
              fileName: "input.txt",
              resourceClass: "agentTemp",
            })

            const active = yield* resources.list()
            expect(active.map(({ kind }) => kind)).toEqual(
              expect.arrayContaining(["agentTemp", "processTemp"]),
            )
            expect(active).toHaveLength(2)
            expect(active.every(({ leases }) => leases.length === 1)).toBe(true)
            expect(
              active.every(({ validation }) => validation === "verified-producer-temp-v1"),
            ).toBe(true)

            yield* TestClock.adjust("10 seconds")
            const renewed = yield* resources.list()
            expect(renewed.every(({ leases }) => leases[0]?.renewedAtMs === 10_000)).toBe(true)
          }),
        )

        const collected = yield* resources.list()
        expect(collected.every(({ state }) => state === "deleted")).toBe(true)
        expect(collected.every(({ leases }) => leases.length === 0)).toBe(true)
      }).pipe(Effect.provide(makeLayer(value.database, value.tempRoot)))

      expect(existsSync(processDirectory)).toBe(false)
      expect(existsSync(dirname(agentDirectory))).toBe(false)
      expect(existsSync(unknown)).toBe(true)
    }),
  )
})
