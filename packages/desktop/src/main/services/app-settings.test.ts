import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { AIProviderModels, AISettings, DEFAULT_AI_SETTINGS } from "../../shared/ai-settings"
import { AppConfig } from "./app-config"
import { AppSettings } from "./app-settings"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-settings-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (directory: string) =>
  AppSettings.layer.pipe(
    Layer.provide(
      AppConfig.layer({
        databasePath: join(directory, "test.sqlite"),
        settingsPath: join(directory, "diffdash", "settings.json"),
        tempDir: directory,
      }),
    ),
  )

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

  it.scoped("FUN-148 AC: loads the committed current settings fixture", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-current.json")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual({
        appearance: "dark",
        provider: "codex",
        models: {
          auto: "fast",
          codex: "gpt-5.4-mini",
          claude: "claude-haiku-4-5",
          opencode: "openai/gpt-5.4-mini",
        },
        telemetryEnabled: true,
      })
    }),
  )

  it.scoped("persists settings as JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      const customSettings = AISettings.make({
        appearance: "dark",
        provider: "claude",
        models: AIProviderModels.make({
          auto: "best",
          claude: "claude-opus-4-8",
          codex: "gpt-5.5",
          opencode: "anthropic/claude-sonnet-5",
        }),
      })

      const loaded = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        yield* appSettings.save(customSettings)
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(loaded).toEqual(customSettings)
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        appearance: "dark",
        provider: "claude",
        telemetryEnabled: true,
        models: { auto: "best", claude: "claude-opus-4-8" },
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

      expect(settings.models.auto).toBe("balance")
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
  copyFileSync(
    resolve("src/main/services/fixtures", fixtureName),
    join(settingsDirectory, "settings.json"),
  )
}
