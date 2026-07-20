import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, TestClock, TestLive } from "effect"

import {
  FileLockOperationError,
  isProcessAlive,
  makeFileLock,
  nodeFileLockOperations,
  withFileLock,
} from "./hosted-review-workspace-file-lock"
import { makeManagedWorkspaceFilesystem } from "./hosted-review-workspace-paths"

const lockFixture = Effect.acquireRelease(
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "diffdash-file-lock-"))
    const filesystem = yield* makeManagedWorkspaceFilesystem(join(root, "pool"))
    return { filesystem, lockPath: filesystem.path("locks", "test.lock"), root }
  }),
  ({ root }) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
)

describe("withFileLock", () => {
  it.scoped("serializes contending users and releases both scoped claims", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const live = yield* TestLive.TestLive
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      let secondEntered = false

      const first = yield* live
        .provide(
          withFileLock(filesystem, lockPath, () =>
            Deferred.succeed(firstEntered, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseFirst)),
            ),
          ),
        )
        .pipe(Effect.fork)
      yield* Deferred.await(firstEntered)

      const second = yield* live
        .provide(
          withFileLock(filesystem, lockPath, () =>
            Effect.sync(() => {
              secondEntered = true
            }),
          ),
        )
        .pipe(Effect.fork)
      yield* live.provide(Effect.sleep(75))
      expect(secondEntered).toBe(false)

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      expect(secondEntered).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
      expect(claimFiles(lockPath)).toEqual([])
    }),
  )

  it.scoped("times out from the monotonic TestClock while contended", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const live = yield* TestLive.TestLive
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const first = yield* live
        .provide(
          withFileLock(filesystem, lockPath, () =>
            Deferred.succeed(firstEntered, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseFirst)),
            ),
          ),
        )
        .pipe(Effect.fork)
      yield* Deferred.await(firstEntered)

      const waiterAttempted = yield* Deferred.make<void>()
      const lock = makeFileLock({
        ...nodeFileLockOperations,
        publish: (claimPath, destinationPath) =>
          Deferred.succeed(waiterAttempted, undefined).pipe(
            Effect.zipRight(nodeFileLockOperations.publish(claimPath, destinationPath)),
          ),
      })
      const waiter = yield* lock(filesystem, lockPath, () => Effect.void, 100).pipe(
        Effect.flip,
        Effect.fork,
      )
      yield* Deferred.await(waiterAttempted)
      yield* TestClock.adjust(100)
      const error = yield* Fiber.join(waiter)

      expect(error).toMatchObject({ code: "lock", operation: "lock.acquire" })
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
    }),
  )

  it.scoped("interrupts immediately while polling and removes only the waiting claim", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const live = yield* TestLive.TestLive
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const first = yield* withFileLock(filesystem, lockPath, () =>
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseFirst)),
        ),
      ).pipe(Effect.fork)
      yield* Deferred.await(firstEntered)

      const waiter = yield* live
        .provide(withFileLock(filesystem, lockPath, () => Effect.never))
        .pipe(Effect.fork)
      yield* live.provide(Effect.sleep(75))
      yield* Fiber.interrupt(waiter)

      expect(existsSync(lockPath)).toBe(true)
      expect(claimFiles(lockPath)).toHaveLength(1)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      expect(claimFiles(lockPath)).toEqual([])
    }),
  )

  it.scoped("defers interruption during publication, then releases before use", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const publicationStarted = yield* Deferred.make<void>()
      const continuePublication = yield* Deferred.make<void>()
      let useStarted = false
      const lock = makeFileLock({
        ...nodeFileLockOperations,
        publish: (claimPath, destinationPath) =>
          Deferred.succeed(publicationStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(continuePublication)),
            Effect.zipRight(nodeFileLockOperations.publish(claimPath, destinationPath)),
          ),
      })

      const fiber = yield* lock(filesystem, lockPath, () =>
        Effect.sync(() => {
          useStarted = true
        }),
      ).pipe(Effect.fork)
      yield* Deferred.await(publicationStarted)
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.fork)
      yield* Deferred.succeed(continuePublication, undefined)
      yield* Fiber.join(interruption)

      expect(useStarted).toBe(false)
      expect(existsSync(lockPath)).toBe(false)
      expect(claimFiles(lockPath)).toEqual([])
    }),
  )

  it.scoped("releases when interrupted immediately after atomic acquisition", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const published = yield* Deferred.make<void>()
      const finishPublication = yield* Deferred.make<void>()
      let useStarted = false
      const lock = makeFileLock({
        ...nodeFileLockOperations,
        publish: (claimPath, destinationPath) =>
          nodeFileLockOperations
            .publish(claimPath, destinationPath)
            .pipe(
              Effect.zipRight(Deferred.succeed(published, undefined)),
              Effect.zipRight(Deferred.await(finishPublication)),
            ),
      })

      const fiber = yield* lock(filesystem, lockPath, () =>
        Effect.sync(() => {
          useStarted = true
        }),
      ).pipe(Effect.fork)
      yield* Deferred.await(published)
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.fork)
      yield* Deferred.succeed(finishPublication, undefined)
      yield* Fiber.join(interruption)

      expect(useStarted).toBe(false)
      expect(existsSync(lockPath)).toBe(false)
      expect(claimFiles(lockPath)).toEqual([])
    }),
  )

  it.scoped("cleans a partially written claim when claim publication fails", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const lock = makeFileLock({
        ...nodeFileLockOperations,
        createClaim: (claimPath) =>
          Effect.sync(() => writeFileSync(claimPath, "partial", { flag: "wx" })).pipe(
            Effect.zipRight(
              Effect.fail(
                FileLockOperationError.make({ cause: new Error("simulated write failure") }),
              ),
            ),
          ),
      })

      const error = yield* lock(filesystem, lockPath, () => Effect.void).pipe(Effect.flip)

      expect(error).toMatchObject({ code: "lock", operation: "lock.claim.write" })
      expect(existsSync(lockPath)).toBe(false)
      expect(claimFiles(lockPath)).toEqual([])
    }),
  )

  it.scoped("steals corrupt and dead-owner locks", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      yield* filesystem.ensureParent(lockPath, "test.lock.parent")

      writeFileSync(lockPath, "not-json")
      const old = new Date("2000-01-01T00:00:00.000Z")
      utimesSync(lockPath, old, old)
      yield* withFileLock(filesystem, lockPath, () => Effect.void)
      expect(existsSync(lockPath)).toBe(false)

      writeFileSync(
        lockPath,
        JSON.stringify({
          token: "dead-owner",
          pid: 2_147_483_647,
          createdAt: old.toISOString(),
        }),
      )
      yield* withFileLock(filesystem, lockPath, () => Effect.void)
      expect(existsSync(lockPath)).toBe(false)

      writeFileSync(
        lockPath,
        JSON.stringify({
          token: "reused-pid",
          processNonce: "previous-process",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      )
      yield* withFileLock(filesystem, lockPath, () => Effect.void)
      expect(existsSync(lockPath)).toBe(false)
    }),
  )

  it.scoped("does not unlink a replacement lock during release", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      const replacement = JSON.stringify({
        token: "replacement",
        processNonce: "replacement-process",
        pid: 1,
        createdAt: new Date().toISOString(),
      })

      yield* withFileLock(filesystem, lockPath, () =>
        Effect.sync(() => {
          rmSync(lockPath)
          writeFileSync(lockPath, replacement, { flag: "wx", mode: 0o600 })
        }),
      )

      expect(readFileSync(lockPath, "utf8")).toBe(replacement)
      expect(claimFiles(lockPath)).toEqual([])
      rmSync(lockPath)
    }),
  )

  it.scoped("does not steal a replacement that appears after observing a stale owner", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      yield* filesystem.ensureParent(lockPath, "test.lock.parent")
      expect(isProcessAlive(1)).toBe(true)
      writeFileSync(
        lockPath,
        JSON.stringify({
          token: "stale",
          processNonce: "previous-process",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      )
      const replacement = JSON.stringify({
        token: "replacement",
        processNonce: "active-process",
        pid: 1,
        createdAt: new Date().toISOString(),
      })
      const replacementInstalled = yield* Deferred.make<void>()
      let reads = 0
      const lock = makeFileLock({
        ...nodeFileLockOperations,
        read: (path) => {
          reads += 1
          return reads === 2
            ? Effect.sync(() => {
                rmSync(path)
                writeFileSync(path, replacement, { flag: "wx", mode: 0o600 })
              }).pipe(
                Effect.zipRight(Deferred.succeed(replacementInstalled, undefined)),
                Effect.zipRight(nodeFileLockOperations.read(path)),
              )
            : nodeFileLockOperations.read(path)
        },
      })

      const fiber = yield* lock(filesystem, lockPath, () => Effect.never).pipe(Effect.fork)
      yield* Deferred.await(replacementInstalled)
      yield* Fiber.interrupt(fiber)

      expect(readFileSync(lockPath, "utf8")).toBe(replacement)
      expect(claimFiles(lockPath)).toEqual([])
      rmSync(lockPath)
    }),
  )

  it.scoped("rejects invalid timeout inputs before creating lock files", () =>
    Effect.gen(function* () {
      const { filesystem, lockPath } = yield* lockFixture
      for (const timeout of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
        const error = yield* withFileLock(filesystem, lockPath, () => Effect.void, timeout).pipe(
          Effect.flip,
        )
        expect(error).toMatchObject({ code: "lock", operation: "lock.timeout" })
      }
      expect(existsSync(lockPath)).toBe(false)
    }),
  )
})

const claimFiles = (lockPath: string) => {
  const parent = dirname(lockPath)
  return existsSync(parent) ? readdirSync(parent).filter((name) => name.endsWith(".claim")) : []
}
