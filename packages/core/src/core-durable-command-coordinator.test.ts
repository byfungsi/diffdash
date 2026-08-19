import { CoreCommandId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { CoreCommandStore } from "@diffdash/persistence/core-command-store"
import * as DatabaseNode from "@diffdash/persistence/database-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Ref } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeCoreDurableCommandCoordinator } from "./core-durable-command-coordinator"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-command-coordinator-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "core.sqlite")))

const makeLayer = (databasePath: string) =>
  CoreCommandStore.layer.pipe(Layer.provide(DatabaseNode.layer(databasePath)))

const input = (id: string) => ({
  commandId: CoreCommandId.make(id),
  processEpoch: CoreProcessEpoch.make("epoch-coordinator-test"),
  metadata: { name: "review.refresh", scope: { name: "project", id: "project-1" } },
})

describe("Core durable command coordinator", () => {
  it.effect("persists acceptance before execution and terminal state before an isolated hint", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      return yield* Effect.gen(function* () {
        const store = yield* CoreCommandStore
        const executionObserved = yield* Deferred.make<void>()
        const hintObserved = yield* Deferred.make<void>()
        const executions = yield* Ref.make(0)
        const coordinator = yield* makeCoreDurableCommandCoordinator({
          store,
          publishCommittedHint: (command) =>
            Effect.gen(function* () {
              const persisted = Option.getOrThrow(yield* store.get(command.commandId))
              expect(persisted).toEqual(command)
              expect(persisted.state).toBe("committed")
              yield* Deferred.succeed(hintObserved, undefined)
              return yield* Effect.fail("transport disconnected")
            }),
        })
        const command = input("command-commit-before-hint")
        const receipt = yield* coordinator.execute(
          command,
          Effect.gen(function* () {
            const persisted = Option.getOrThrow(yield* store.get(command.commandId))
            expect(persisted.state).toBe("accepted")
            expect(persisted.stateVersion).toBe(1)
            yield* Ref.update(executions, (count) => count + 1)
            yield* Deferred.succeed(executionObserved, undefined)
          }),
        )

        expect(receipt).toMatchObject({ state: "accepted", stateVersion: 1 })
        yield* Deferred.await(executionObserved)
        yield* Deferred.await(hintObserved)
        expect(Option.getOrThrow(yield* coordinator.get(command.commandId))).toMatchObject({
          state: "committed",
          stateVersion: 2,
        })

        const replay = yield* coordinator.execute(
          command,
          Ref.update(executions, (count) => count + 1),
        )
        expect(replay).toMatchObject({ state: "committed", stateVersion: 2 })
        expect(yield* Ref.get(executions)).toBe(1)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect(
    "recovers accepted work without rerunning its effect and exposes it for acknowledgement",
    () =>
      Effect.gen(function* () {
        const databasePath = yield* makeTempDatabasePath
        yield* Effect.gen(function* () {
          const store = yield* CoreCommandStore
          yield* store.acceptOrGet(input("command-core-restart"))
        }).pipe(Effect.provide(makeLayer(databasePath)), Effect.scoped)

        return yield* Effect.gen(function* () {
          const store = yield* CoreCommandStore
          const hinted = yield* Ref.make<readonly string[]>([])
          const coordinator = yield* makeCoreDurableCommandCoordinator({
            store,
            publishCommittedHint: (command) =>
              Ref.update(hinted, (ids) => [...ids, command.commandId]),
          })
          const recovered = yield* coordinator.recoverInterrupted()
          const pending = yield* coordinator.queryUnacknowledgedTerminal()

          expect(recovered).toMatchObject([
            { commandId: "command-core-restart", state: "failed", stateVersion: 2 },
          ])
          expect(pending).toEqual(recovered)
          expect(yield* Ref.get(hinted)).toEqual(["command-core-restart"])
        }).pipe(Effect.provide(makeLayer(databasePath)))
      }),
  )
})
