import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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

it.scoped("FUN-148 AC: loads committed incomplete and completed onboarding fixtures", () =>
  Effect.gen(function* () {
    const directory = yield* makeTempDirectory
    const statePath = installStateFixture(directory, "onboarding-incomplete.json")

    const incomplete = yield* Effect.gen(function* () {
      const appState = yield* AppState
      return yield* appState.get
    }).pipe(Effect.provide(makeLayer(directory)))
    expect(incomplete.onboardingCompleted).toBe(false)

    copyFileSync(resolve("src/main/services/fixtures/onboarding-completed.json"), statePath)
    const completed = yield* Effect.gen(function* () {
      const appState = yield* AppState
      return yield* appState.get
    }).pipe(Effect.provide(makeLayer(directory)))
    expect(completed.onboardingCompleted).toBe(true)
  }),
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
      installStateFixture(directory, "settings-malformed.txt")

      const state = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* appState.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(state).toEqual(DEFAULT_APP_STATE)
    }),
  )
})

const installStateFixture = (directory: string, fixtureName: string) => {
  const stateDirectory = join(directory, "diffdash")
  const statePath = join(stateDirectory, "state.json")
  mkdirSync(stateDirectory, { recursive: true })
  copyFileSync(resolve("src/main/services/fixtures", fixtureName), statePath)
  return statePath
}
