import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"

import { DiagnosticOperation } from "@diffdash/domain/diagnostic-operation"
import { type Database, DatabaseError } from "./database"
import { checkpointDatabase } from "./sqlite-backup"

describe("SQLite backup deadlines", () => {
  it.effect("classifies a checkpoint that exceeds its bounded deadline", () =>
    Effect.gen(function* () {
      const blocked: Database = {
        get: () => Effect.never,
        all: () => Effect.succeed([]),
        run: () => Effect.void,
        transaction: (program) => program,
      }
      const fiber = yield* Effect.result(checkpointDatabase(blocked)).pipe(Effect.forkChild)
      yield* TestClock.adjust("10 seconds")
      const result = yield* Fiber.join(fiber)

      expect(Result.isFailure(result) && result.failure).toEqual(
        expect.objectContaining<Partial<DatabaseError>>({
          _tag: "DatabaseError",
          operation: DiagnosticOperation.make("backupCheckpointDeadline"),
        }),
      )
    }),
  )
})
