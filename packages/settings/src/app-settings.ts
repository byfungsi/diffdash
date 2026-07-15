import { Context, Effect, Layer, Schema } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"

const AISettingsFromJson = Schema.parseJson(AISettings)

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

            return Schema.decodeUnknown(AISettingsFromJson)(content).pipe(
              Effect.catchAll(() => Effect.succeed(DEFAULT_AI_SETTINGS)),
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
    return { ...existing, ...settings, models: { ...existingModels, ...settings.models } }
  } catch {
    return settings
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
