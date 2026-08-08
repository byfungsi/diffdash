import { Context, Effect, Result, Layer, Predicate, Schema } from "effect"

import {
  AICapabilityRoutes,
  AI_SETTINGS_VERSION,
  AISettings,
  Appearance,
  AutoQuality,
  CodeThemePreferences,
  DarkCodeTheme,
  DarkTheme,
  DEFAULT_AI_SETTINGS,
  DIFFDASH_DARK_CODE_THEME,
  DiffViewMode,
  LightCodeTheme,
  LightTheme,
  ThemePreferences,
} from "@diffdash/domain/ai-settings"
import {
  DEFAULT_RENDERER_LAYOUT_SETTINGS,
  RendererLayoutSettings,
  ReviewContextPaneWidth,
  ReviewPaneSettings,
  ReviewThreadDetailPaneWidth,
} from "@diffdash/domain/renderer-layout-settings"
import { FileStorage, type FileStorageOperations } from "./file-storage"

const decodeAppearance = Schema.decodeUnknownResult(Appearance)
const decodeAutoQuality = Schema.decodeUnknownResult(AutoQuality)
const decodeDiffViewMode = Schema.decodeUnknownResult(DiffViewMode)
const decodeLightCodeTheme = Schema.decodeUnknownResult(LightCodeTheme)
const decodeDarkCodeTheme = Schema.decodeUnknownResult(DarkCodeTheme)
const decodeLightTheme = Schema.decodeUnknownResult(LightTheme)
const decodeDarkTheme = Schema.decodeUnknownResult(DarkTheme)
const decodeTelemetry = Schema.decodeUnknownResult(Schema.Boolean)
const decodeReviewContextPaneWidth = Schema.decodeUnknownResult(ReviewContextPaneWidth)
const decodeReviewThreadDetailPaneWidth = Schema.decodeUnknownResult(ReviewThreadDetailPaneWidth)

/** A typed failure from reading or writing user settings. */
export class AppSettingsError extends Schema.TaggedError<AppSettingsError>()("AppSettingsError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Main-process service for JSON-backed user settings. */
export class AppSettings extends Context.Service<
  AppSettings,
  {
    readonly get: Effect.Effect<AISettings, AppSettingsError>
    readonly save: (settings: AISettings) => Effect.Effect<AISettings, AppSettingsError>
  }
>()("@diffdash/AppSettings") {
  static readonly layer = (path: string) =>
    Layer.effect(
      AppSettings,
      Effect.gen(function* () {
        const storage = yield* FileStorage
        return AppSettings.of({
          get: readSettingsFile(storage, path).pipe(
            Effect.flatMap((content) => {
              if (content === null) return Effect.succeed(DEFAULT_AI_SETTINGS)
              const decoded = decodeSettings(content)
              if (!decoded.migrated) return Effect.succeed(decoded.settings)
              return writeSettingsFile(
                storage,
                path,
                mergeSettings(content, decoded.settings),
              ).pipe(Effect.as(decoded.settings))
            }),
          ),
          save: Effect.fn("AppSettings.save")(function (settings) {
            return readSettingsFile(storage, path).pipe(
              Effect.flatMap((content) =>
                writeSettingsFile(storage, path, mergeSettings(content, settings)),
              ),
              Effect.as(settings),
            )
          }),
        })
      }),
    )
}

const readSettingsFile = (
  storage: FileStorageOperations,
  path: string,
): Effect.Effect<string | null, AppSettingsError> =>
  storage
    .readOptionalTextFile(path)
    .pipe(Effect.mapError((error) => AppSettingsError.make({ operation: "read", cause: error })))

const writeSettingsFile = (
  storage: FileStorageOperations,
  path: string,
  settings: unknown,
): Effect.Effect<void, AppSettingsError> =>
  storage
    .writePrettyJsonFile(path, settings)
    .pipe(Effect.mapError((error) => AppSettingsError.make({ operation: "write", cause: error })))

const mergeSettings = (content: string | null, settings: AISettings): unknown => {
  if (content === null) return settings
  try {
    const existing: unknown = JSON.parse(content)
    if (!Predicate.isReadonlyObject(existing)) return settings
    const existingModels = Predicate.isReadonlyObject(existing.models) ? existing.models : {}
    const existingLayout = Predicate.isReadonlyObject(existing.layout) ? existing.layout : {}
    const existingThemes = Predicate.isReadonlyObject(existing.themes) ? existing.themes : {}
    const existingCodeThemes = Predicate.isReadonlyObject(existing.codeThemes)
      ? existing.codeThemes
      : {}
    const existingReviewLayout = Predicate.isReadonlyObject(existingLayout.review)
      ? existingLayout.review
      : {}
    const { provider: _legacyProvider, ...current } = existing
    const { auto: _legacyAutoQuality, ...providerModels } = existingModels
    return {
      ...current,
      ...settings,
      layout: {
        ...existingLayout,
        ...settings.layout,
        review: { ...existingReviewLayout, ...settings.layout.review },
      },
      themes: { ...existingThemes, ...settings.themes },
      codeThemes: { ...existingCodeThemes, ...settings.codeThemes },
      models: { ...providerModels, ...settings.models },
    }
  } catch {
    return settings
  }
}

const decodeSettings = (
  content: string,
): { readonly settings: AISettings; readonly migrated: boolean } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { settings: DEFAULT_AI_SETTINGS, migrated: false }
  }
  if (!Predicate.isReadonlyObject(parsed)) return { settings: DEFAULT_AI_SETTINGS, migrated: false }

  const appearance = decodeOrDefault(
    decodeAppearance,
    parsed.appearance,
    DEFAULT_AI_SETTINGS.appearance,
  )
  const telemetryEnabled = decodeOrDefault(
    decodeTelemetry,
    parsed.telemetryEnabled,
    DEFAULT_AI_SETTINGS.telemetryEnabled,
  )
  const diffViewMode = decodeOrDefault(
    decodeDiffViewMode,
    parsed.diffViewMode,
    DEFAULT_AI_SETTINGS.diffViewMode,
  )
  const sourceVersion =
    typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null
  const layout = decodeRendererLayoutSettings(parsed.layout)
  const themes = decodeThemePreferences(parsed.themes)
  const decodedCodeThemes = decodeCodeThemePreferences(
    parsed.codeThemes,
    sourceVersion === null || sourceVersion < 6
      ? legacyCodeThemePreferences(themes)
      : DEFAULT_AI_SETTINGS.codeThemes,
  )
  const codeThemes =
    sourceVersion === null || sourceVersion < 7
      ? migrateVersion7CodeThemes(decodedCodeThemes)
      : decodedCodeThemes
  const migrated = sourceVersion === null || sourceVersion < AI_SETTINGS_VERSION
  const agentSettings =
    sourceVersion !== null && sourceVersion >= 2
      ? decodeCurrentAgentSettings(parsed)
      : migrateLegacyAgentSettings(parsed)

  return {
    migrated,
    settings: AISettings.make({
      version: AI_SETTINGS_VERSION,
      appearance,
      themes,
      codeThemes,
      diffViewMode,
      layout,
      telemetryEnabled,
      ...agentSettings,
    }),
  }
}

const decodeThemePreferences = (value: unknown): ThemePreferences => {
  const themes = Predicate.isReadonlyObject(value) ? value : {}
  return ThemePreferences.make({
    light: decodeOrDefault(decodeLightTheme, themes.light, DEFAULT_AI_SETTINGS.themes.light),
    dark: decodeOrDefault(decodeDarkTheme, themes.dark, DEFAULT_AI_SETTINGS.themes.dark),
  })
}

const decodeCodeThemePreferences = (
  value: unknown,
  fallback: CodeThemePreferences,
): CodeThemePreferences => {
  const codeThemes = Predicate.isReadonlyObject(value) ? value : {}
  return CodeThemePreferences.make({
    light: decodeOrDefault(decodeLightCodeTheme, codeThemes.light, fallback.light),
    dark: decodeOrDefault(decodeDarkCodeTheme, codeThemes.dark, fallback.dark),
  })
}

const legacyCodeThemePreferences = (themes: ThemePreferences): CodeThemePreferences =>
  CodeThemePreferences.make({
    light: themes.light === "catppuccin-latte" ? "catppuccin-latte" : "rose-pine-dawn",
    dark: themes.dark === "diffdash" ? "rose-pine-moon" : themes.dark,
  })

const migrateVersion7CodeThemes = (codeThemes: CodeThemePreferences): CodeThemePreferences =>
  codeThemes.dark === "rose-pine-moon"
    ? CodeThemePreferences.make({ ...codeThemes, dark: DIFFDASH_DARK_CODE_THEME })
    : codeThemes

const decodeRendererLayoutSettings = (value: unknown): RendererLayoutSettings => {
  const layout = Predicate.isReadonlyObject(value) ? value : {}
  const review = Predicate.isReadonlyObject(layout.review) ? layout.review : {}
  return RendererLayoutSettings.make({
    review: ReviewPaneSettings.make({
      contextWidth: decodeOrDefault(
        decodeReviewContextPaneWidth,
        review.contextWidth,
        DEFAULT_RENDERER_LAYOUT_SETTINGS.review.contextWidth,
      ),
      threadDetailWidth: decodeOrDefault(
        decodeReviewThreadDetailPaneWidth,
        review.threadDetailWidth,
        DEFAULT_RENDERER_LAYOUT_SETTINGS.review.threadDetailWidth,
      ),
    }),
  })
}

const decodeCurrentAgentSettings = (settings: Readonly<Record<string, unknown>>) => {
  const result = Schema.decodeUnknownResult(
    Schema.Struct({
      routes: AICapabilityRoutes,
      models: AISettings.fields.models,
      autoQuality: AutoQuality,
    }),
  )({
    routes: settings.routes,
    models: settings.models,
    autoQuality: settings.autoQuality,
  })
  return Result.isSuccess(result)
    ? result.success
    : {
        routes: DEFAULT_AI_SETTINGS.routes,
        models: DEFAULT_AI_SETTINGS.models,
        autoQuality: DEFAULT_AI_SETTINGS.autoQuality,
      }
}

const migrateLegacyAgentSettings = (settings: Readonly<Record<string, unknown>>) => {
  const provider = nonEmptyString(settings.provider) ?? "auto"
  const legacyModels = Predicate.isReadonlyObject(settings.models) ? settings.models : {}
  const models = { ...DEFAULT_AI_SETTINGS.models }
  for (const [providerId, modelId] of Object.entries(legacyModels)) {
    if (providerId === "auto") continue
    const model = nonEmptyString(modelId)
    if (providerId.length > 0 && model !== null) models[providerId] = model
  }
  const legacyQuality = legacyModels.auto === "balance" ? "balanced" : legacyModels.auto
  const autoQuality = decodeOrDefault(
    decodeAutoQuality,
    legacyQuality,
    DEFAULT_AI_SETTINGS.autoQuality,
  )

  return {
    routes: AICapabilityRoutes.make({ walkthrough: provider, reviewThread: provider }),
    models,
    autoQuality,
  }
}

const decodeOrDefault = <A>(
  decode: (value: unknown) => Result.Result<A, unknown>,
  value: unknown,
  fallback: A,
): A => {
  const result = decode(value)
  return Result.isSuccess(result) ? result.success : fallback
}

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null
