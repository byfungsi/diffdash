import { Schema } from "effect"

const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** Allowlisted resource class safe to expose outside Core. */
export const ResourceDiagnosticClass = Schema.Literals([
  "agentTemp",
  "bareRepository",
  "localWorktreePool",
  "migrationBackup",
  "processTemp",
  "remoteWorktreePool",
  "reviewRef",
  "reviewStaging",
  "snapshot-block",
  "snapshot-spool",
])

/** Allowlisted resource class safe to expose outside Core. */
export type ResourceDiagnosticClass = typeof ResourceDiagnosticClass.Type

/** Counts for each catalog lifecycle state, without resource identities. */
export const ResourceStateDiagnostics = Schema.Struct({
  writing: NonNegativeInt,
  ready: NonNegativeInt,
  collecting: NonNegativeInt,
  quarantined: NonNegativeInt,
  deletionFailed: NonNegativeInt,
  deleted: NonNegativeInt,
})

/** Privacy-safe aggregate for one allowlisted resource class. */
export const ResourceClassDiagnostics = Schema.Struct({
  resourceClass: ResourceDiagnosticClass,
  bytes: NonNegativeInt,
  reservedBytes: NonNegativeInt,
  resources: NonNegativeInt,
  activeLeases: NonNegativeInt,
  failures: NonNegativeInt,
  states: ResourceStateDiagnostics,
})

/** Privacy-safe aggregate for one allowlisted resource class. */
export type ResourceClassDiagnostics = typeof ResourceClassDiagnostics.Type

/** Privacy-safe diagnostics for resources explicitly cataloged by Core. */
export const ResourceDiagnostics = Schema.Struct({
  bytes: NonNegativeInt,
  reservedBytes: NonNegativeInt,
  resources: NonNegativeInt,
  activeLeases: NonNegativeInt,
  failures: NonNegativeInt,
  classes: Schema.Array(ResourceClassDiagnostics).pipe(Schema.check(Schema.isMaxLength(10))),
})

/** Privacy-safe result of a policy-driven disposable-resource collection pass. */
export const ClearDisposableResourcesResult = Schema.Struct({
  collectedResources: NonNegativeInt,
  collectedBytes: NonNegativeInt,
  retainedLeasedResources: NonNegativeInt,
  retainedLeasedBytes: NonNegativeInt,
  diagnostics: ResourceDiagnostics,
})

/** Privacy-safe diagnostics for resources explicitly cataloged by Core. */
export type ResourceDiagnostics = typeof ResourceDiagnostics.Type

/** Privacy-safe result of a policy-driven disposable-resource collection pass. */
export type ClearDisposableResourcesResult = typeof ClearDisposableResourcesResult.Type
