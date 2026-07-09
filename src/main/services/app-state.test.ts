import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_APP_STATE } from "../../shared/app-state"
import { AppConfig } from "./app-config"
import { AppState } from "./app-state"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-app-state-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (directory: string) =>
  AppState.layer.pipe(
    Layer.provide(
      AppConfig.layer({
        databasePath: join(directory, "test.sqlite"),
        settingsPath: join(directory, "diffdash", "settings.json"),
        tempDir: directory,
      }),
    ),
  )

describe("AppState", () => {
  it.scoped("returns default app state when the file is missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory

      const state = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* appState.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(state).toEqual(DEFAULT_APP_STATE)
    }),
  )

  it.scoped("persists app state as JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const statePath = join(directory, "diffdash", "state.json")

      const loaded = yield* Effect.gen(function* () {
        const appState = yield* AppState
        yield* appState.save({ onboardingCompleted: true })
        return yield* appState.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(loaded.onboardingCompleted).toBe(true)
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ onboardingCompleted: true })
    }),
  )

  it.scoped("falls back to defaults for invalid JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const statePath = join(directory, "diffdash", "state.json")
      mkdirSync(join(directory, "diffdash"), { recursive: true })
      writeFileSync(statePath, "not json", "utf8")

      const state = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* appState.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(state).toEqual(DEFAULT_APP_STATE)
    }),
  )
})
