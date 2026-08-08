import { describe, expect, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Result, Layer } from "effect"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  AISettings,
  CodeThemePreferences,
  DEFAULT_AI_SETTINGS,
  ThemePreferences,
} from "@diffdash/domain/ai-settings"
import { AppSettings, AppSettingsError } from "./app-settings"
import { FileStorage } from "./file-storage"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-settings-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const makeLayer = (directory: string) =>
  AppSettings.layer(join(directory, "diffdash", "settings.json")).pipe(
    Layer.provide(
      FileStorage.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
    ),
  )

describe("AppSettings", () => {
  it.effect("returns default settings when the file is missing", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual(DEFAULT_AI_SETTINGS)
    }),
  )

  it.effect("maps non-ENOENT filesystem failures to read errors", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      mkdirSync(join(directory, "diffdash", "settings.json"), { recursive: true })

      const result = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* Effect.result(appSettings.get)
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AppSettingsError)
        expect(result.failure.operation).toBe("read")
      }
    }),
  )

  it.effect("preserves settings owned by unavailable future providers", () =>
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

  it.effect("FUN-131 AC: upgrades the committed current settings fixture", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-current.json")

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual({
        version: 7,
        appearance: "dark",
        themes: { light: "diffdash", dark: "diffdash" },
        codeThemes: { light: "rose-pine-dawn", dark: "diffdash-dark" },
        diffViewMode: "auto",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        routes: { walkthrough: "codex", reviewThread: "codex" },
        models: {
          codex: "gpt-5.6-luna",
          claude: "claude-haiku-4-5",
          opencode: "openai/gpt-5.6-luna",
        },
        autoQuality: "fast",
        telemetryEnabled: true,
      })
      expect(
        JSON.parse(readFileSync(join(directory, "diffdash", "settings.json"), "utf8")),
      ).toEqual(settings)
    }),
  )

  it.effect("persists settings as JSON", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsPath = join(directory, "diffdash", "settings.json")
      const customSettings = AISettings.make({
        ...DEFAULT_AI_SETTINGS,
        appearance: "dark",
        themes: ThemePreferences.make({
          light: "catppuccin-latte",
          dark: "catppuccin-mocha",
        }),
        codeThemes: CodeThemePreferences.make({
          light: "github-light-default",
          dark: "pierre-dark-soft",
        }),
        diffViewMode: "split",
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
        themes: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
        codeThemes: { light: "github-light-default", dark: "pierre-dark-soft" },
        diffViewMode: "split",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        version: 7,
        routes: { walkthrough: "claude", reviewThread: "opencode" },
        telemetryEnabled: true,
        autoQuality: "best",
        models: { claude: "claude-opus-4-8" },
      })
    }),
  )

  it.effect("defaults the auto model tier for existing settings files", () =>
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

  it.effect("migrates version 2 settings without losing capability routes", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          version: 2,
          appearance: "dark",
          routes: { walkthrough: "future", reviewThread: "claude" },
          models: { future: "future-model", claude: "claude-opus-4-8" },
          autoQuality: "best",
          telemetryEnabled: false,
          futureProvider: { enabled: true },
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings).toEqual({
        version: 7,
        appearance: "dark",
        themes: { light: "diffdash", dark: "diffdash" },
        codeThemes: { light: "rose-pine-dawn", dark: "diffdash-dark" },
        diffViewMode: "auto",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        routes: { walkthrough: "future", reviewThread: "claude" },
        models: { future: "future-model", claude: "claude-opus-4-8" },
        autoQuality: "best",
        telemetryEnabled: false,
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        version: 7,
        diffViewMode: "auto",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        routes: { walkthrough: "future", reviewThread: "claude" },
        models: { future: "future-model", claude: "claude-opus-4-8" },
        futureProvider: { enabled: true },
      })
    }),
  )

  it.effect("decodes light and dark theme preferences independently", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...DEFAULT_AI_SETTINGS,
          themes: {
            light: "future-light-theme",
            dark: "catppuccin-macchiato",
            futureThemeSetting: true,
          },
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        const loaded = yield* appSettings.get
        yield* appSettings.save(loaded)
        return loaded
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.themes).toEqual({
        light: "diffdash",
        dark: "catppuccin-macchiato",
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        themes: {
          light: "diffdash",
          dark: "catppuccin-macchiato",
          futureThemeSetting: true,
        },
      })
    }),
  )

  it.effect("migrates and decodes light and dark code themes independently", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...DEFAULT_AI_SETTINGS,
          version: 5,
          themes: {
            light: "catppuccin-latte",
            dark: "catppuccin-macchiato",
          },
          codeThemes: {
            light: "future-light-code-theme",
            dark: "github-dark-default",
            futureCodeThemeSetting: true,
          },
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.codeThemes).toEqual({
        light: "catppuccin-latte",
        dark: "github-dark-default",
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        version: 7,
        codeThemes: {
          light: "catppuccin-latte",
          dark: "github-dark-default",
          futureCodeThemeSetting: true,
        },
      })
    }),
  )

  it.effect("migrates the version 6 dark code-theme default without replacing other choices", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...DEFAULT_AI_SETTINGS,
          version: 6,
          codeThemes: {
            light: "github-light-default",
            dark: "rose-pine-moon",
            futureCodeThemeSetting: true,
          },
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.version).toBe(7)
      expect(settings.codeThemes).toEqual({
        light: "github-light-default",
        dark: "diffdash-dark",
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        version: 7,
        codeThemes: {
          light: "github-light-default",
          dark: "diffdash-dark",
          futureCodeThemeSetting: true,
        },
      })
    }),
  )

  it.effect("defaults malformed pane widths without resetting unrelated settings", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        join(settingsDirectory, "settings.json"),
        JSON.stringify({
          ...DEFAULT_AI_SETTINGS,
          appearance: "dark",
          layout: {
            futureLayout: { enabled: true },
            review: {
              contextWidth: 12,
              threadDetailWidth: 512,
              futurePane: 777,
            },
          },
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        const loaded = yield* appSettings.get
        yield* appSettings.save(loaded)
        return loaded
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.appearance).toBe("dark")
      expect(settings.layout.review).toEqual({ contextWidth: 304, threadDetailWidth: 512 })
      expect(
        JSON.parse(readFileSync(join(settingsDirectory, "settings.json"), "utf8")),
      ).toMatchObject({
        layout: {
          futureLayout: { enabled: true },
          review: { contextWidth: 304, threadDetailWidth: 512, futurePane: 777 },
        },
      })
    }),
  )

  it.effect("reads a manual telemetry opt-out from settings JSON", () =>
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

  it.effect("FUN-131 AC: isolates telemetry and appearance from malformed provider settings", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        join(settingsDirectory, "settings.json"),
        JSON.stringify({
          version: 2,
          appearance: "dark",
          diffViewMode: "side-by-side",
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
      expect(settings.diffViewMode).toBe("auto")
      expect(settings.telemetryEnabled).toBe(false)
      expect(settings.routes).toEqual(DEFAULT_AI_SETTINGS.routes)
      expect(settings.models).toEqual(DEFAULT_AI_SETTINGS.models)
    }),
  )

  it.effect("falls back to defaults for invalid JSON", () =>
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
