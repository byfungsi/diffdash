import {
  type CatalogResource,
  type RegisterResourceInput,
  ResourceCatalog,
  type ResourceCatalogError,
  type ResourceRoot,
} from "@diffdash/persistence/resource-catalog"
import { Context, Effect } from "effect"

/** Producer declaration restricted structurally to disposable policy classes. */
export type DisposableResourceRegistration = Omit<RegisterResourceInput, "policyClass"> & {
  readonly policyClass: Exclude<RegisterResourceInput["policyClass"], "durableUserData">
}

/** Explicit producer declarations; existing directory contents are never inferred or adopted. */
export interface DisposableResourceProducerRegistration {
  readonly roots: readonly ResourceRoot[]
  readonly resources: readonly DisposableResourceRegistration[]
}

/** Registers only resources explicitly declared by their owning producer. */
export const registerDisposableResourceProducers = Effect.fn(
  "DisposableResources.registerProducers",
)(function* (
  catalog: Context.Service.Shape<typeof ResourceCatalog>,
  registration: DisposableResourceProducerRegistration,
): Effect.fn.Return<readonly CatalogResource[], ResourceCatalogError> {
  for (const root of registration.roots) yield* catalog.registerRoot(root)
  return yield* Effect.forEach(registration.resources, (resource) => catalog.register(resource), {
    concurrency: 1,
  })
})
