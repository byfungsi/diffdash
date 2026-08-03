import { Context, Effect, Either, Layer, Predicate, Schema } from "effect"

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

const decodeAppearance = Schema.decodeUnknownEither(Appearance)
const decodeAutoQuality = Schema.decodeUnknownEither(AutoQuality)
const decodeDiffViewMode = Schema.decodeUnknownEither(DiffViewMode)
const decodeLightCodeTheme = Schema.decodeUnknownEither(LightCodeTheme)
const decodeDarkCodeTheme = Schema.decodeUnknownEither(DarkCodeTheme)
const decodeLightTheme = Schema.decodeUnknownEither(LightTheme)
const decodeDarkTheme = Schema.decodeUnknownEither(DarkTheme)
const decodeTelemetry = Schema.decodeUnknownEither(Schema.Boolean)
const decodeReviewContextPaneWidth = Schema.decodeUnknownEither(ReviewContextPaneWidth)
const decodeReviewThreadDetailPaneWidth = Schema.decodeUnknownEither(ReviewThreadDetailPaneWidth)

/** A typed failure from reading or writing user settings. */
export class AppSettingsError extends Schema.TaggedError<AppSettingsError>()("AppSettingsError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

/** Main-process service for JSON-backed user settings. */
export class AppSettings extends Context.Tag("@diffdash/AppSettings")<
  AppSettings,
  {
    readonly get: Effect.Effect<AISettings, AppSettingsError>
    readonly save: (settings: AISettings) => Effect.Effect<AISettings, AppSettingsError>
  }
>() {
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
    if (!Predicate.isReadonlyRecord(existing)) return settings
    const existingModels = Predicate.isReadonlyRecord(existing.models) ? existing.models : {}
    const existingLayout = Predicate.isReadonlyRecord(existing.layout) ? existing.layout : {}
    const existingThemes = Predicate.isReadonlyRecord(existing.themes) ? existing.themes : {}
    const existingCodeThemes = Predicate.isReadonlyRecord(existing.codeThemes)
      ? existing.codeThemes
      : {}
    const existingReviewLayout = Predicate.isReadonlyRecord(existingLayout.review)
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
  if (!Predicate.isReadonlyRecord(parsed)) return { settings: DEFAULT_AI_SETTINGS, migrated: false }

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
  const themes = Predicate.isReadonlyRecord(value) ? value : {}
  return ThemePreferences.make({
    light: decodeOrDefault(decodeLightTheme, themes.light, DEFAULT_AI_SETTINGS.themes.light),
    dark: decodeOrDefault(decodeDarkTheme, themes.dark, DEFAULT_AI_SETTINGS.themes.dark),
  })
}

const decodeCodeThemePreferences = (
  value: unknown,
  fallback: CodeThemePreferences,
): CodeThemePreferences => {
  const codeThemes = Predicate.isReadonlyRecord(value) ? value : {}
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
  const layout = Predicate.isReadonlyRecord(value) ? value : {}
  const review = Predicate.isReadonlyRecord(layout.review) ? layout.review : {}
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
  const result = Schema.decodeUnknownEither(
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
  return Either.isRight(result)
    ? result.right
    : {
        routes: DEFAULT_AI_SETTINGS.routes,
        models: DEFAULT_AI_SETTINGS.models,
        autoQuality: DEFAULT_AI_SETTINGS.autoQuality,
      }
}

const migrateLegacyAgentSettings = (settings: Readonly<Record<string, unknown>>) => {
  const provider = nonEmptyString(settings.provider) ?? "auto"
  const legacyModels = Predicate.isReadonlyRecord(settings.models) ? settings.models : {}
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
  decode: (value: unknown) => Either.Either<A, unknown>,
  value: unknown,
  fallback: A,
): A => {
  const result = decode(value)
  return Either.isRight(result) ? result.right : fallback
}

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null
