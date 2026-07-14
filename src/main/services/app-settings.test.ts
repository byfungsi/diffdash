import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  it.scoped("returns default AI settings when the file is missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual(DEFAULT_AI_SETTINGS)
    }),
  )

  it.scoped("persists AI settings as JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      const customSettings = AISettings.make({
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
        provider: "claude",
        telemetryEnabled: true,
        models: { auto: "best", claude: "claude-opus-4-8" },
      })
    }),
  )

  it.scoped("defaults the auto model tier for existing settings files", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      mkdirSync(join(directory, "diffdash"), { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          provider: "auto",
          models: {
            claude: "claude-opus-4-8",
            codex: "gpt-5.5",
            opencode: "openai/gpt-5.5",
          },
        }),
        "utf8",
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.models.auto).toBe("balance")
      expect(settings.models.claude).toBe("claude-opus-4-8")
      expect(settings.models.codex).toBe("gpt-5.5")
      expect(settings.telemetryEnabled).toBe(true)
    }),
  )

  it.scoped("reads a manual telemetry opt-out from settings JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      mkdirSync(join(directory, "diffdash"), { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({ ...DEFAULT_AI_SETTINGS, telemetryEnabled: false }),
        "utf8",
      )

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
      const settingsPath = join(directory, "diffdash", "settings.json")
      mkdirSync(join(directory, "diffdash"), { recursive: true })
      writeFileSync(settingsPath, "not json", "utf8")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual(DEFAULT_AI_SETTINGS)
    }),
  )
})
