import { describe, expect, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Result, Layer } from "effect"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { DEFAULT_APP_STATE } from "@diffdash/domain/app-state"
import { AppState, AppStateError } from "./app-state"
import { FileStorage } from "./file-storage"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-app-state-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (directory: string) =>
  AppState.layer(join(directory, "diffdash", "state.json")).pipe(
    Layer.provide(
      FileStorage.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
    ),
  )

it.effect("FUN-148 AC: loads committed incomplete and completed onboarding fixtures", () =>
  Effect.gen(function* () {
    const directory = yield* makeTempDirectory
    const statePath = installStateFixture(directory, "onboarding-incomplete.json")

    const incomplete = yield* Effect.gen(function* () {
      const appState = yield* AppState
      return yield* appState.get
    }).pipe(Effect.provide(makeLayer(directory)))
    expect(incomplete.onboardingCompleted).toBe(false)

    copyFileSync(resolve("src/fixtures/onboarding-completed.json"), statePath)
    const completed = yield* Effect.gen(function* () {
      const appState = yield* AppState
      return yield* appState.get
    }).pipe(Effect.provide(makeLayer(directory)))
    expect(completed.onboardingCompleted).toBe(true)
  }),
)

describe("AppState", () => {
  it.effect("returns default app state when the file is missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory

      const state = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* appState.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(state).toEqual(DEFAULT_APP_STATE)
    }),
  )

  it.effect("maps non-ENOENT filesystem failures to read errors", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      mkdirSync(join(directory, "diffdash", "state.json"), { recursive: true })

      const result = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* Effect.result(appState.get)
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AppStateError)
        expect(result.failure.operation).toBe("read")
      }
    }),
  )

  it.effect("maps atomic replacement failures to write errors and removes temporary files", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const stateDirectory = join(directory, "diffdash")
      mkdirSync(join(stateDirectory, "state.json"), { recursive: true })

      const result = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* Effect.result(appState.save({ onboardingCompleted: true }))
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AppStateError)
        expect(result.failure.operation).toBe("write")
      }
      expect(readdirSync(stateDirectory)).toEqual(["state.json"])
    }),
  )

  it.effect("persists app state as JSON", () =>
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

  it.effect("fails instead of treating invalid JSON as first-run state", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installStateFixture(directory, "settings-malformed.txt")

      const result = yield* Effect.gen(function* () {
        const appState = yield* AppState
        return yield* Effect.result(appState.get)
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AppStateError)
        expect(result.failure.operation).toBe("read")
      }
    }),
  )
})

const installStateFixture = (directory: string, fixtureName: string) => {
  const stateDirectory = join(directory, "diffdash")
  const statePath = join(stateDirectory, "state.json")
  mkdirSync(stateDirectory, { recursive: true })
  copyFileSync(resolve("src/fixtures", fixtureName), statePath)
  return statePath
}
