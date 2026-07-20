import { describe, expect, it } from "@effect/vitest"
import { Effect, Either } from "effect"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { AppSettings, AppSettingsError } from "./app-settings"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-settings-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (directory: string) =>
  AppSettings.layer(join(directory, "diffdash", "settings.json"))

describe("AppSettings", () => {
  it.scoped("returns default settings when the file is missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual(DEFAULT_AI_SETTINGS)
    }),
  )

  it.scoped("maps non-ENOENT filesystem failures to read errors", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      mkdirSync(join(directory, "diffdash", "settings.json"), { recursive: true })

      const result = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* Effect.either(appSettings.get)
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(AppSettingsError)
        expect(result.left.operation).toBe("read")
      }
    }),
  )

  it.scoped("preserves settings owned by unavailable future providers", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      mkdirSync(join(directory, "diffdash"), { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...DEFAULT_AI_SETTINGS,
          futureProvider: { enabled: true },
          routes: { walkthrough: "future", reviewThread: "auto" },
          models: { ...DEFAULT_AI_SETTINGS.models, future: "future-model" },
        }),
      )

      yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        const loaded = yield* appSettings.get
        expect(loaded.routes.walkthrough).toBe("future")
        expect(loaded.models.future).toBe("future-model")
        yield* appSettings.save(AISettings.make({ ...loaded, appearance: "dark" }))
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        appearance: "dark",
        futureProvider: { enabled: true },
        routes: { walkthrough: "future", reviewThread: "auto" },
        models: { future: "future-model" },
      })
    }),
  )

  it.scoped("FUN-131 AC: upgrades the committed current settings fixture", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-current.json")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual({
        version: 2,
        appearance: "dark",
        routes: { walkthrough: "codex", reviewThread: "codex" },
        models: {
          codex: "gpt-5.4-mini",
          claude: "claude-haiku-4-5",
          opencode: "openai/gpt-5.4-mini",
        },
        autoQuality: "fast",
        telemetryEnabled: true,
      })
      expect(
        JSON.parse(readFileSync(join(directory, "diffdash", "settings.json"), "utf8")),
      ).toEqual(settings)
    }),
  )

  it.scoped("persists settings as JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      const customSettings = AISettings.make({
        ...DEFAULT_AI_SETTINGS,
        appearance: "dark",
        routes: { walkthrough: "claude", reviewThread: "opencode" },
        autoQuality: "best",
        models: {
          claude: "claude-opus-4-8",
          codex: "gpt-5.5",
          opencode: "anthropic/claude-sonnet-5",
        },
      })

      const loaded = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        yield* appSettings.save(customSettings)
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(loaded).toEqual(customSettings)
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        appearance: "dark",
        version: 2,
        routes: { walkthrough: "claude", reviewThread: "opencode" },
        telemetryEnabled: true,
        autoQuality: "best",
        models: { claude: "claude-opus-4-8" },
      })
    }),
  )

  it.scoped("defaults the auto model tier for existing settings files", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-legacy.json")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.autoQuality).toBe("balanced")
      expect(settings.models.claude).toBe("claude-opus-4-8")
      expect(settings.models.codex).toBe("gpt-5.5")
      expect(settings.appearance).toBe("system")
      expect(settings.telemetryEnabled).toBe(true)
    }),
  )

  it.scoped("reads a manual telemetry opt-out from settings JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-telemetry-disabled.json")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.telemetryEnabled).toBe(false)
    }),
  )

  it.scoped("FUN-131 AC: isolates telemetry and appearance from malformed provider settings", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        join(settingsDirectory, "settings.json"),
        JSON.stringify({
          version: 2,
          appearance: "dark",
          telemetryEnabled: false,
          routes: { walkthrough: 42, reviewThread: "missing-provider" },
          models: { "missing-provider": null },
          autoQuality: "fast",
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.appearance).toBe("dark")
      expect(settings.telemetryEnabled).toBe(false)
      expect(settings.routes).toEqual(DEFAULT_AI_SETTINGS.routes)
      expect(settings.models).toEqual(DEFAULT_AI_SETTINGS.models)
    }),
  )

  it.scoped("falls back to defaults for invalid JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-malformed.txt")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual(DEFAULT_AI_SETTINGS)
    }),
  )
})

const installSettingsFixture = (directory: string, fixtureName: string) => {
  const settingsDirectory = join(directory, "diffdash")
  mkdirSync(settingsDirectory, { recursive: true })
  copyFileSync(resolve("src/fixtures", fixtureName), join(settingsDirectory, "settings.json"))
}
