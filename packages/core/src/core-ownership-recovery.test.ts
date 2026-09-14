import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ApplicationInstanceId,
  CoreProcessEpoch,
  DatabaseOwnershipAuthorizationId,
} from "@diffdash/core-rpc/identity"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { CoreOwnershipRecoveryError, makeCoreOwnershipRecovery } from "./core-ownership-recovery"
import { nodeDatabaseOwnerInspector, readProcessStartIdentity } from "./node-process-identity"

const makeDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-owner-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const authorization = {
  applicationInstanceId: ApplicationInstanceId.make("app:ownership"),
  processEpoch: CoreProcessEpoch.make("epoch:ownership"),
  authorizationId: DatabaseOwnershipAuthorizationId.make("authorization:with:colons"),
} as const

describe("Core ownership recovery", () => {
  it.effect(
    "rejects a new application while the previous exact database owner is still alive",
    () =>
      Effect.gen(function* () {
        const directory = yield* makeDirectory
        const databasePath = join(directory, "diffdash.sqlite")
        const processStartIdentity = yield* readProcessStartIdentity(process.pid)
        const owner = makeCoreOwnershipRecovery({
          databasePath,
          pid: process.pid,
          processStartIdentity,
          inspector: nodeDatabaseOwnerInspector,
          recover: Effect.void,
        })
        const lease = yield* owner.acquireAndRecover(authorization)
        const contender = makeCoreOwnershipRecovery({
          databasePath,
          pid: process.pid,
          processStartIdentity,
          inspector: nodeDatabaseOwnerInspector,
          recover: Effect.die("must not open or recover a database owned by a live process"),
        })
        const failure = yield* contender
          .acquireAndRecover({
            applicationInstanceId: ApplicationInstanceId.make("app:new-application"),
            processEpoch: CoreProcessEpoch.make("epoch:new-application"),
            authorizationId: DatabaseOwnershipAuthorizationId.make("authorization:new-application"),
          })
          .pipe(Effect.flip)

        expect(failure).toMatchObject({ _tag: "CoreOwnershipRecoveryError", stage: "ownership" })
        expect(existsSync(`${databasePath}.owner`)).toBe(true)
        yield* lease.release
        expect(existsSync(`${databasePath}.owner`)).toBe(false)
      }),
  )

  it.effect("retains exact sidecar ownership through recovery and releases it explicitly", () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory
      const databasePath = join(directory, "diffdash.sqlite")
      const processStartIdentity = yield* readProcessStartIdentity(process.pid)
      const operations = makeCoreOwnershipRecovery({
        databasePath,
        pid: process.pid,
        processStartIdentity,
        inspector: nodeDatabaseOwnerInspector,
        recover: Effect.void,
      })

      const lease = yield* operations.acquireAndRecover(authorization)
      expect(existsSync(`${databasePath}.owner`)).toBe(true)
      yield* lease.release
      expect(existsSync(`${databasePath}.owner`)).toBe(false)
    }),
  )

  it.effect("releases ownership when startup recovery fails", () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory
      const databasePath = join(directory, "diffdash.sqlite")
      const processStartIdentity = yield* readProcessStartIdentity(process.pid)
      const failed = makeCoreOwnershipRecovery({
        databasePath,
        pid: process.pid,
        processStartIdentity,
        inspector: nodeDatabaseOwnerInspector,
        recover: CoreOwnershipRecoveryError.make({
          stage: "recovery",
          safeMessage: "DiffDash Core could not acquire and recover its owned resources.",
        }),
      })

      expect(Result.isFailure(yield* Effect.result(failed.acquireAndRecover(authorization)))).toBe(
        true,
      )
      expect(existsSync(`${databasePath}.owner`)).toBe(false)
    }),
  )
})
