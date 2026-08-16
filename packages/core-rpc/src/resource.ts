import { Schema } from "effect"

const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const ResourceDiagnosticClass = Schema.Literals([
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
const ResourceStateDiagnostics = Schema.Struct({
  writing: NonNegativeInt,
  ready: NonNegativeInt,
  collecting: NonNegativeInt,
  quarantined: NonNegativeInt,
  deletionFailed: NonNegativeInt,
  deleted: NonNegativeInt,
})
const ResourceClassDiagnostics = Schema.Struct({
  resourceClass: ResourceDiagnosticClass,
  bytes: NonNegativeInt,
  reservedBytes: NonNegativeInt,
  resources: NonNegativeInt,
  activeLeases: NonNegativeInt,
  failures: NonNegativeInt,
  states: ResourceStateDiagnostics,
})

/** Privacy-safe diagnostics returned by Core for explicitly cataloged resources. */
export const CoreResourceDiagnostics = Schema.Struct({
  bytes: NonNegativeInt,
  reservedBytes: NonNegativeInt,
  resources: NonNegativeInt,
  activeLeases: NonNegativeInt,
  failures: NonNegativeInt,
  classes: Schema.Array(ResourceClassDiagnostics).pipe(Schema.check(Schema.isMaxLength(10))),
})

/** Privacy-safe result of Core's policy-driven disposable-resource collection pass. */
export const CoreClearDisposableResourcesResult = Schema.Struct({
  collectedResources: NonNegativeInt,
  collectedBytes: NonNegativeInt,
  retainedLeasedResources: NonNegativeInt,
  retainedLeasedBytes: NonNegativeInt,
  diagnostics: CoreResourceDiagnostics,
})

/** Privacy-safe diagnostics returned by Core for explicitly cataloged resources. */
export type CoreResourceDiagnostics = typeof CoreResourceDiagnostics.Type

/** Privacy-safe result of Core's policy-driven disposable-resource collection pass. */
export type CoreClearDisposableResourcesResult = typeof CoreClearDisposableResourcesResult.Type
