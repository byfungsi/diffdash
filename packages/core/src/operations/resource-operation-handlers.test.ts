import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as DatabaseNode from "@diffdash/persistence/database-node"
import { CatalogResourceId, ResourceCatalog } from "@diffdash/persistence/resource-catalog"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer } from "effect"

import {
  DisposableResourceLifecycle,
  makeDisposableResourceLifecycle,
} from "../disposable-resource-lifecycle"
import {
  makeBoundedLogicalResourceAdapter,
  makeResourceCollection,
  ResourceCollection,
} from "../resource-collection"
import { makeResourceOperationHandlers } from "./resource-operation-handlers"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-resource-operation-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (databasePath: string) => {
  const catalogLayer = ResourceCatalog.layer.pipe(
    Layer.provideMerge(DatabaseNode.layer(databasePath)),
  )
  const collectionLayer = Layer.effect(
    ResourceCollection,
    Effect.gen(function* () {
      const catalog = yield* ResourceCatalog
      const logical = makeBoundedLogicalResourceAdapter(() => Effect.void, 1_000)
      return makeResourceCollection(catalog, {
        filesystem: logical,
        gitRef: logical,
        updaterPartial: logical,
      })
    }),
  ).pipe(Layer.provideMerge(catalogLayer))
  return Layer.effect(
    DisposableResourceLifecycle,
    Effect.gen(function* () {
      const catalog = yield* ResourceCatalog
      const collection = yield* ResourceCollection
      return makeDisposableResourceLifecycle(catalog, collection)
    }),
  ).pipe(Layer.provideMerge(collectionLayer))
}

describe("resource operation handlers", () => {
  it.effect("reads and clears cataloged resources through the real lifecycle layers", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const layer = makeLayer(join(directory, "catalog.sqlite"))

      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const nowMs = yield* Clock.currentTimeMillis
        yield* catalog.register({
          id: CatalogResourceId.make("updater-partial"),
          parentId: null,
          kind: "agentTemp",
          policyClass: "cache",
          state: "ready",
          generation: 1,
          location: { kind: "updaterPartial", identity: "host-opaque-id" },
          bytes: 512,
          nowMs,
          checksum: null,
          validation: null,
        })

        const handlers = yield* makeResourceOperationHandlers
        const diagnostics = yield* handlers["Resources.diagnostics"]({}, {})
        expect(diagnostics).toMatchObject({ bytes: 512, resources: 1 })

        const cleared = yield* handlers["Resources.clearDisposable"]({}, {})
        expect(cleared).toMatchObject({
          collectedResources: 1,
          collectedBytes: 512,
          retainedLeasedResources: 0,
          diagnostics: { bytes: 0, resources: 0 },
        })
        expect(JSON.stringify(cleared)).not.toContain("host-opaque-id")
      }).pipe(Effect.provide(layer))
    }),
  )
})
