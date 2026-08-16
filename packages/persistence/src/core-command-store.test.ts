import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Result, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as DatabaseNode from "./database-node"
import { makeDatabase } from "./database"
import {
  CoreCommandConflictError,
  CoreCommandId,
  CoreCommandStore,
  CoreProcessEpoch,
  CoreStateVersion,
} from "./core-command-store"

const makeTempDatabasePath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-command-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "core.sqlite")))

const makeLayer = (databasePath: string) =>
  CoreCommandStore.layer.pipe(Layer.provideMerge(DatabaseNode.layer(databasePath)))

const commandInput = (id: string, name = "review.refresh") => ({
  commandId: CoreCommandId.make(id),
  processEpoch: CoreProcessEpoch.make("epoch-command-test"),
  metadata: { name, scope: { name: "project", id: "project-1" } },
})

describe("CoreCommandStore", () => {
  it.effect("accepts idempotently and rejects command ID metadata collisions", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      return yield* Effect.gen(function* () {
        const store = yield* CoreCommandStore
        const [first, replay] = yield* Effect.all(
          [
            store.acceptOrGet(commandInput("command-idempotent")),
            store.acceptOrGet(commandInput("command-idempotent")),
          ],
          { concurrency: "unbounded" },
        )
        const collision = yield* Effect.result(
          store.acceptOrGet(commandInput("command-idempotent", "review.delete")),
        )

        expect(new Set([first.created, replay.created])).toEqual(new Set([false, true]))
        expect(replay.command).toEqual(first.command)
        expect(Result.isFailure(collision) && collision.failure).toBeInstanceOf(
          CoreCommandConflictError,
        )
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("chooses one monotonic terminal winner and rejects stale acknowledgements", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      return yield* Effect.gen(function* () {
        const store = yield* CoreCommandStore
        const accepted = yield* store.acceptOrGet(commandInput("command-terminal-race"))
        const guard = {
          commandId: accepted.command.commandId,
          expectedStateVersion: accepted.command.stateVersion,
        }
        const transitions = yield* Effect.all([store.commit(guard), store.fail(guard)], {
          concurrency: "unbounded",
        })
        const winner = transitions.find(({ won }) => won)
        const loser = transitions.find(({ won }) => !won)

        expect(winner?.command.stateVersion).toBe(2)
        expect(loser?.command).toEqual(winner?.command)
        const staleTerminal = yield* Effect.result(
          store.acknowledge({
            commandId: accepted.command.commandId,
            expectedStateVersion: CoreStateVersion.make(1),
          }),
        )
        expect(Result.isFailure(staleTerminal) && staleTerminal.failure).toMatchObject({
          reason: "staleVersion",
          currentStateVersion: 2,
        })
        const acknowledged = yield* store.acknowledge({
          commandId: accepted.command.commandId,
          expectedStateVersion: CoreStateVersion.make(2),
        })
        expect(acknowledged).toMatchObject({ state: "acknowledged", stateVersion: 3 })

        const stale = yield* Effect.result(
          store.acknowledge({
            commandId: accepted.command.commandId,
            expectedStateVersion: CoreStateVersion.make(2),
          }),
        )
        expect(Result.isFailure(stale) && stale.failure).toMatchObject({
          _tag: "CoreCommandAcknowledgementRejectedError",
          reason: "alreadyAcknowledged",
          currentStateVersion: 3,
        })
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )

  it.effect("recovers an acceptance-only crash as an unacknowledged failure after restart", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      const accepted = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* CoreCommandStore
          return yield* store.acceptOrGet(commandInput("command-crash-boundary"))
        }).pipe(Effect.provide(makeLayer(databasePath))),
      )

      const recovered = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* CoreCommandStore
          const recoveredCommands = yield* store.recoverAcceptedAsFailed()
          const pending = yield* store.listUnacknowledgedTerminal()
          return {
            recoveredCommands,
            pending,
            stored: yield* store.get(accepted.command.commandId),
          }
        }).pipe(Effect.provide(makeLayer(databasePath))),
      )

      expect(recovered.recoveredCommands).toHaveLength(1)
      expect(recovered.pending).toMatchObject([
        { commandId: accepted.command.commandId, state: "failed", stateVersion: 2 },
      ])
      expect(Option.getOrThrow(recovered.stored)).toEqual(recovered.pending[0])
    }),
  )

  it.effect("stores only bounded safe metadata and bounds terminal recovery queries", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeTempDatabasePath
      return yield* Effect.gen(function* () {
        const store = yield* CoreCommandStore
        const database = makeDatabase(yield* SqlClient.SqlClient)
        for (let index = 0; index < 3; index += 1) {
          const accepted = yield* store.acceptOrGet(commandInput(`command-bounded-${index}`))
          yield* store.commit({
            commandId: accepted.command.commandId,
            expectedStateVersion: accepted.command.stateVersion,
          })
        }
        expect(yield* store.listUnacknowledgedTerminal(2)).toHaveLength(2)
        const columns = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ name: Schema.String })),
        )(yield* database.all("PRAGMA table_info(core_commands)"))
        expect(columns.map(({ name }) => name)).not.toEqual(
          expect.arrayContaining(["payload", "result", "error", "stack", "argv", "env"]),
        )
        expect(
          Result.isFailure(
            yield* Effect.result(
              store.acceptOrGet({
                ...commandInput("command-oversized-metadata"),
                metadata: { name: "x".repeat(101), scope: null },
              }),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayer(databasePath)))
    }),
  )
})
