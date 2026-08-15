import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { type Database, type DatabaseRow, makeDatabase, toError } from "./database"

const BoundedId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
)
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** Stable identity of a cataloged resource. */
export const CatalogResourceId = BoundedId.pipe(Schema.brand("CatalogResourceId"))
/** Stable identity of a cataloged resource. */
export type CatalogResourceId = typeof CatalogResourceId.Type

/** Stable identity of a filesystem root registered with the catalog. */
export const ResourceRootId = BoundedId.pipe(Schema.brand("ResourceRootId"))
/** Stable identity of a filesystem root registered with the catalog. */
export type ResourceRootId = typeof ResourceRootId.Type

/** Stable identity of a resource lease. */
export const ResourceLeaseId = BoundedId.pipe(Schema.brand("ResourceLeaseId"))
/** Stable identity of a resource lease. */
export type ResourceLeaseId = typeof ResourceLeaseId.Type

/** Stable identity of a reserve-ahead allocation. */
export const ResourceReservationId = BoundedId.pipe(Schema.brand("ResourceReservationId"))
/** Stable identity of a reserve-ahead allocation. */
export type ResourceReservationId = typeof ResourceReservationId.Type

/** Opaque identity persisted before an external collection mutation begins. */
export const ResourceRecoveryToken = BoundedId.pipe(Schema.brand("ResourceRecoveryToken"))
/** Opaque identity persisted before an external collection mutation begins. */
export type ResourceRecoveryToken = typeof ResourceRecoveryToken.Type

/** Resource lifecycle state persisted by the catalog. */
export const CatalogResourceState = Schema.Literals([
  "writing",
  "ready",
  "collecting",
  "quarantined",
  "deletionFailed",
  "deleted",
])
/** Resource lifecycle state persisted by the catalog. */
export type CatalogResourceState = typeof CatalogResourceState.Type

/** Collection policy class; durable user data cannot enter collectible states. */
export const CatalogPolicyClass = Schema.Literals([
  "durableUserData",
  "cache",
  "temporary",
  "migrationBackup",
])
/** Collection policy class; durable user data cannot enter collectible states. */
export type CatalogPolicyClass = typeof CatalogPolicyClass.Type

/** Registered-root-relative filesystem location. */
export const FilesystemResourceLocation = Schema.Struct({
  kind: Schema.Literal("filesystem"),
  rootId: ResourceRootId,
  relativePath: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4096)),
  ),
})

/** Adapter-owned logical Git reference location. */
export const GitRefResourceLocation = Schema.Struct({
  kind: Schema.Literal("gitRef"),
  identity: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4096)),
  ),
})

/** Adapter-owned updater partial location. */
export const UpdaterPartialResourceLocation = Schema.Struct({
  kind: Schema.Literal("updaterPartial"),
  identity: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4096)),
  ),
})

/** Typed location resolved only by its owning resource adapter. */
export const CatalogResourceLocation = Schema.Union([
  FilesystemResourceLocation,
  GitRefResourceLocation,
  UpdaterPartialResourceLocation,
])
/** Typed location resolved only by its owning resource adapter. */
export type CatalogResourceLocation = typeof CatalogResourceLocation.Type

/** Filesystem root registration returned from SQLite. */
export const ResourceRoot = Schema.Struct({
  id: ResourceRootId,
  path: Schema.String,
  createdAtMs: NonNegativeInt,
})
/** Filesystem root registration returned from SQLite. */
export type ResourceRoot = typeof ResourceRoot.Type

/** Exact process ownership carried by a lease. */
export const CatalogResourceLease = Schema.Struct({
  id: ResourceLeaseId,
  resourceId: CatalogResourceId,
  ownerKind: Schema.String,
  ownerId: Schema.String,
  applicationInstanceId: Schema.String,
  processEpoch: Schema.String,
  acquiredAtMs: NonNegativeInt,
  renewedAtMs: NonNegativeInt,
  expiresAtMs: PositiveInt,
  purpose: Schema.String,
})
/** Exact process ownership carried by a lease. */
export type CatalogResourceLease = typeof CatalogResourceLease.Type

/** Parsed resource record returned by the catalog. */
export const CatalogResource = Schema.Struct({
  id: CatalogResourceId,
  parentId: Schema.NullOr(CatalogResourceId),
  kind: Schema.String,
  policyClass: CatalogPolicyClass,
  state: CatalogResourceState,
  generation: PositiveInt,
  location: CatalogResourceLocation,
  bytes: NonNegativeInt,
  reservedBytes: NonNegativeInt,
  createdAtMs: NonNegativeInt,
  updatedAtMs: NonNegativeInt,
  lastUsedAtMs: NonNegativeInt,
  checksum: Schema.NullOr(Schema.String),
  validation: Schema.NullOr(Schema.String),
  recoveryToken: Schema.NullOr(ResourceRecoveryToken),
  failure: Schema.NullOr(Schema.String),
  retryAtMs: Schema.NullOr(NonNegativeInt),
  leases: Schema.Array(CatalogResourceLease),
})
/** Parsed resource record returned by the catalog. */
export type CatalogResource = typeof CatalogResource.Type

/** Input for registering a resource before writing or adopting it. */
export interface RegisterResourceInput {
  readonly id: CatalogResourceId
  readonly parentId: CatalogResourceId | null
  readonly kind: string
  readonly policyClass: CatalogPolicyClass
  readonly state: "writing" | "ready"
  readonly generation: number
  readonly location: CatalogResourceLocation
  readonly bytes: number
  readonly nowMs: number
  readonly checksum: string | null
  readonly validation: string | null
}

/** Result of an atomic reserve-ahead attempt. */
export type ReserveResourceResult =
  | { readonly kind: "reserved"; readonly resource: CatalogResource }
  | {
      readonly kind: "quotaExceeded"
      readonly requiredBytes: number
      readonly availableBytes: number
    }

const ResourceRow = Schema.Struct({
  id: CatalogResourceId,
  parent_id: Schema.NullOr(CatalogResourceId),
  kind: Schema.String,
  policy_class: CatalogPolicyClass,
  state: CatalogResourceState,
  generation: PositiveInt,
  location_kind: Schema.Literals(["filesystem", "gitRef", "updaterPartial"]),
  root_id: Schema.NullOr(ResourceRootId),
  location_value: Schema.String,
  bytes: NonNegativeInt,
  reserved_bytes: NonNegativeInt,
  created_at_ms: NonNegativeInt,
  updated_at_ms: NonNegativeInt,
  last_used_at_ms: NonNegativeInt,
  checksum: Schema.NullOr(Schema.String),
  validation: Schema.NullOr(Schema.String),
  recovery_token: Schema.NullOr(ResourceRecoveryToken),
  failure: Schema.NullOr(Schema.String),
  retry_at_ms: Schema.NullOr(NonNegativeInt),
})
const ResourceRows = Schema.Array(ResourceRow)
const LeaseRow = Schema.Struct({
  id: ResourceLeaseId,
  resource_id: CatalogResourceId,
  owner_kind: Schema.String,
  owner_id: Schema.String,
  application_instance_id: Schema.String,
  process_epoch: Schema.String,
  acquired_at_ms: NonNegativeInt,
  renewed_at_ms: NonNegativeInt,
  expires_at_ms: PositiveInt,
  purpose: Schema.String,
})
const LeaseRows = Schema.Array(LeaseRow)
const RootRow = Schema.Struct({
  id: ResourceRootId,
  path: Schema.String,
  created_at_ms: NonNegativeInt,
})
const UsageRow = Schema.Struct({ usage: Schema.Number })
const ReservationRow = Schema.Struct({
  resource_id: CatalogResourceId,
  bytes: PositiveInt,
  state: Schema.Literals(["active", "consumed", "expired"]),
})

const ResourceCatalogOperation = Schema.Literals([
  "registerRoot",
  "register",
  "get",
  "list",
  "reserve",
  "commitReservation",
  "expireReservations",
  "acquireLease",
  "renewLease",
  "releaseLease",
  "expireOwnership",
  "rebindLease",
  "beginCollection",
  "quarantine",
  "completeDeletion",
  "failDeletion",
])
type ResourceCatalogOperation = typeof ResourceCatalogOperation.Type

/** Typed catalog persistence or lifecycle-transition failure. */
export class ResourceCatalogError extends Schema.TaggedError<ResourceCatalogError>()(
  "ResourceCatalogError",
  { operation: ResourceCatalogOperation, cause: Schema.ErrorInstance() },
) {}

/** Durable SQLite authority for managed resource records, leases, and reservations. */
export class ResourceCatalog extends Context.Service<
  ResourceCatalog,
  {
    readonly registerRoot: (root: ResourceRoot) => Effect.Effect<void, ResourceCatalogError>
    readonly register: (
      input: RegisterResourceInput,
    ) => Effect.Effect<CatalogResource, ResourceCatalogError>
    readonly get: (id: CatalogResourceId) => Effect.Effect<CatalogResource, ResourceCatalogError>
    readonly list: () => Effect.Effect<readonly CatalogResource[], ResourceCatalogError>
    readonly reserve: (input: {
      readonly id: ResourceReservationId
      readonly resourceId: CatalogResourceId
      readonly bytes: number
      readonly nowMs: number
      readonly expiresAtMs: number
      readonly quotaBytes: number
    }) => Effect.Effect<ReserveResourceResult, ResourceCatalogError>
    readonly commitReservation: (input: {
      readonly id: ResourceReservationId
      readonly actualBytes: number
      readonly nowMs: number
    }) => Effect.Effect<CatalogResource, ResourceCatalogError>
    readonly expireReservations: (nowMs: number) => Effect.Effect<void, ResourceCatalogError>
    readonly acquireLease: (
      lease: CatalogResourceLease,
    ) => Effect.Effect<void, ResourceCatalogError>
    readonly renewLease: (input: {
      readonly id: ResourceLeaseId
      readonly applicationInstanceId: string
      readonly processEpoch: string
      readonly renewedAtMs: number
      readonly expiresAtMs: number
    }) => Effect.Effect<void, ResourceCatalogError>
    readonly releaseLease: (input: {
      readonly id: ResourceLeaseId
      readonly applicationInstanceId: string
      readonly processEpoch: string
    }) => Effect.Effect<void, ResourceCatalogError>
    readonly expireOwnership: (input: {
      readonly applicationInstanceId: string
      readonly processEpoch: string
    }) => Effect.Effect<void, ResourceCatalogError>
    readonly rebindLease: (input: {
      readonly id: ResourceLeaseId
      readonly applicationInstanceId: string
      readonly processEpoch: string
      readonly renewedAtMs: number
      readonly expiresAtMs: number
    }) => Effect.Effect<void, ResourceCatalogError>
    readonly beginCollection: (input: {
      readonly resourceId: CatalogResourceId
      readonly recoveryToken: ResourceRecoveryToken
      readonly nowMs: number
    }) => Effect.Effect<CatalogResource, ResourceCatalogError>
    readonly quarantine: (input: {
      readonly resourceId: CatalogResourceId
      readonly recoveryToken: ResourceRecoveryToken
      readonly nowMs: number
    }) => Effect.Effect<CatalogResource, ResourceCatalogError>
    readonly completeDeletion: (input: {
      readonly resourceId: CatalogResourceId
      readonly recoveryToken: ResourceRecoveryToken
      readonly nowMs: number
    }) => Effect.Effect<CatalogResource, ResourceCatalogError>
    readonly failDeletion: (input: {
      readonly resourceId: CatalogResourceId
      readonly recoveryToken: ResourceRecoveryToken
      readonly failure: string
      readonly retryAtMs: number
      readonly nowMs: number
    }) => Effect.Effect<CatalogResource, ResourceCatalogError>
  }
>()("@diffdash/ResourceCatalog") {
  /** Production catalog backed by the configured generic SQLite client. */
  static readonly layer = Layer.effect(
    ResourceCatalog,
    Effect.gen(function* () {
      const database = makeDatabase(yield* SqlClient.SqlClient)
      const get = makeGet(database)
      const transition = (
        operation: ResourceCatalogOperation,
        statement: string,
        params: ReadonlyArray<string | number | null>,
        id: CatalogResourceId,
      ) =>
        database
          .transaction(database.run(statement, params).pipe(Effect.andThen(get(id))))
          .pipe(Effect.mapError((cause) => catalogError(operation, cause)))

      return ResourceCatalog.of({
        registerRoot: Effect.fn("ResourceCatalog.registerRoot")(function (root) {
          return database
            .transaction(
              Effect.gen(function* () {
                yield* database.run(
                  `INSERT INTO resource_roots (id, path, created_at_ms) VALUES (?, ?, ?)
                   ON CONFLICT(id) DO NOTHING`,
                  [root.id, root.path, root.createdAtMs],
                )
                const persisted = yield* database.get("SELECT * FROM resource_roots WHERE id = ?", [
                  root.id,
                ])
                const decoded = yield* decodeRequired(
                  RootRow,
                  persisted,
                  `resource root ${root.id}`,
                )
                if (decoded.path !== root.path) {
                  return yield* Effect.fail(
                    new Error("A registered resource root cannot be rebound to another path"),
                  )
                }
              }),
            )
            .pipe(Effect.mapError((cause) => catalogError("registerRoot", cause)))
        }),
        register: Effect.fn("ResourceCatalog.register")(function (input) {
          const rootId = input.location.kind === "filesystem" ? input.location.rootId : null
          const value =
            input.location.kind === "filesystem"
              ? input.location.relativePath
              : input.location.identity
          return database
            .transaction(
              database
                .run(
                  `INSERT INTO resources (
                    id, parent_id, kind, policy_class, state, generation, location_kind, root_id,
                    location_value, bytes, created_at_ms, updated_at_ms, last_used_at_ms,
                    checksum, validation
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    input.id,
                    input.parentId,
                    input.kind,
                    input.policyClass,
                    input.state,
                    input.generation,
                    input.location.kind,
                    rootId,
                    value,
                    input.bytes,
                    input.nowMs,
                    input.nowMs,
                    input.nowMs,
                    input.checksum,
                    input.validation,
                  ],
                )
                .pipe(Effect.andThen(get(input.id))),
            )
            .pipe(Effect.mapError((cause) => catalogError("register", cause)))
        }),
        get,
        list: Effect.fn("ResourceCatalog.list")(function () {
          return loadResources(database).pipe(
            Effect.mapError((cause) => catalogError("list", cause)),
          )
        }),
        reserve: Effect.fn("ResourceCatalog.reserve")(function (input) {
          return database
            .transaction(
              Effect.gen(function* () {
                const resource = yield* get(input.resourceId)
                if (resource.policyClass === "durableUserData" || resource.state !== "writing") {
                  return yield* Effect.fail(
                    new Error("Reservations require a disposable resource in writing state"),
                  )
                }
                const usageRow = yield* database.get(
                  `SELECT COALESCE(SUM(bytes + reserved_bytes), 0) AS usage
                   FROM resources WHERE policy_class <> 'durableUserData' AND state <> 'deleted'`,
                )
                const usage = yield* decodeRequired(UsageRow, usageRow, "resource usage")
                const availableBytes = Math.max(0, input.quotaBytes - usage.usage)
                if (input.bytes > availableBytes)
                  return {
                    kind: "quotaExceeded",
                    requiredBytes: input.bytes,
                    availableBytes,
                  } as const
                yield* database.run(
                  `INSERT INTO resource_reservations
                   (id, resource_id, bytes, state, created_at_ms, expires_at_ms)
                   VALUES (?, ?, ?, 'active', ?, ?)`,
                  [input.id, input.resourceId, input.bytes, input.nowMs, input.expiresAtMs],
                )
                yield* database.run(
                  `UPDATE resources SET reserved_bytes = reserved_bytes + ?, updated_at_ms = ?
                   WHERE id = ? AND policy_class <> 'durableUserData' AND state = 'writing'`,
                  [input.bytes, input.nowMs, input.resourceId],
                )
                return { kind: "reserved", resource: yield* get(input.resourceId) } as const
              }),
            )
            .pipe(Effect.mapError((cause) => catalogError("reserve", cause)))
        }),
        commitReservation: Effect.fn("ResourceCatalog.commitReservation")(function (input) {
          return database
            .transaction(
              Effect.gen(function* () {
                const row = yield* database.get(
                  "SELECT resource_id, bytes, state FROM resource_reservations WHERE id = ?",
                  [input.id],
                )
                const reservation = yield* decodeRequired(
                  ReservationRow,
                  row,
                  "resource reservation",
                )
                if (reservation.state !== "active" || input.actualBytes > reservation.bytes)
                  return yield* Effect.fail(
                    new Error("Reservation is inactive or smaller than actual bytes"),
                  )
                yield* database.run(
                  `UPDATE resource_reservations SET state = 'consumed', consumed_at_ms = ? WHERE id = ?`,
                  [input.nowMs, input.id],
                )
                yield* database.run(
                  `UPDATE resources SET bytes = bytes + ?, reserved_bytes = reserved_bytes - ?,
                     updated_at_ms = ?, last_used_at_ms = ? WHERE id = ?`,
                  [
                    input.actualBytes,
                    reservation.bytes,
                    input.nowMs,
                    input.nowMs,
                    reservation.resource_id,
                  ],
                )
                return yield* get(reservation.resource_id)
              }),
            )
            .pipe(Effect.mapError((cause) => catalogError("commitReservation", cause)))
        }),
        expireReservations: Effect.fn("ResourceCatalog.expireReservations")(function (nowMs) {
          return database
            .transaction(
              Effect.gen(function* () {
                yield* database.run(
                  `UPDATE resources SET reserved_bytes = reserved_bytes - COALESCE((
                     SELECT SUM(bytes) FROM resource_reservations
                     WHERE resource_id = resources.id AND state = 'active' AND expires_at_ms <= ?
                   ), 0), updated_at_ms = ?
                   WHERE EXISTS (
                     SELECT 1 FROM resource_reservations
                     WHERE resource_id = resources.id AND state = 'active' AND expires_at_ms <= ?
                   )`,
                  [nowMs, nowMs, nowMs],
                )
                yield* database.run(
                  `UPDATE resource_reservations SET state = 'expired'
                   WHERE state = 'active' AND expires_at_ms <= ?`,
                  [nowMs],
                )
              }),
            )
            .pipe(Effect.mapError((cause) => catalogError("expireReservations", cause)))
        }),
        acquireLease: Effect.fn("ResourceCatalog.acquireLease")(function (lease) {
          return database
            .run(
              `INSERT INTO resource_leases (
                id, resource_id, owner_kind, owner_id, application_instance_id, process_epoch,
                acquired_at_ms, renewed_at_ms, expires_at_ms, purpose
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                lease.id,
                lease.resourceId,
                lease.ownerKind,
                lease.ownerId,
                lease.applicationInstanceId,
                lease.processEpoch,
                lease.acquiredAtMs,
                lease.renewedAtMs,
                lease.expiresAtMs,
                lease.purpose,
              ],
            )
            .pipe(Effect.mapError((cause) => catalogError("acquireLease", cause)))
        }),
        renewLease: Effect.fn("ResourceCatalog.renewLease")(function (input) {
          return database
            .run(
              `UPDATE resource_leases SET renewed_at_ms = ?, expires_at_ms = ?
               WHERE id = ? AND application_instance_id = ? AND process_epoch = ?`,
              [
                input.renewedAtMs,
                input.expiresAtMs,
                input.id,
                input.applicationInstanceId,
                input.processEpoch,
              ],
            )
            .pipe(Effect.mapError((cause) => catalogError("renewLease", cause)))
        }),
        releaseLease: Effect.fn("ResourceCatalog.releaseLease")(function (input) {
          return database
            .run(
              `DELETE FROM resource_leases
               WHERE id = ? AND application_instance_id = ? AND process_epoch = ?`,
              [input.id, input.applicationInstanceId, input.processEpoch],
            )
            .pipe(Effect.mapError((cause) => catalogError("releaseLease", cause)))
        }),
        expireOwnership: Effect.fn("ResourceCatalog.expireOwnership")(function (input) {
          return database
            .run(
              "DELETE FROM resource_leases WHERE application_instance_id = ? AND process_epoch = ?",
              [input.applicationInstanceId, input.processEpoch],
            )
            .pipe(Effect.mapError((cause) => catalogError("expireOwnership", cause)))
        }),
        rebindLease: Effect.fn("ResourceCatalog.rebindLease")(function (input) {
          return database
            .run(
              `UPDATE resource_leases SET application_instance_id = ?, process_epoch = ?,
                 renewed_at_ms = ?, expires_at_ms = ? WHERE id = ?`,
              [
                input.applicationInstanceId,
                input.processEpoch,
                input.renewedAtMs,
                input.expiresAtMs,
                input.id,
              ],
            )
            .pipe(Effect.mapError((cause) => catalogError("rebindLease", cause)))
        }),
        beginCollection: Effect.fn("ResourceCatalog.beginCollection")(function (input) {
          return transition(
            "beginCollection",
            `WITH RECURSIVE tree(id) AS (
               SELECT id FROM resources WHERE id = ?
               UNION ALL SELECT child.id FROM resources AS child INNER JOIN tree ON child.parent_id = tree.id
             )
             UPDATE resources SET state = 'collecting', recovery_token = ?, updated_at_ms = ?
             WHERE id = ? AND policy_class <> 'durableUserData'
               AND state IN ('ready', 'deletionFailed')
               AND NOT EXISTS (
                 SELECT 1 FROM resource_leases INNER JOIN tree ON tree.id = resource_leases.resource_id
                 WHERE resource_leases.expires_at_ms > ?
               )`,
            [input.resourceId, input.recoveryToken, input.nowMs, input.resourceId, input.nowMs],
            input.resourceId,
          ).pipe(
            Effect.flatMap((resource) =>
              resource.state === "collecting" && resource.recoveryToken === input.recoveryToken
                ? Effect.succeed(resource)
                : Effect.fail(
                    catalogError("beginCollection", new Error("Resource is not collectible")),
                  ),
            ),
          )
        }),
        quarantine: Effect.fn("ResourceCatalog.quarantine")(function (input) {
          return transition(
            "quarantine",
            `UPDATE resources SET state = 'quarantined', updated_at_ms = ?
             WHERE id = ? AND state IN ('collecting', 'quarantined', 'deletionFailed')
               AND recovery_token = ?`,
            [input.nowMs, input.resourceId, input.recoveryToken],
            input.resourceId,
          ).pipe(
            Effect.flatMap((resource) =>
              resource.state === "quarantined" && resource.recoveryToken === input.recoveryToken
                ? Effect.succeed(resource)
                : Effect.fail(
                    catalogError("quarantine", new Error("Collection token does not own resource")),
                  ),
            ),
          )
        }),
        completeDeletion: Effect.fn("ResourceCatalog.completeDeletion")(function (input) {
          return transition(
            "completeDeletion",
            `UPDATE resources SET state = 'deleted', bytes = 0, reserved_bytes = 0,
               recovery_token = NULL, failure = NULL, retry_at_ms = NULL, updated_at_ms = ?
             WHERE id = ? AND state IN ('quarantined', 'deletionFailed') AND recovery_token = ?`,
            [input.nowMs, input.resourceId, input.recoveryToken],
            input.resourceId,
          ).pipe(
            Effect.flatMap((resource) =>
              resource.state === "deleted" && resource.recoveryToken === null
                ? Effect.succeed(resource)
                : Effect.fail(
                    catalogError(
                      "completeDeletion",
                      new Error("Collection token does not own resource"),
                    ),
                  ),
            ),
          )
        }),
        failDeletion: Effect.fn("ResourceCatalog.failDeletion")(function (input) {
          return transition(
            "failDeletion",
            `UPDATE resources SET state = 'deletionFailed', failure = ?, retry_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND state IN ('collecting', 'quarantined', 'deletionFailed')
               AND recovery_token = ?`,
            [input.failure, input.retryAtMs, input.nowMs, input.resourceId, input.recoveryToken],
            input.resourceId,
          ).pipe(
            Effect.flatMap((resource) =>
              resource.state === "deletionFailed" &&
              resource.recoveryToken === input.recoveryToken &&
              resource.failure === input.failure &&
              resource.retryAtMs === input.retryAtMs
                ? Effect.succeed(resource)
                : Effect.fail(
                    catalogError(
                      "failDeletion",
                      new Error("Collection token does not own resource"),
                    ),
                  ),
            ),
          )
        }),
      })
    }),
  )
}

const catalogError = (operation: ResourceCatalogOperation, cause: Error): ResourceCatalogError =>
  ResourceCatalogError.make({ operation, cause: toError(cause) })

const makeGet = (database: Database) =>
  Effect.fn("ResourceCatalog.get")(function (id: CatalogResourceId) {
    return database.get("SELECT * FROM resources WHERE id = ?", [id]).pipe(
      Effect.flatMap((row) => decodeRequired(ResourceRow, row, `resource ${id}`)),
      Effect.flatMap((row) => makeResource(database, row)),
      Effect.mapError((cause) => catalogError("get", cause)),
    )
  })

const loadResources = Effect.fn("ResourceCatalog.loadResources")(function* (database: Database) {
  const rows = yield* database.all("SELECT * FROM resources ORDER BY id")
  const decoded = yield* Schema.decodeUnknownEffect(ResourceRows)(rows)
  return yield* Effect.forEach(decoded, (row) => makeResource(database, row))
})

const makeResource = Effect.fn("ResourceCatalog.makeResource")(function* (
  database: Database,
  row: typeof ResourceRow.Type,
) {
  const leaseRows = yield* database.all(
    "SELECT * FROM resource_leases WHERE resource_id = ? ORDER BY id",
    [row.id],
  )
  const leases = yield* Schema.decodeUnknownEffect(LeaseRows)(leaseRows)
  const location = yield* Schema.decodeUnknownEffect(CatalogResourceLocation)(
    row.location_kind === "filesystem"
      ? { kind: "filesystem", rootId: row.root_id, relativePath: row.location_value }
      : { kind: row.location_kind, identity: row.location_value },
  )
  return yield* Schema.decodeUnknownEffect(CatalogResource)({
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    policyClass: row.policy_class,
    state: row.state,
    generation: row.generation,
    location,
    bytes: row.bytes,
    reservedBytes: row.reserved_bytes,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    lastUsedAtMs: row.last_used_at_ms,
    checksum: row.checksum,
    validation: row.validation,
    recoveryToken: row.recovery_token,
    failure: row.failure,
    retryAtMs: row.retry_at_ms,
    leases: leases.map((lease) => ({
      id: lease.id,
      resourceId: lease.resource_id,
      ownerKind: lease.owner_kind,
      ownerId: lease.owner_id,
      applicationInstanceId: lease.application_instance_id,
      processEpoch: lease.process_epoch,
      acquiredAtMs: lease.acquired_at_ms,
      renewedAtMs: lease.renewed_at_ms,
      expiresAtMs: lease.expires_at_ms,
      purpose: lease.purpose,
    })),
  })
})

const decodeRequired = <S extends Schema.Constraint>(
  schema: S,
  row: Option.Option<DatabaseRow>,
  description: string,
) =>
  Effect.fromOption(row, () => new Error(`Missing ${description}`)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  )
