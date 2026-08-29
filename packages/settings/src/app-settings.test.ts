import { describe, expect, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Result, Layer } from "effect"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  AIAgentSelection,
  AIModelId,
  AIProviderId,
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
          selections: {
            walkthrough: pinned("future", "future-model"),
            "review-thread": automatic(),
          },
        }),
      )

      yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        const loaded = yield* appSettings.get
        expect(loaded.selections.walkthrough).toEqual(pinned("future", "future-model"))
        yield* appSettings.save(AISettings.make({ ...loaded, appearance: "dark" }))
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        appearance: "dark",
        futureProvider: { enabled: true },
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "future", modelId: "future-model" },
          "review-thread": { _tag: "Automatic", quality: "balanced" },
        },
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
        version: 9,
        appearance: "dark",
        themes: { light: "diffdash", dark: "diffdash" },
        codeThemes: { light: "rose-pine-dawn", dark: "diffdash-dark" },
        diffViewMode: "auto",
        commentMode: "notes",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "codex", modelId: "gpt-5.6-luna" },
          "review-thread": { _tag: "Pinned", providerId: "codex", modelId: "gpt-5.6-luna" },
        },
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
        selections: {
          walkthrough: pinned("claude", "claude-opus-4-8"),
          "review-thread": pinned("opencode", "anthropic/claude-sonnet-5"),
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
        version: 9,
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "claude", modelId: "claude-opus-4-8" },
          "review-thread": {
            _tag: "Pinned",
            providerId: "opencode",
            modelId: "anthropic/claude-sonnet-5",
          },
        },
        telemetryEnabled: true,
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

      expect(settings.selections.walkthrough).toEqual(automatic())
      expect(settings.selections["review-thread"]).toEqual(automatic())
      expect(settings.appearance).toBe("system")
      expect(settings.telemetryEnabled).toBe(true)
    }),
  )

  it.effect("migrates version 7 routes and provider models independently per capability", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          version: 7,
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
        version: 9,
        appearance: "dark",
        themes: { light: "diffdash", dark: "diffdash" },
        codeThemes: { light: "rose-pine-dawn", dark: "diffdash-dark" },
        diffViewMode: "auto",
        commentMode: "notes",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "future", modelId: "future-model" },
          "review-thread": {
            _tag: "Pinned",
            providerId: "claude",
            modelId: "claude-opus-4-8",
          },
        },
        telemetryEnabled: false,
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        version: 9,
        diffViewMode: "auto",
        layout: {
          review: { contextWidth: 304, threadDetailWidth: 432 },
        },
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "future", modelId: "future-model" },
          "review-thread": {
            _tag: "Pinned",
            providerId: "claude",
            modelId: "claude-opus-4-8",
          },
        },
        futureProvider: { enabled: true },
      })
    }),
  )

  it.effect("preserves a version 7 provider route without a model as provider-default pinned", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          version: 7,
          routes: { walkthrough: "codex", reviewThread: "auto" },
          models: {},
          autoQuality: "best",
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.selections).toEqual({
        walkthrough: { _tag: "Pinned", providerId: "codex", modelId: null },
        "review-thread": { _tag: "Automatic", quality: "best" },
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        version: 9,
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "codex", modelId: null },
          "review-thread": { _tag: "Automatic", quality: "best" },
        },
      })
    }),
  )

  it.effect("repairs malformed version 8 capability selections independently and rewrites", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const settingsDirectory = join(directory, "diffdash")
      const settingsPath = join(settingsDirectory, "settings.json")
      mkdirSync(settingsDirectory, { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...DEFAULT_AI_SETTINGS,
          version: 8,
          appearance: "dark",
          selections: {
            walkthrough: pinned("codex", "gpt-5"),
            "review-thread": { _tag: "Pinned", providerId: 42, modelId: null },
          },
        }),
      )

      const settings = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* appSettings.get
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(settings.appearance).toBe("dark")
      expect(settings.selections).toEqual({
        walkthrough: pinned("codex", "gpt-5"),
        "review-thread": automatic(),
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        selections: {
          walkthrough: { _tag: "Pinned", providerId: "codex", modelId: "gpt-5" },
          "review-thread": { _tag: "Automatic", quality: "balanced" },
        },
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
        version: 9,
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

      expect(settings.version).toBe(9)
      expect(settings.codeThemes).toEqual({
        light: "github-light-default",
        dark: "diffdash-dark",
      })
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
        version: 9,
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
      expect(settings.selections).toEqual({
        walkthrough: { _tag: "Automatic", quality: "fast" },
        "review-thread": {
          _tag: "Pinned",
          providerId: "missing-provider",
          modelId: null,
        },
      })
    }),
  )

  it.effect("reports invalid JSON as a typed corruption error without rewriting it", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-malformed.txt")
      const settingsPath = join(directory, "diffdash", "settings.json")
      const corrupted = readFileSync(settingsPath, "utf8")

      const result = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* Effect.result(appSettings.get)
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AppSettingsError)
        expect(result.failure.operation).toBe("decode")
      }
      expect(readFileSync(settingsPath, "utf8")).toBe(corrupted)
    }),
  )

  it.effect("does not overwrite corrupted JSON when saving settings", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      installSettingsFixture(directory, "settings-malformed.txt")
      const settingsPath = join(directory, "diffdash", "settings.json")
      const corrupted = readFileSync(settingsPath, "utf8")

      const result = yield* Effect.gen(function* () {
        const appSettings = yield* AppSettings
        return yield* Effect.result(appSettings.save(DEFAULT_AI_SETTINGS))
      }).pipe(Effect.provide(makeLayer(directory)))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AppSettingsError)
        expect(result.failure.operation).toBe("decode")
      }
      expect(readFileSync(settingsPath, "utf8")).toBe(corrupted)
    }),
  )
})

const installSettingsFixture = (directory: string, fixtureName: string) => {
  const settingsDirectory = join(directory, "diffdash")
  mkdirSync(settingsDirectory, { recursive: true })
  copyFileSync(resolve("src/fixtures", fixtureName), join(settingsDirectory, "settings.json"))
}

const automatic = () => AIAgentSelection.cases.Automatic.make({ quality: "balanced" })

const pinned = (providerId: string, modelId: string) =>
  AIAgentSelection.cases.Pinned.make({
    providerId: AIProviderId.make(providerId),
    modelId: AIModelId.make(modelId),
  })
