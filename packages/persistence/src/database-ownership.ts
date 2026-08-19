import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { Effect, Schema } from "effect"

import { toError } from "./database"

const OwnerRecord = Schema.Struct({
  applicationInstance: Schema.NonEmptyString,
  processEpoch: Schema.NonEmptyString,
  pid: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  processStartIdentity: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u))),
})

const FileSystemError = Schema.Struct({ code: Schema.String })

/** Exact identity persisted for a process that owns or contends for a database. */
export type DatabaseOwner = typeof OwnerRecord.Type

/** Result of comparing a recorded PID and process-start identity with the operating system. */
export type DatabaseOwnerStatus = "alive" | "dead" | "uncertain"

/** Inspects the exact process represented by an ownership record. */
export interface DatabaseOwnerInspector {
  readonly inspect: (owner: DatabaseOwner) => Effect.Effect<DatabaseOwnerStatus>
}

/** Configuration for acquiring exclusive ownership of one product database. */
export interface DatabaseOwnershipOptions {
  readonly databasePath: string
  readonly owner: DatabaseOwner
  readonly inspector: DatabaseOwnerInspector
}

/** Another exact process identity currently owns the database. */
export class DatabaseOwnershipHeld extends Schema.TaggedError<DatabaseOwnershipHeld>()(
  "DatabaseOwnershipHeld",
  { owner: OwnerRecord },
) {}

/** Ownership could not be decided safely, so acquisition was denied. */
export class DatabaseOwnershipUncertain extends Schema.TaggedError<DatabaseOwnershipUncertain>()(
  "DatabaseOwnershipUncertain",
  { owner: OwnerRecord },
) {}

/** A sidecar ownership record was missing, malformed, or changed unexpectedly. */
export class DatabaseOwnershipRecordError extends Schema.TaggedError<DatabaseOwnershipRecordError>()(
  "DatabaseOwnershipRecordError",
  { message: Schema.String, cause: Schema.ErrorInstance() },
) {}

/** A filesystem operation required by the ownership protocol failed. */
export class DatabaseOwnershipIoError extends Schema.TaggedError<DatabaseOwnershipIoError>()(
  "DatabaseOwnershipIoError",
  { operation: Schema.String, cause: Schema.ErrorInstance() },
) {}

/** Expected failures returned by database ownership acquisition and release. */
export type DatabaseOwnershipError =
  | DatabaseOwnershipHeld
  | DatabaseOwnershipUncertain
  | DatabaseOwnershipRecordError
  | DatabaseOwnershipIoError

/** A successfully acquired ownership lease, releasable only by its exact nonce. */
export interface DatabaseOwnershipLease {
  readonly owner: DatabaseOwner
  readonly release: () => Effect.Effect<void, DatabaseOwnershipError>
}

interface OwnershipPaths {
  readonly owner: string
  readonly gate: string
  readonly claim: string
}

const decodeOwner = Schema.decodeUnknownSync(OwnerRecord)

/**
 * Atomically acquires cross-runtime database ownership.
 *
 * Stale records are replaced only when `inspector` proves the complete recorded process identity
 * dead. A reused PID whose start identity differs must therefore be reported as `dead`.
 */
export const acquireDatabaseOwnership = Effect.fn("DatabaseOwnership.acquire")(function* (
  options: DatabaseOwnershipOptions,
): Effect.fn.Return<DatabaseOwnershipLease, DatabaseOwnershipError> {
  const contender = yield* parseOwner(options.owner)
  const paths = makePaths(options.databasePath, contender.nonce)
  yield* writeClaim(paths.claim, contender)
  const gateAcquired = yield* acquireGate(paths, contender, options.inspector).pipe(
    Effect.onError(() => removeClaim(paths.claim)),
  )
  if (!gateAcquired) {
    yield* removeClaim(paths.claim)
    return yield* new DatabaseOwnershipRecordError({
      message: "Database ownership gate acquisition ended without owning the gate.",
      cause: new Error("Ownership gate invariant failed"),
    })
  }

  const acquired = yield* acquireOwner(paths, contender, options.inspector).pipe(
    Effect.ensuring(releaseGate(paths.gate).pipe(Effect.orDie)),
    Effect.onError(() => removeClaim(paths.claim)),
  )
  yield* removeClaim(paths.claim)
  if (!acquired) {
    return yield* new DatabaseOwnershipRecordError({
      message: "Database ownership acquisition ended without installing the owner record.",
      cause: new Error("Ownership record invariant failed"),
    })
  }

  return {
    owner: contender,
    release: () => releaseOwnership({ ...options, owner: contender }),
  }
})

const releaseOwnership = Effect.fn("DatabaseOwnership.release")(function* (
  options: DatabaseOwnershipOptions,
): Effect.fn.Return<void, DatabaseOwnershipError> {
  const paths = makePaths(options.databasePath, `${options.owner.nonce}-release`)
  yield* writeClaim(paths.claim, options.owner)
  yield* acquireGate(paths, options.owner, options.inspector).pipe(
    Effect.onError(() => removeClaim(paths.claim)),
  )
  yield* Effect.gen(function* () {
    const current = yield* readOwner(paths.owner)
    if (!sameOwner(current, options.owner)) {
      return yield* new DatabaseOwnershipRecordError({
        message: "Database ownership release was denied because the owner record changed.",
        cause: new Error("Ownership nonce mismatch"),
      })
    }
    yield* unlink(paths.owner, "releaseOwner")
    return yield* syncParent(paths.owner)
  }).pipe(
    Effect.ensuring(releaseGate(paths.gate).pipe(Effect.orDie)),
    Effect.ensuring(removeClaim(paths.claim)),
  )
})

const acquireOwner = Effect.fn("DatabaseOwnership.acquireOwner")(function* (
  paths: OwnershipPaths,
  contender: DatabaseOwner,
  inspector: DatabaseOwnerInspector,
) {
  const installed = yield* link(paths.claim, paths.owner, "installOwner")
  if (installed) {
    yield* syncParent(paths.owner)
    return true
  }

  const current = yield* readOwner(paths.owner)
  const status = yield* inspector.inspect(current)
  if (status === "alive") return yield* new DatabaseOwnershipHeld({ owner: current })
  if (status === "uncertain") return yield* new DatabaseOwnershipUncertain({ owner: current })

  yield* unlink(paths.owner, "removeStaleOwner")
  const recovered = yield* link(paths.claim, paths.owner, "installRecoveredOwner")
  if (!recovered) {
    return yield* new DatabaseOwnershipRecordError({
      message: "Database ownership changed while recovering a proven-dead owner.",
      cause: new Error("Owner path unexpectedly exists behind the ownership gate"),
    })
  }
  yield* syncParent(paths.owner)
  return true
})

const acquireGate = Effect.fn("DatabaseOwnership.acquireGate")(function* (
  paths: OwnershipPaths,
  contender: DatabaseOwner,
  inspector: DatabaseOwnerInspector,
) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (yield* link(paths.claim, paths.gate, "acquireGate")) return true
    const holder = yield* readOwner(paths.gate)
    if (sameOwner(holder, contender)) {
      return yield* new DatabaseOwnershipRecordError({
        message: "Database ownership gate is already held by this exact claim.",
        cause: new Error("Duplicate ownership operation"),
      })
    }
    const status = yield* inspector.inspect(holder)
    if (status === "alive") return yield* new DatabaseOwnershipHeld({ owner: holder })
    if (status === "uncertain") return yield* new DatabaseOwnershipUncertain({ owner: holder })
    const removed = yield* unlinkIfPresent(paths.gate, "removeStaleGate")
    if (removed) yield* syncParent(paths.gate)
  }
  return yield* new DatabaseOwnershipIoError({
    operation: "acquireGate",
    cause: new Error("Database ownership gate contention exceeded the bounded retry limit."),
  })
})

const makePaths = (databasePath: string, nonce: string): OwnershipPaths => ({
  owner: `${databasePath}.owner`,
  gate: `${databasePath}.owner-gate`,
  claim: `${databasePath}.owner-claim-${nonce}`,
})

const parseOwner = (owner: DatabaseOwner) =>
  Schema.decodeUnknownEffect(OwnerRecord)(owner).pipe(
    Effect.mapError(
      (cause) =>
        new DatabaseOwnershipRecordError({
          message: "Database owner identity did not satisfy the ownership record schema.",
          cause,
        }),
    ),
  )

const writeClaim = (path: string, owner: DatabaseOwner) =>
  Effect.try({
    try: () => {
      writeFileSync(path, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 })
      const descriptor = openSync(path, "r")
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    },
    catch: (cause) =>
      new DatabaseOwnershipIoError({ operation: "writeClaim", cause: toError(cause) }),
  })

const readOwner = (path: string) =>
  Effect.try({
    try: () => decodeOwner(JSON.parse(readFileSync(path, "utf8"))),
    catch: (cause) =>
      new DatabaseOwnershipRecordError({
        message: "Database ownership record could not be parsed safely.",
        cause: toError(cause),
      }),
  })

const link = (source: string, target: string, operation: string) =>
  Effect.try({
    try: () => {
      linkSync(source, target)
      return true
    },
    catch: (cause) => toError(cause),
  }).pipe(
    Effect.catch((cause) =>
      isAlreadyExists(cause)
        ? Effect.succeed(false)
        : Effect.fail(new DatabaseOwnershipIoError({ operation, cause })),
    ),
  )

const unlink = (path: string, operation: string) =>
  Effect.try({
    try: () => unlinkSync(path),
    catch: (cause) => new DatabaseOwnershipIoError({ operation, cause: toError(cause) }),
  })

const unlinkIfPresent = (path: string, operation: string) =>
  Effect.try({
    try: () => {
      unlinkSync(path)
      return true
    },
    catch: (cause) => toError(cause),
  }).pipe(
    Effect.catch((cause) =>
      isNotFound(cause)
        ? Effect.succeed(false)
        : Effect.fail(new DatabaseOwnershipIoError({ operation, cause })),
    ),
  )

const releaseGate = (path: string) =>
  Effect.sync(() => rmSync(path, { force: true })).pipe(Effect.andThen(syncParent(path)))

const removeClaim = (path: string) => Effect.sync(() => rmSync(path, { force: true }))

const syncParent = (path: string) =>
  Effect.try({
    try: () => {
      if (process.platform === "win32") return
      const descriptor = openSync(dirname(path), "r")
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    },
    catch: (cause) =>
      new DatabaseOwnershipIoError({ operation: "syncOwnershipDirectory", cause: toError(cause) }),
  })

const sameOwner = (left: DatabaseOwner, right: DatabaseOwner) =>
  left.applicationInstance === right.applicationInstance &&
  left.processEpoch === right.processEpoch &&
  left.pid === right.pid &&
  left.processStartIdentity === right.processStartIdentity &&
  left.nonce === right.nonce

const isAlreadyExists = (cause: Error) =>
  Schema.is(FileSystemError)(cause) && cause.code === "EEXIST"

const isNotFound = (cause: Error) => Schema.is(FileSystemError)(cause) && cause.code === "ENOENT"
