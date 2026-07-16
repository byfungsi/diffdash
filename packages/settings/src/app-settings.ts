import { Context, Effect, Either, Layer, Schema } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import {
  AICapabilityRoutes,
  AI_SETTINGS_VERSION,
  AISettings,
  Appearance,
  AutoQuality,
  DEFAULT_AI_SETTINGS,
} from "@diffdash/domain/ai-settings"

const decodeAppearance = Schema.decodeUnknownEither(Appearance)
const decodeAutoQuality = Schema.decodeUnknownEither(AutoQuality)
const decodeTelemetry = Schema.decodeUnknownEither(Schema.Boolean)

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
    Layer.succeed(
      AppSettings,
      AppSettings.of({
        get: readSettingsFile(path).pipe(
          Effect.flatMap((content) => {
            if (content === null) return Effect.succeed(DEFAULT_AI_SETTINGS)
            const decoded = decodeSettings(content)
            if (!decoded.migrated) return Effect.succeed(decoded.settings)
            return writeSettingsFile(path, mergeSettings(content, decoded.settings)).pipe(
              Effect.as(decoded.settings),
            )
          }),
        ),
        save: Effect.fn("AppSettings.save")(function (settings) {
          return readSettingsFile(path).pipe(
            Effect.flatMap((content) => writeSettingsFile(path, mergeSettings(content, settings))),
            Effect.as(settings),
          )
        }),
      }),
    )
}

const readSettingsFile = (path: string): Effect.Effect<string | null, AppSettingsError> =>
  Effect.try({
    try: () => {
      try {
        return readFileSync(path, "utf8")
      } catch (cause) {
        if (isNodeError(cause) && cause.code === "ENOENT") return null
        throw cause
      }
    },
    catch: (cause) => AppSettingsError.make({ operation: "read", cause }),
  })

const writeSettingsFile = (
  path: string,
  settings: unknown,
): Effect.Effect<void, AppSettingsError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
    },
    catch: (cause) => AppSettingsError.make({ operation: "write", cause }),
  })

const isNodeError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause

const mergeSettings = (content: string | null, settings: AISettings): unknown => {
  if (content === null) return settings
  try {
    const existing: unknown = JSON.parse(content)
    if (!isRecord(existing)) return settings
    const existingModels = isRecord(existing.models) ? existing.models : {}
    const { provider: _legacyProvider, ...current } = existing
    const { auto: _legacyAutoQuality, ...providerModels } = existingModels
    return { ...current, ...settings, models: { ...providerModels, ...settings.models } }
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
  if (!isRecord(parsed)) return { settings: DEFAULT_AI_SETTINGS, migrated: false }

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
  const migrated =
    typeof parsed.version !== "number" ||
    !Number.isInteger(parsed.version) ||
    parsed.version < AI_SETTINGS_VERSION
  const agentSettings = migrated
    ? migrateLegacyAgentSettings(parsed)
    : decodeCurrentAgentSettings(parsed)

  return {
    migrated,
    settings: AISettings.make({
      version: AI_SETTINGS_VERSION,
      appearance,
      telemetryEnabled,
      ...agentSettings,
    }),
  }
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
  const legacyModels = isRecord(settings.models) ? settings.models : {}
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
