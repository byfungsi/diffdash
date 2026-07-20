import { Schema } from "effect"

/** Current persisted settings format. */
export const AI_SETTINGS_VERSION = 2 as const

/** Application appearance preference. */
export const Appearance = Schema.Literal("light", "dark", "system")

/** Application appearance selected in user settings. */
export type Appearance = typeof Appearance.Type

/** Automatic model quality used by capability routing. */
export const AutoQuality = Schema.Literal("fast", "balanced", "best")

/** Automatic model quality used by capability routing. */
export type AutoQuality = typeof AutoQuality.Type

/** A capability route selected automatically or pinned to an open provider ID. */
export const AICapabilityRoute = Schema.String.pipe(Schema.minLength(1))

/** A capability route selected automatically or pinned to an open provider ID. */
export type AICapabilityRoute = typeof AICapabilityRoute.Type

/** Independent provider routes for each agent capability. */
export const AICapabilityRoutes = Schema.Struct({
  walkthrough: AICapabilityRoute,
  reviewThread: AICapabilityRoute,
})

/** Independent provider routes for each agent capability. */
export type AICapabilityRoutes = typeof AICapabilityRoutes.Type

/** Open provider-to-model selections retained even when a provider package is absent. */
export const AIProviderModels = Schema.Record({
  key: Schema.String.pipe(Schema.minLength(1)),
  value: Schema.String.pipe(Schema.minLength(1)),
})

/** Open provider-to-model selections retained even when a provider package is absent. */
export type AIProviderModels = typeof AIProviderModels.Type

/** User-configurable application settings persisted as versioned JSON. */
export class AISettings extends Schema.Class<AISettings>("AISettings")({
  version: Schema.Literal(AI_SETTINGS_VERSION),
  appearance: Appearance,
  routes: AICapabilityRoutes,
  models: AIProviderModels,
  autoQuality: AutoQuality,
  telemetryEnabled: Schema.Boolean,
}) {}

/** Default AI settings for first launch and invalid/missing agent settings. */
export const DEFAULT_AI_SETTINGS = AISettings.make({
  version: AI_SETTINGS_VERSION,
  appearance: "system",
  routes: AICapabilityRoutes.make({ walkthrough: "auto", reviewThread: "auto" }),
  models: {},
  autoQuality: "balanced",
  telemetryEnabled: true,
})
