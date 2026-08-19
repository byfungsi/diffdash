import { randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"

import { Effect, Predicate, Schema } from "effect"

import { withFileLock } from "./hosted-review-workspace-file-lock"
import { completeWithFinalizer } from "./hosted-review-workspace-finalizer"
import {
  HostedReviewWorkspacePoolError,
  isNodeError,
  poolError,
  toError,
} from "./hosted-review-workspace-pool-error"
import {
  type ManagedWorkspaceFilesystem,
  type ManagedWorkspacePath,
  pathForRepository,
  pathForSlot,
  validateManagedPathSegment,
} from "./hosted-review-workspace-paths"

const MANIFEST_VERSION = 2
const JsonFromString = Schema.fromJsonString(Schema.Json)

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
  state: Schema.Literals(["preparing", "leased", "cleaning", "available", "quarantined"]),
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
export const mutateManifest = <A extends NonNullable<unknown>>(
  filesystem: ManagedWorkspaceFilesystem,
  change: (manifest: Manifest) => { readonly manifest: Manifest; readonly value: A },
): Effect.Effect<A, HostedReviewWorkspacePoolError> => runManifestTransaction(filesystem, change)

/** Applies a write-only manifest update behind the pool lock. */
export const updateManifest = (
  filesystem: ManagedWorkspaceFilesystem,
  update: (manifest: Manifest) => Manifest,
): Effect.Effect<void, HostedReviewWorkspacePoolError> =>
  runManifestTransaction(filesystem, (manifest) => ({
    manifest: update(manifest),
    value: undefined,
  }))

const runManifestTransaction = <A>(
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
          Schema.is(HostedReviewWorkspacePoolError)(cause)
            ? cause
            : poolError(
                "manifest",
                "manifest.change",
                "Could not update the worktree pool manifest.",
                toError(cause),
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
          toError(cause),
        ),
    }).pipe(
      Effect.catch((cause) =>
        isNodeError(cause.cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(cause),
      ),
    )
    if (contents === null) {
      return { version: MANIFEST_VERSION, repositories: [], slots: [] }
    }

    const parsed = yield* Schema.decodeUnknownEffect(JsonFromString)(contents).pipe(
      Effect.mapError((cause) =>
        poolError(
          "manifest",
          "manifest.read",
          "DiffDash could not parse its isolated worktree manifest.",
          toError(cause),
        ),
      ),
    )
    if (Predicate.isReadonlyObject(parsed) && parsed.version === 1) {
      yield* filesystem.remove(filesystem.path("repositories"), "manifest.invalidateV1")
      return { version: MANIFEST_VERSION, repositories: [], slots: [] }
    }

    const manifest = yield* Schema.decodeUnknownEffect(WorktreeManifest)(parsed).pipe(
      Effect.mapError((cause) =>
        poolError(
          "manifest",
          "manifest.read",
          "DiffDash could not validate its isolated worktree manifest.",
          toError(cause),
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
          toError(cause),
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
          toError(cause),
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
      Schema.is(HostedReviewWorkspacePoolError)(cause)
        ? cause
        : poolError(
            "manifest",
            "manifest.path",
            "DiffDash could not validate a path from its workspace manifest.",
            toError(cause),
          ),
  })
