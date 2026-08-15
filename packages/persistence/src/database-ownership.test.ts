import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import {
  acquireDatabaseOwnership,
  type DatabaseOwner,
  type DatabaseOwnerInspector,
  DatabaseOwnershipHeld,
  DatabaseOwnershipRecordError,
  DatabaseOwnershipUncertain,
} from "./database-ownership"

const owner = (nonce: string, overrides: Partial<DatabaseOwner> = {}): DatabaseOwner => ({
  applicationInstance: "app-1",
  processEpoch: "epoch-1",
  pid: 101,
  processStartIdentity: "start-101-a",
  nonce,
  ...overrides,
})

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-ownership-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "diffdash.sqlite")))

const exactInspector = (
  live: ReadonlySet<string>,
  uncertain: ReadonlySet<string> = new Set(),
): DatabaseOwnerInspector => ({
  inspect: (candidate) => {
    const identity = `${candidate.pid}:${candidate.processStartIdentity}`
    return Effect.succeed(
      uncertain.has(identity) ? "uncertain" : live.has(identity) ? "alive" : "dead",
    )
  },
})

describe("DatabaseOwnership", () => {
  it.effect("serializes concurrent acquisition and preserves the winner", () =>
    Effect.gen(function* () {
      const databasePath = yield* tempDatabase
      const first = owner("first")
      const second = owner("second", {
        applicationInstance: "app-2",
        processEpoch: "epoch-2",
        pid: 202,
        processStartIdentity: "start-202",
      })
      const inspector = exactInspector(
        new Set([
          `${first.pid}:${first.processStartIdentity}`,
          `${second.pid}:${second.processStartIdentity}`,
        ]),
      )

      const results = yield* Effect.all(
        [
          Effect.result(acquireDatabaseOwnership({ databasePath, owner: first, inspector })),
          Effect.result(acquireDatabaseOwnership({ databasePath, owner: second, inspector })),
        ],
        { concurrency: "unbounded" },
      )

      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      const failure = results.find(Result.isFailure)
      expect(failure && Result.isFailure(failure) && failure.failure).toBeInstanceOf(
        DatabaseOwnershipHeld,
      )
      const success = results.find(Result.isSuccess)
      if (success && Result.isSuccess(success)) yield* success.success.release()
    }),
  )

  it.effect("recovers a crashed exact owner and permits clean release", () =>
    Effect.gen(function* () {
      const databasePath = yield* tempDatabase
      const crashed = owner("crashed")
      const replacement = owner("replacement", {
        applicationInstance: "app-2",
        processEpoch: "epoch-2",
        pid: 202,
        processStartIdentity: "start-202",
      })
      const firstLease = yield* acquireDatabaseOwnership({
        databasePath,
        owner: crashed,
        inspector: exactInspector(new Set([`${crashed.pid}:${crashed.processStartIdentity}`])),
      })
      expect(firstLease.owner).toEqual(crashed)

      const replacementLease = yield* acquireDatabaseOwnership({
        databasePath,
        owner: replacement,
        inspector: exactInspector(
          new Set([`${replacement.pid}:${replacement.processStartIdentity}`]),
        ),
      })
      yield* replacementLease.release()

      expect(existsSync(`${databasePath}.owner`)).toBe(false)
    }),
  )

  it.effect("treats a reused PID with a different start identity as a dead exact owner", () =>
    Effect.gen(function* () {
      const databasePath = yield* tempDatabase
      const oldProcess = owner("old", { pid: 303, processStartIdentity: "old-start" })
      const reusedPid = owner("new", {
        applicationInstance: "app-2",
        processEpoch: "epoch-2",
        pid: 303,
        processStartIdentity: "new-start",
      })
      yield* acquireDatabaseOwnership({
        databasePath,
        owner: oldProcess,
        inspector: exactInspector(new Set(["303:old-start"])),
      })

      const lease = yield* acquireDatabaseOwnership({
        databasePath,
        owner: reusedPid,
        inspector: exactInspector(new Set(["303:new-start"])),
      })
      expect(lease.owner.processStartIdentity).toBe("new-start")
      yield* lease.release()
    }),
  )

  it.effect("fails closed when exact owner death is uncertain", () =>
    Effect.gen(function* () {
      const databasePath = yield* tempDatabase
      const previous = owner("previous")
      yield* acquireDatabaseOwnership({
        databasePath,
        owner: previous,
        inspector: exactInspector(new Set([`${previous.pid}:${previous.processStartIdentity}`])),
      })
      const contender = owner("contender", { pid: 404, processStartIdentity: "start-404" })
      const result = yield* Effect.result(
        acquireDatabaseOwnership({
          databasePath,
          owner: contender,
          inspector: exactInspector(
            new Set(),
            new Set([`${previous.pid}:${previous.processStartIdentity}`]),
          ),
        }),
      )

      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(DatabaseOwnershipUncertain)
    }),
  )

  it.effect("fails closed on a corrupt stale owner record", () =>
    Effect.gen(function* () {
      const databasePath = yield* tempDatabase
      writeFileSync(`${databasePath}.owner`, "not-json", { flag: "wx" })

      const result = yield* Effect.result(
        acquireDatabaseOwnership({
          databasePath,
          owner: owner("contender"),
          inspector: exactInspector(new Set()),
        }),
      )

      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
        DatabaseOwnershipRecordError,
      )
      expect(existsSync(`${databasePath}.owner`)).toBe(true)
    }),
  )
})
