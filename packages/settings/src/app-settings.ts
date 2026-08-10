import { Context, Effect, Result, Layer, Predicate, Schema } from "effect"

import {
  AIAgentSelection,
  AIAgentSelections,
  AI_SETTINGS_VERSION,
  AIModelId,
  AIProviderId,
  AISettings,
  AgentModelQuality,
  Appearance,
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

const Version7CapabilityRoute = Schema.Union([Schema.Literal("auto"), AIProviderId])

const Version7AgentSettingsSource = Schema.Struct({
  routes: Schema.Struct({
    walkthrough: Version7CapabilityRoute,
    reviewThread: Version7CapabilityRoute,
  }),
  models: Schema.Record(AIProviderId, AIModelId),
  autoQuality: AgentModelQuality,
})
type Version7AgentSettingsSource = typeof Version7AgentSettingsSource.Type

const LegacyAgentSettingsSource = Schema.Struct({
  provider: Schema.NonEmptyString,
  models: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
})
type LegacyAgentSettingsSource = typeof LegacyAgentSettingsSource.Type
const JsonObject = Schema.Record(Schema.String, Schema.Json)
type JsonObject = typeof JsonObject.Type

/** A typed failure from reading or writing user settings. */
export class AppSettingsError extends Schema.TaggedError<AppSettingsError>()("AppSettingsError", {
  operation: Schema.String,
  cause: Schema.ErrorInstance(),
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
              return parseSettingsContent(content).pipe(
                Effect.flatMap((parsed) => {
                  const decoded = decodeSettings(parsed)
                  if (!decoded.migrated) return Effect.succeed(decoded.settings)
                  return writeSettingsFile(
                    storage,
                    path,
                    mergeSettings(parsed, decoded.settings),
                  ).pipe(Effect.as(decoded.settings))
                }),
              )
            }),
          ),
          save: Effect.fn("AppSettings.save")(function (settings) {
            return readSettingsFile(storage, path).pipe(
              Effect.flatMap((content) =>
                content === null
                  ? writeSettingsFile(storage, path, mergeSettings(null, settings))
                  : parseSettingsContent(content).pipe(
                      Effect.flatMap((parsed) =>
                        writeSettingsFile(storage, path, mergeSettings(parsed, settings)),
                      ),
                    ),
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
  settings: Schema.Json,
): Effect.Effect<void, AppSettingsError> =>
  storage
    .writePrettyJsonFile(path, settings)
    .pipe(Effect.mapError((error) => AppSettingsError.make({ operation: "write", cause: error })))

const parseSettingsContent = (content: string): Effect.Effect<Schema.Json, AppSettingsError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(content),
    catch: (cause) =>
      AppSettingsError.make({
        operation: "decode",
        cause: Predicate.isError(cause) ? cause : new Error("Settings JSON decoding failed"),
      }),
  })

const mergeSettings = (content: Schema.Json | null, settings: AISettings): Schema.Json => {
  const encodedSettings = Schema.decodeUnknownSync(Schema.Json)(
    Schema.encodeUnknownSync(AISettings)(settings),
  )
  const encodedSettingsObject = parseJsonObject(encodedSettings)
  if (content === null) return encodedSettingsObject
  const existing = parseJsonObject(content)
  const existingLayout = parseJsonObject(existing.layout)
  const existingThemes = parseJsonObject(existing.themes)
  const existingCodeThemes = parseJsonObject(existing.codeThemes)
  const existingReviewLayout = parseJsonObject(existingLayout.review)
  const {
    provider: _legacyProvider,
    routes: _legacyRoutes,
    models: _legacyModels,
    autoQuality: _legacyAutoQuality,
    ...current
  } = existing
  return {
    ...current,
    ...encodedSettingsObject,
    layout: {
      ...existingLayout,
      ...parseJsonObject(encodedSettingsObject.layout),
      review: {
        ...existingReviewLayout,
        ...parseJsonObject(parseJsonObject(encodedSettingsObject.layout).review),
      },
    },
    themes: {
      ...existingThemes,
      ...parseJsonObject(encodedSettingsObject.themes),
    },
    codeThemes: {
      ...existingCodeThemes,
      ...parseJsonObject(encodedSettingsObject.codeThemes),
    },
  }
}

const decodeSettings = (
  parsed: Schema.Json,
): { readonly settings: AISettings; readonly migrated: boolean } => {
  const parsedObject = parseJsonObject(parsed)

  const appearance = decodeOrDefault(
    Appearance,
    parsedObject.appearance,
    DEFAULT_AI_SETTINGS.appearance,
  )
  const telemetryEnabled = decodeOrDefault(
    Schema.Boolean,
    parsedObject.telemetryEnabled,
    DEFAULT_AI_SETTINGS.telemetryEnabled,
  )
  const diffViewMode = decodeOrDefault(
    DiffViewMode,
    parsedObject.diffViewMode,
    DEFAULT_AI_SETTINGS.diffViewMode,
  )
  const sourceVersion =
    Schema.is(Schema.Number)(parsedObject.version) && Number.isInteger(parsedObject.version)
      ? parsedObject.version
      : null
  const layout = decodeRendererLayoutSettings(parsedObject.layout)
  const themes = decodeThemePreferences(parsedObject.themes)
  const decodedCodeThemes = decodeCodeThemePreferences(
    parsedObject.codeThemes,
    sourceVersion === null || sourceVersion < 6
      ? legacyCodeThemePreferences(themes)
      : DEFAULT_AI_SETTINGS.codeThemes,
  )
  const codeThemes =
    sourceVersion === null || sourceVersion < 7
      ? migrateVersion7CodeThemes(decodedCodeThemes)
      : decodedCodeThemes
  const agentSettings =
    sourceVersion !== null && sourceVersion >= 8
      ? parseVersion8AgentSettingsSource(parsedObject)
      : {
          selections:
            sourceVersion !== null && sourceVersion >= 2
              ? migrateVersion7AgentSettings(parseVersion7AgentSettingsSource(parsedObject))
              : migrateVersion7AgentSettings(
                  migrateLegacyAgentSettings(parseLegacyAgentSettingsSource(parsedObject)),
                ),
          repaired: false,
        }
  const migrated =
    sourceVersion === null || sourceVersion < AI_SETTINGS_VERSION || agentSettings.repaired

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

const decodeThemePreferences = (value: Schema.Json | undefined): ThemePreferences => {
  const themes = parseJsonObject(value)
  return ThemePreferences.make({
    light: decodeOrDefault(LightTheme, themes.light, DEFAULT_AI_SETTINGS.themes.light),
    dark: decodeOrDefault(DarkTheme, themes.dark, DEFAULT_AI_SETTINGS.themes.dark),
  })
}

const decodeCodeThemePreferences = (
  value: Schema.Json | undefined,
  fallback: CodeThemePreferences,
): CodeThemePreferences => {
  const codeThemes = parseJsonObject(value)
  return CodeThemePreferences.make({
    light: decodeOrDefault(LightCodeTheme, codeThemes.light, fallback.light),
    dark: decodeOrDefault(DarkCodeTheme, codeThemes.dark, fallback.dark),
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

const decodeRendererLayoutSettings = (value: Schema.Json | undefined): RendererLayoutSettings => {
  const layout = parseJsonObject(value)
  const review = parseJsonObject(layout.review)
  return RendererLayoutSettings.make({
    review: ReviewPaneSettings.make({
      contextWidth: decodeOrDefault(
        ReviewContextPaneWidth,
        review.contextWidth,
        DEFAULT_RENDERER_LAYOUT_SETTINGS.review.contextWidth,
      ),
      threadDetailWidth: decodeOrDefault(
        ReviewThreadDetailPaneWidth,
        review.threadDetailWidth,
        DEFAULT_RENDERER_LAYOUT_SETTINGS.review.threadDetailWidth,
      ),
    }),
  })
}

const parseVersion8AgentSettingsSource = (
  value: Schema.Json | undefined,
): { readonly selections: AIAgentSelections; readonly repaired: boolean } => {
  const settings = parseJsonObject(value)
  const selections = parseJsonObject(settings.selections)
  const walkthrough = Schema.decodeUnknownResult(AIAgentSelection)(selections.walkthrough)
  const reviewThread = Schema.decodeUnknownResult(AIAgentSelection)(selections["review-thread"])
  return {
    selections: AIAgentSelections.make({
      walkthrough: Result.isSuccess(walkthrough)
        ? walkthrough.success
        : DEFAULT_AI_SETTINGS.selections.walkthrough,
      "review-thread": Result.isSuccess(reviewThread)
        ? reviewThread.success
        : DEFAULT_AI_SETTINGS.selections["review-thread"],
    }),
    repaired: Result.isFailure(walkthrough) || Result.isFailure(reviewThread),
  }
}

const parseVersion7AgentSettingsSource = (
  value: Schema.Json | undefined,
): Version7AgentSettingsSource => {
  const settings = parseJsonObject(value)
  const routes = parseJsonObject(settings.routes)
  const encodedModels = parseJsonObject(settings.models)
  const models: Record<AIProviderId, AIModelId> = {}
  for (const [providerId, modelId] of Object.entries(encodedModels)) {
    const provider = Schema.decodeUnknownResult(AIProviderId)(providerId)
    const model = Schema.decodeUnknownResult(AIModelId)(modelId)
    if (Result.isSuccess(provider) && Result.isSuccess(model)) {
      models[provider.success] = model.success
    }
  }
  return {
    routes: {
      walkthrough: decodeOrDefault(Version7CapabilityRoute, routes.walkthrough, "auto"),
      reviewThread: decodeOrDefault(Version7CapabilityRoute, routes.reviewThread, "auto"),
    },
    models,
    autoQuality: decodeOrDefault(AgentModelQuality, settings.autoQuality, "balanced"),
  }
}

const parseLegacyAgentSettingsSource = (
  value: Schema.Json | undefined,
): LegacyAgentSettingsSource => {
  const settings = parseJsonObject(value)
  const legacyModels = parseJsonObject(settings.models)
  const models = Object.fromEntries(
    Object.entries(legacyModels).flatMap(([providerId, modelId]) => {
      const provider = Schema.decodeUnknownResult(Schema.NonEmptyString)(providerId)
      const model = Schema.decodeUnknownResult(Schema.NonEmptyString)(modelId)
      return Result.isSuccess(provider) && Result.isSuccess(model)
        ? [[provider.success, model.success] as const]
        : []
    }),
  )
  const provider = Schema.decodeUnknownResult(Schema.NonEmptyString)(settings.provider)
  const result = Schema.decodeUnknownResult(LegacyAgentSettingsSource)({
    provider: Result.isSuccess(provider) ? provider.success : "auto",
    models,
  })
  return Result.isSuccess(result) ? result.success : { provider: "auto", models: {} }
}

const migrateLegacyAgentSettings = (
  settings: LegacyAgentSettingsSource,
): Version7AgentSettingsSource => {
  const models: Record<AIProviderId, AIModelId> = {}
  for (const [providerId, modelId] of Object.entries(settings.models)) {
    if (providerId === "auto") continue
    if (providerId.length > 0) models[AIProviderId.make(providerId)] = AIModelId.make(modelId)
  }
  const legacyQuality = settings.models.auto === "balance" ? "balanced" : settings.models.auto
  const autoQuality = decodeOrDefault(AgentModelQuality, legacyQuality, "balanced")

  return {
    routes: {
      walkthrough: settings.provider === "auto" ? "auto" : AIProviderId.make(settings.provider),
      reviewThread: settings.provider === "auto" ? "auto" : AIProviderId.make(settings.provider),
    },
    models,
    autoQuality,
  }
}

const migrateVersion7AgentSettings = (settings: Version7AgentSettingsSource): AIAgentSelections =>
  AIAgentSelections.make({
    walkthrough: migrateVersion7CapabilitySelection(
      settings.routes.walkthrough,
      settings.models,
      settings.autoQuality,
    ),
    "review-thread": migrateVersion7CapabilitySelection(
      settings.routes.reviewThread,
      settings.models,
      settings.autoQuality,
    ),
  })

const migrateVersion7CapabilitySelection = (
  route: Version7AgentSettingsSource["routes"]["walkthrough"],
  models: Version7AgentSettingsSource["models"],
  quality: Version7AgentSettingsSource["autoQuality"],
) => {
  if (route === "auto") return AIAgentSelection.cases.Automatic.make({ quality })
  const modelId = models[route]
  return AIAgentSelection.cases.Pinned.make({ providerId: route, modelId: modelId ?? null })
}

const decodeOrDefault = <S extends Schema.ConstraintDecoder<unknown>, A>(
  schema: S,
  value: A,
  fallback: S["Type"],
): S["Type"] => {
  const result = Schema.decodeUnknownResult(schema)(value)
  return Result.isSuccess(result) ? result.success : fallback
}

const parseJsonObject = <A>(value: A): JsonObject => {
  const result = Schema.decodeUnknownResult(JsonObject)(value)
  return Result.isSuccess(result) ? result.success : {}
}
