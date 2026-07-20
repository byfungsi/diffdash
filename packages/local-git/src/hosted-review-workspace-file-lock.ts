import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, readFile, rm } from "node:fs/promises"

import { Clock, Effect, Either, Exit, Predicate, Schema } from "effect"

import { isNodeError, poolError } from "./hosted-review-workspace-pool-error"
import type {
  ManagedWorkspaceFilesystem,
  ManagedWorkspacePath,
} from "./hosted-review-workspace-paths"

const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 5_000
const CORRUPT_LOCK_STALE_MS = 5_000
const PROCESS_NONCE = randomUUID()

interface LockOwner {
  readonly token: string
  readonly processNonce: string
  readonly pid: number
  readonly createdAt: string
}

interface LockIdentity {
  readonly device: number
  readonly inode: number
  readonly modifiedAtMs: number
}

interface ObservedLock {
  readonly contents: string
  readonly identity: LockIdentity
  readonly owner: LockOwner | null
}

/** Replaceable low-level lock operations used to exercise publication failures and races. */
export interface FileLockOperations {
  readonly createClaim: (
    path: ManagedWorkspacePath,
    contents: string,
  ) => Effect.Effect<void, FileLockOperationError>
  readonly publish: (
    claimPath: ManagedWorkspacePath,
    lockPath: ManagedWorkspacePath,
  ) => Effect.Effect<void, FileLockOperationError>
  readonly read: (path: ManagedWorkspacePath) => Effect.Effect<string, FileLockOperationError>
  readonly identity: (
    path: ManagedWorkspacePath,
  ) => Effect.Effect<LockIdentity, FileLockOperationError>
  readonly remove: (path: ManagedWorkspacePath) => Effect.Effect<void, FileLockOperationError>
}

/** A raw filesystem failure raised by replaceable file-lock operations. */
export class FileLockOperationError extends Schema.TaggedError<FileLockOperationError>()(
  "FileLockOperationError",
  { cause: Schema.Defect },
) {}

/** The production Node filesystem implementation for file-lock operations. */
export const nodeFileLockOperations: FileLockOperations = {
  createClaim: (path, contents) =>
    Effect.tryPromise({
      try: async () => {
        let handle
        let created = false
        try {
          handle = await open(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          )
          created = true
          await handle.writeFile(contents)
          await handle.close()
          handle = undefined
        } catch (cause) {
          const cleanupFailures: unknown[] = []
          if (handle !== undefined) {
            try {
              await handle.close()
            } catch (closeCause) {
              cleanupFailures.push(closeCause)
            }
          }
          if (created) {
            try {
              await rm(path, { force: true })
            } catch (removeCause) {
              cleanupFailures.push(removeCause)
            }
          }
          if (cleanupFailures.length > 0) {
            // oxlint-disable-next-line eslint/preserve-caught-error -- The caught cause is the first aggregate member.
            throw new AggregateError(
              [cause, ...cleanupFailures],
              "Could not clean up a failed lock claim",
            )
          }
          throw cause
        }
      },
      catch: (cause) => FileLockOperationError.make({ cause }),
    }),
  publish: (claimPath, lockPath) =>
    Effect.tryPromise({
      try: () => link(claimPath, lockPath),
      catch: (cause) => FileLockOperationError.make({ cause }),
    }),
  read: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => FileLockOperationError.make({ cause }),
    }),
  identity: (path) =>
    Effect.tryPromise({
      try: async () => {
        const details = await lstat(path)
        return {
          device: details.dev,
          inode: details.ino,
          modifiedAtMs: details.mtimeMs,
        }
      },
      catch: (cause) => FileLockOperationError.make({ cause }),
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => FileLockOperationError.make({ cause }),
    }),
}

/** Builds a scoped file-lock operation around a replaceable low-level filesystem adapter. */
export const makeFileLock =
  (operations: FileLockOperations) =>
  <A, E, R>(
    filesystem: ManagedWorkspaceFilesystem,
    lockPath: ManagedWorkspacePath,
    use: () => Effect.Effect<A, E, R>,
    timeoutMs = LOCK_TIMEOUT_MS,
  ): Effect.Effect<A, E | ReturnType<typeof poolError>, R> =>
    validateTimeout(timeoutMs).pipe(
      Effect.zipRight(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(filesystem.ensureParent(lockPath, "lock.parent"))
            yield* restore(filesystem.validate(lockPath, "lock.path"))

            const token = randomUUID()
            const now = yield* Clock.currentTimeMillis
            const owner = {
              token,
              processNonce: PROCESS_NONCE,
              pid: process.pid,
              createdAt: new Date(now).toISOString(),
            } satisfies LockOwner
            const contents = JSON.stringify(owner)
            const claimPath = filesystem.sibling(
              lockPath,
              `${lockFileName(lockPath)}.${process.pid}.${PROCESS_NONCE}.${token}.claim`,
            )

            const lifecycle = restore(filesystem.validate(claimPath, "lock.claim.path")).pipe(
              Effect.zipRight(
                restore(
                  operations
                    .createClaim(claimPath, contents)
                    .pipe(Effect.mapError((cause) => lockError("lock.claim.write", cause.cause))),
                ),
              ),
              Effect.zipRight(restore(filesystem.validate(claimPath, "lock.claim.validate"))),
              Effect.flatMap(() =>
                restore(operationIdentity(operations, claimPath, "lock.claim.identity")),
              ),
              Effect.flatMap((claimIdentity) =>
                acquirePublishedLock(
                  operations,
                  filesystem,
                  claimPath,
                  lockPath,
                  timeoutMs,
                  restore,
                ).pipe(
                  Effect.zipRight(
                    completeWithFinalizer(
                      restore(use()),
                      releasePublishedLock(
                        operations,
                        filesystem,
                        lockPath,
                        claimIdentity,
                        contents,
                      ),
                    ),
                  ),
                ),
              ),
            )

            return yield* completeWithFinalizer(
              lifecycle,
              cleanupClaim(operations, filesystem, claimPath),
            )
          }),
        ),
      ),
    )

/** Runs an Effect while holding an interruptibly acquired, identity-owned file lock. */
export const withFileLock = makeFileLock(nodeFileLockOperations)

/** Checks whether a recorded lock or workspace-lease process can still be signaled. */
export const isProcessAlive = (pid: number | undefined) => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return isNodeError(cause, "EPERM")
  }
}

const acquirePublishedLock = (
  operations: FileLockOperations,
  filesystem: ManagedWorkspaceFilesystem,
  claimPath: ManagedWorkspacePath,
  lockPath: ManagedWorkspacePath,
  timeoutMs: number,
  restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos
    const timeoutNanos = BigInt(timeoutMs) * 1_000_000n

    for (;;) {
      yield* restore(filesystem.validate(lockPath, "lock.publish.path"))
      const publication = yield* operations.publish(claimPath, lockPath).pipe(Effect.either)
      if (Either.isRight(publication)) return
      if (!isNodeError(publication.left.cause, "EEXIST")) {
        return yield* lockError("lock.publish", publication.left.cause)
      }

      const observed = yield* restore(inspectLock(operations, filesystem, lockPath))
      if (observed !== null && shouldSteal(observed)) {
        yield* restore(stealObservedLock(operations, filesystem, lockPath, observed))
        continue
      }

      const elapsed = (yield* Clock.currentTimeNanos) - startedAt
      if (elapsed >= timeoutNanos) {
        return yield* lockError("lock.acquire", new Error(`Timed out waiting for ${lockPath}`))
      }
      const remainingMs = Number((timeoutNanos - elapsed + 999_999n) / 1_000_000n)
      yield* restore(Effect.sleep(Math.min(LOCK_RETRY_MS, remainingMs)))
    }
  })

const inspectLock = (
  operations: FileLockOperations,
  filesystem: ManagedWorkspaceFilesystem,
  lockPath: ManagedWorkspacePath,
): Effect.Effect<ObservedLock | null, ReturnType<typeof poolError>> =>
  filesystem.validate(lockPath, "lock.inspect.path").pipe(
    Effect.zipRight(
      operations.identity(lockPath).pipe(
        Effect.flatMap((identity) =>
          operations
            .read(lockPath)
            .pipe(Effect.map((contents) => ({ contents, identity, owner: parseOwner(contents) }))),
        ),
        Effect.catchAll((cause) =>
          isNodeError(cause.cause, "ENOENT")
            ? Effect.succeed(null)
            : Effect.fail(lockError("lock.inspect", cause.cause)),
        ),
      ),
    ),
  )

const stealObservedLock = (
  operations: FileLockOperations,
  filesystem: ManagedWorkspaceFilesystem,
  lockPath: ManagedWorkspacePath,
  observed: ObservedLock,
) =>
  // The existing well-known link blocks cooperating contenders during this identity recheck.
  // An unrelated actor with filesystem access can still unlink and replace it before remove().
  filesystem.validate(lockPath, "lock.steal.path").pipe(
    Effect.zipRight(inspectLock(operations, filesystem, lockPath)),
    Effect.flatMap((current) =>
      current !== null && sameObservation(current, observed)
        ? operations
            .remove(lockPath)
            .pipe(Effect.mapError((cause) => lockError("lock.steal", cause.cause)))
        : Effect.void,
    ),
  )

const releasePublishedLock = (
  operations: FileLockOperations,
  filesystem: ManagedWorkspaceFilesystem,
  lockPath: ManagedWorkspacePath,
  claimIdentity: LockIdentity,
  contents: string,
) =>
  filesystem.validate(lockPath, "lock.release.path").pipe(
    Effect.zipRight(inspectLock(operations, filesystem, lockPath)),
    Effect.flatMap((observed) => {
      if (
        observed === null ||
        observed.contents !== contents ||
        !sameIdentity(observed.identity, claimIdentity)
      ) {
        return Effect.void
      }
      return inspectLock(operations, filesystem, lockPath).pipe(
        Effect.flatMap((current) =>
          current !== null &&
          current.contents === contents &&
          sameIdentity(current.identity, claimIdentity)
            ? operations
                .remove(lockPath)
                .pipe(Effect.mapError((cause) => lockError("lock.release", cause.cause)))
            : Effect.void,
        ),
      )
    }),
  )

const cleanupClaim = (
  operations: FileLockOperations,
  filesystem: ManagedWorkspaceFilesystem,
  claimPath: ManagedWorkspacePath,
) =>
  filesystem
    .validate(claimPath, "lock.claim.cleanup.path")
    .pipe(
      Effect.zipRight(
        operations
          .remove(claimPath)
          .pipe(
            Effect.catchAll((cause) =>
              isNodeError(cause.cause, "ENOENT")
                ? Effect.void
                : Effect.fail(lockError("lock.claim.cleanup", cause.cause)),
            ),
          ),
      ),
    )

const operationIdentity = (
  operations: FileLockOperations,
  path: ManagedWorkspacePath,
  operation: string,
) => operations.identity(path).pipe(Effect.mapError((cause) => lockError(operation, cause.cause)))

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

const validateTimeout = (timeoutMs: number) =>
  Number.isSafeInteger(timeoutMs) && timeoutMs >= 0
    ? Effect.void
    : Effect.fail(
        lockError(
          "lock.timeout",
          new TypeError(`Lock timeout must be a non-negative safe integer: ${timeoutMs}`),
        ),
      )

const shouldSteal = (observed: ObservedLock) => {
  if (observed.owner !== null) {
    if (observed.owner.pid === process.pid && observed.owner.processNonce !== PROCESS_NONCE) {
      return true
    }
    return !isProcessAlive(observed.owner.pid)
  }

  const partialPid = parsePartialPid(observed.contents)
  if (partialPid !== null && !isProcessAlive(partialPid)) return true
  return Date.now() - observed.identity.modifiedAtMs >= CORRUPT_LOCK_STALE_MS
}

const parseOwner = (contents: string): LockOwner | null => {
  try {
    const parsed: unknown = JSON.parse(contents)
    if (
      Predicate.isReadonlyRecord(parsed) &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof parsed.processNonce === "string" &&
      parsed.processNonce.length > 0 &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "string" &&
      Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return {
        token: parsed.token,
        processNonce: parsed.processNonce,
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      }
    }
  } catch {
    return null
  }
  return null
}

const parsePartialPid = (contents: string): number | null => {
  try {
    const parsed: unknown = JSON.parse(contents)
    return Predicate.isReadonlyRecord(parsed) &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0
      ? parsed.pid
      : null
  } catch {
    return null
  }
}

const sameObservation = (left: ObservedLock, right: ObservedLock) =>
  left.contents === right.contents && sameIdentity(left.identity, right.identity)

const sameIdentity = (left: LockIdentity, right: LockIdentity) =>
  left.device === right.device && left.inode === right.inode

const lockFileName = (path: ManagedWorkspacePath) => {
  const segments = String(path).split(/[\\/]/u)
  return segments[segments.length - 1] ?? "lock"
}

const lockError = (operation: string, cause: unknown) =>
  poolError("lock", operation, "DiffDash could not lock its isolated worktree pool.", cause)
