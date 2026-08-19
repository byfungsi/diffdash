import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as DatabaseNode from "@diffdash/persistence/database-node"
import {
  CatalogResourceId,
  ResourceCatalog,
  ResourceRootId,
} from "@diffdash/persistence/resource-catalog"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"

import {
  type DisposableResourceRegistration,
  registerDisposableResourceProducers,
} from "./resource-producer-registration"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-resource-producers-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

describe("disposable resource producer registration", () => {
  it.effect("registers only producer declarations and is restart-idempotent", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const root = join(directory, "managed")
      mkdirSync(join(root, "declared"), { recursive: true })
      mkdirSync(join(root, "unknown-older-artifact"), { recursive: true })
      const databasePath = join(directory, "catalog.sqlite")
      const layer = ResourceCatalog.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

      yield* Effect.gen(function* () {
        const catalog = yield* ResourceCatalog
        const resource = {
          id: CatalogResourceId.make("declared-resource"),
          parentId: null,
          kind: "processTemp",
          policyClass: "temporary",
          state: "ready",
          generation: 1,
          location: {
            kind: "filesystem",
            rootId: ResourceRootId.make("producer-root"),
            relativePath: "declared",
          },
          bytes: 0,
          nowMs: 1,
          checksum: null,
          validation: null,
        } satisfies DisposableResourceRegistration
        const registration = {
          roots: [{ id: ResourceRootId.make("producer-root"), path: root, createdAtMs: 1 }],
          resources: [resource],
        }

        yield* registerDisposableResourceProducers(catalog, registration)
        yield* registerDisposableResourceProducers(catalog, registration)

        expect(yield* catalog.list()).toHaveLength(1)
        expect(existsSync(join(root, "unknown-older-artifact"))).toBe(true)
        expect(
          Result.isFailure(
            yield* Effect.result(
              registerDisposableResourceProducers(catalog, {
                ...registration,
                resources: [
                  {
                    ...resource,
                    location: {
                      kind: "filesystem",
                      rootId: ResourceRootId.make("producer-root"),
                      relativePath: "unknown-older-artifact",
                    },
                  },
                ],
              }),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )
})
