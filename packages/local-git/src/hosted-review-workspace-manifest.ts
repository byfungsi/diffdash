import { randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"

import { Effect, Exit, Predicate, Schema } from "effect"

import { withFileLock } from "./hosted-review-workspace-file-lock"
import {
  HostedReviewWorkspacePoolError,
  isNodeError,
  poolError,
} from "./hosted-review-workspace-pool-error"
import {
  type ManagedWorkspaceFilesystem,
  type ManagedWorkspacePath,
  pathForRepository,
  pathForSlot,
  validateManagedPathSegment,
} from "./hosted-review-workspace-paths"

const MANIFEST_VERSION = 2

const WorktreeLease = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  instanceId: Schema.String,
  pid: Schema.Number,
  acquiredAt: Schema.String,
})

const WorktreeSlot = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  repositoryKey: Schema.String,
  state: Schema.Literal("preparing", "leased", "cleaning", "available", "quarantined"),
  headSha: Schema.NullOr(Schema.String),
  reviewNumber: Schema.NullOr(Schema.Number),
  lastThreadId: Schema.NullOr(Schema.String),
  lease: Schema.NullOr(WorktreeLease),
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
  lastError: Schema.NullOr(Schema.String),
})

const RemoteRepository = Schema.Struct({
  providerId: Schema.String,
  repositoryKey: Schema.String,
  clonedAt: Schema.String,
  lastUsedAt: Schema.String,
})

const WorktreeManifest = Schema.Struct({
  version: Schema.Literal(MANIFEST_VERSION),
  repositories: Schema.Array(RemoteRepository),
  slots: Schema.Array(WorktreeSlot),
})

/** Validated version-2 workspace-pool manifest state. */
export type Manifest = typeof WorktreeManifest.Type

/** One validated slot stored in the workspace-pool manifest. */
export type Slot = typeof WorktreeSlot.Type

/** Serializes a read-change-atomic-write manifest transaction behind the pool lock. */
export const mutateManifest = <A>(
  filesystem: ManagedWorkspaceFilesystem,
  change: (manifest: Manifest) => { readonly manifest: Manifest; readonly value: A },
): Effect.Effect<A, HostedReviewWorkspacePoolError> => {
  const lockPath = filesystem.path("manifest.lock")
  const manifestPath = filesystem.path("manifest.json")

  return withFileLock(filesystem, lockPath, () =>
    Effect.gen(function* () {
      const manifest = yield* readManifest(filesystem, manifestPath)
      const changed = yield* Effect.try({
        try: () => change(manifest),
        catch: (cause) =>
          cause instanceof HostedReviewWorkspacePoolError
            ? cause
            : poolError(
                "manifest",
                "manifest.change",
                "Could not update the worktree pool manifest.",
                cause,
              ),
      })
      yield* validateManifestPaths(filesystem, changed.manifest)
      yield* writeManifest(filesystem, manifestPath, {
        ...changed.manifest,
        version: MANIFEST_VERSION,
      })
      return changed.value
    }),
  )
}

/** Applies an immutable update to a slot when it is present in the manifest. */
export const updateSlot = (
  manifest: Manifest,
  slotId: string,
  update: (slot: Slot) => Slot,
): Manifest => ({
  ...manifest,
  slots: manifest.slots.map((slot) => (slot.id === slotId ? update(slot) : slot)),
})

const readManifest = (
  filesystem: ManagedWorkspaceFilesystem,
  manifestPath: ManagedWorkspacePath,
): Effect.Effect<Manifest, HostedReviewWorkspacePoolError> =>
  Effect.gen(function* () {
    yield* filesystem.validate(manifestPath, "manifest.read.path")
    const contents = yield* Effect.tryPromise({
      try: () => readFile(manifestPath, "utf8"),
      catch: (cause) =>
        poolError(
          "manifest",
          "manifest.read",
          "DiffDash could not read its isolated worktree manifest.",
          cause,
        ),
    }).pipe(
      Effect.catchAll((cause) =>
        isNodeError(cause.cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(cause),
      ),
    )
    if (contents === null) {
      return { version: MANIFEST_VERSION, repositories: [], slots: [] }
    }

    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        poolError(
          "manifest",
          "manifest.read",
          "DiffDash could not parse its isolated worktree manifest.",
          cause,
        ),
    })
    if (Predicate.isReadonlyRecord(parsed) && parsed.version === 1) {
      yield* filesystem.remove(filesystem.path("repositories"), "manifest.invalidateV1")
      return { version: MANIFEST_VERSION, repositories: [], slots: [] }
    }

    const manifest = yield* Schema.decodeUnknown(WorktreeManifest)(parsed).pipe(
      Effect.mapError((cause) =>
        poolError(
          "manifest",
          "manifest.read",
          "DiffDash could not validate its isolated worktree manifest.",
          cause,
        ),
      ),
    )
    yield* validateManifestPaths(filesystem, manifest)
    return manifest
  })

const writeManifest = (
  filesystem: ManagedWorkspaceFilesystem,
  manifestPath: ManagedWorkspacePath,
  manifest: Manifest,
) => {
  const temporaryPath = filesystem.sibling(manifestPath, `manifest.json.${randomUUID()}.tmp`)
  const write = Effect.gen(function* () {
    yield* filesystem.validate(manifestPath, "manifest.write.destination")
    yield* filesystem.validate(temporaryPath, "manifest.write.temporary")
    yield* Effect.tryPromise({
      try: () =>
        writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        }),
      catch: (cause) =>
        poolError(
          "manifest",
          "manifest.write",
          "DiffDash could not update its isolated workspace files.",
          cause,
        ),
    })
    yield* filesystem.validate(temporaryPath, "manifest.rename.temporary")
    yield* filesystem.validate(manifestPath, "manifest.rename.destination")
    yield* Effect.tryPromise({
      try: () => rename(temporaryPath, manifestPath),
      catch: (cause) =>
        poolError(
          "manifest",
          "manifest.rename",
          "DiffDash could not atomically replace its workspace manifest.",
          cause,
        ),
    })
  })

  return Effect.uninterruptibleMask((restore) =>
    completeWithFinalizer(
      restore(write),
      filesystem.remove(temporaryPath, "manifest.temporary.cleanup"),
    ),
  )
}

const validateManifestPaths = (
  filesystem: ManagedWorkspaceFilesystem,
  manifest: Manifest,
): Effect.Effect<void, HostedReviewWorkspacePoolError> =>
  Effect.gen(function* () {
    for (const repository of manifest.repositories) {
      const repositoryPath = yield* deriveManifestPath(() =>
        pathForRepository(filesystem, repository.repositoryKey),
      )
      yield* filesystem.validate(repositoryPath, "manifest.repository.path")
    }
    for (const slot of manifest.slots) {
      const paths = yield* deriveManifestPath(() => {
        validateManagedPathSegment(slot.id)
        return {
          repository: pathForRepository(filesystem, slot.repositoryKey),
          slot: pathForSlot(filesystem, slot),
        }
      })
      yield* filesystem.validate(paths.repository, "manifest.slot.repositoryPath")
      yield* filesystem.validate(paths.slot, "manifest.slot.path")
    }
  })

const deriveManifestPath = <A>(derive: () => A) =>
  Effect.try({
    try: derive,
    catch: (cause) =>
      cause instanceof HostedReviewWorkspacePoolError
        ? cause
        : poolError(
            "manifest",
            "manifest.path",
            "DiffDash could not validate a path from its workspace manifest.",
            cause,
          ),
  })

const completeWithFinalizer = <A, E, R, E2, R2>(
  effect: Effect.Effect<A, E, R>,
  finalizer: Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.gen(function* () {
    const effectExit = yield* Effect.exit(effect)
    const finalizerExit = yield* Effect.exit(finalizer)
    if (Exit.isFailure(finalizerExit)) return yield* Effect.failCause(finalizerExit.cause)
    if (Exit.isFailure(effectExit)) return yield* Effect.failCause(effectExit.cause)
    return effectExit.value
  })
