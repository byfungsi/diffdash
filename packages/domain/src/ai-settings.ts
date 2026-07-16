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

/** Known built-in provider IDs used by the current adapters and renderer catalog. */
export const BUILT_IN_AI_PROVIDERS = ["claude", "codex", "opencode"] as const

/** Known built-in provider ID used by adapters that have not yet moved into provider packages. */
export type BuiltInAIProvider = (typeof BUILT_IN_AI_PROVIDERS)[number]

/** Ordered built-in fallback used until capability routing moves fully to the SDK registry. */
export const AUTO_AI_PROVIDER_ORDER: readonly BuiltInAIProvider[] = BUILT_IN_AI_PROVIDERS

/** Default model IDs for the built-in providers. */
export const DEFAULT_BUILT_IN_MODELS = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.3-codex-spark",
  opencode: "openai/gpt-5.3-codex-spark",
} as const

/** Default AI settings for first launch and invalid/missing agent settings. */
export const DEFAULT_AI_SETTINGS = AISettings.make({
  version: AI_SETTINGS_VERSION,
  appearance: "system",
  routes: AICapabilityRoutes.make({ walkthrough: "auto", reviewThread: "auto" }),
  models: {
    claude: DEFAULT_BUILT_IN_MODELS.claude,
    codex: DEFAULT_BUILT_IN_MODELS.codex,
    opencode: DEFAULT_BUILT_IN_MODELS.opencode,
  },
  autoQuality: "balanced",
  telemetryEnabled: true,
})

/** Display metadata for a built-in provider option. */
export interface AIProviderOption {
  readonly label: string
  readonly provider: AICapabilityRoute
}

/** Display metadata for a model option. */
export interface AIModelOption {
  readonly label: string
  readonly model: string
}

/** Concrete built-in models used for an automatic model quality tier. */
export interface AutoQualityProviderModels {
  readonly claude: string
  readonly codex: string
  readonly opencodeClaude: string
  readonly opencodeCodex: string
}

/** Built-in provider options shown until renderer controls are manifest-driven. */
export const AI_PROVIDER_OPTIONS: readonly AIProviderOption[] = [
  { provider: "auto", label: "Auto" },
  { provider: "codex", label: "Codex" },
  { provider: "claude", label: "Claude" },
  { provider: "opencode", label: "OpenCode" },
]

/** Codex model options shown in settings. */
export const CODEX_MODEL_OPTIONS: readonly AIModelOption[] = [
  { model: "gpt-5.5", label: "GPT 5.5" },
  { model: "gpt-5.3-codex-spark", label: "GPT 5.3 Codex Spark" },
  { model: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
]

/** Automatic model quality tiers shown in settings. */
export const AUTO_MODEL_OPTIONS: readonly AIModelOption[] = [
  { model: "best", label: "Best" },
  { model: "balanced", label: "Balance" },
  { model: "fast", label: "Fast" },
]

/** Claude model options shown in settings. */
export const CLAUDE_MODEL_OPTIONS: readonly AIModelOption[] = [
  { model: "claude-opus-4-8", label: "Opus 4.8" },
  { model: "claude-sonnet-5", label: "Sonnet 5.0" },
  { model: "claude-haiku-4-5", label: "Haiku 4.5" },
]

/** OpenCode model options shown in settings. */
export const OPENCODE_MODEL_OPTIONS: readonly AIModelOption[] = [
  { model: "openai/gpt-5.5", label: "GPT 5.5" },
  { model: "openai/gpt-5.3-codex-spark", label: "GPT 5.3 Codex Spark" },
  { model: "openai/gpt-5.4-mini", label: "GPT 5.4 Mini" },
  { model: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
  { model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5.0" },
  { model: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
]

/** Returns built-in model IDs for an automatic quality tier. */
export const autoQualityProviderModels = (quality: AutoQuality): AutoQualityProviderModels => {
  if (quality === "best") {
    return {
      claude: "claude-opus-4-8",
      codex: "gpt-5.5",
      opencodeClaude: "anthropic/claude-opus-4-8",
      opencodeCodex: "openai/gpt-5.5",
    }
  }

  if (quality === "fast") {
    return {
      claude: "claude-haiku-4-5",
      codex: "gpt-5.4-mini",
      opencodeClaude: "anthropic/claude-haiku-4-5",
      opencodeCodex: "openai/gpt-5.4-mini",
    }
  }

  return {
    claude: "claude-sonnet-5",
    codex: "gpt-5.3-codex-spark",
    opencodeClaude: "anthropic/claude-sonnet-5",
    opencodeCodex: "openai/gpt-5.3-codex-spark",
  }
}

/** Returns the model options relevant to a built-in walkthrough route. */
export const modelOptionsForProvider = (provider: AICapabilityRoute): readonly AIModelOption[] => {
  if (provider === "auto") return AUTO_MODEL_OPTIONS
  if (provider === "claude") return CLAUDE_MODEL_OPTIONS
  if (provider === "opencode") return OPENCODE_MODEL_OPTIONS
  if (provider === "codex") return CODEX_MODEL_OPTIONS
  return []
}

/** Returns the currently selected model or quality value for a walkthrough route. */
export const selectedModelForProvider = (
  settings: AISettings,
  provider: AICapabilityRoute,
): string => (provider === "auto" ? settings.autoQuality : (settings.models[provider] ?? ""))
