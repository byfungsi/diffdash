import { Schema } from "effect"

/** AI agent providers available for walkthrough generation. */
export const AIProvider = Schema.Literal("auto", "codex", "claude", "opencode")

/** AI agent provider selected for walkthrough generation. */
export type AIProvider = typeof AIProvider.Type

/** Concrete AI agent providers tried by automatic fallback. */
export const CONCRETE_AI_PROVIDERS = ["codex", "claude", "opencode"] as const

/** Ordered provider fallback used when the selected provider is `auto`. */
export const AUTO_AI_PROVIDER_ORDER: readonly ConcreteAIProvider[] = CONCRETE_AI_PROVIDERS

/** AI providers with direct CLI implementations. */
export type ConcreteAIProvider = (typeof CONCRETE_AI_PROVIDERS)[number]

/** Codex CLI models supported by DiffDash. */
export const CodexModel = Schema.Literal("gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4-mini")

/** Codex CLI model selected for generation. */
export type CodexModel = typeof CodexModel.Type

/** Claude CLI models supported by DiffDash. */
export const ClaudeModel = Schema.Literal("claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5")

/** Claude CLI model selected for generation. */
export type ClaudeModel = typeof ClaudeModel.Type

/** OpenCode provider/model IDs supported by DiffDash. */
export const OpenCodeModel = Schema.Literal(
  "openai/gpt-5.5",
  "openai/gpt-5.3-codex-spark",
  "openai/gpt-5.4-mini",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
)

/** OpenCode provider/model ID selected for generation. */
export type OpenCodeModel = typeof OpenCodeModel.Type

/** Per-provider model selection persisted in user settings. */
export class AIProviderModels extends Schema.Class<AIProviderModels>("AIProviderModels")({
  codex: CodexModel,
  claude: ClaudeModel,
  opencode: OpenCodeModel,
}) {}

/** User-configurable AI settings persisted as JSON. */
export class AISettings extends Schema.Class<AISettings>("AISettings")({
  provider: AIProvider,
  models: AIProviderModels,
}) {}

/** Default AI settings for first launch and invalid/missing settings files. */
export const DEFAULT_AI_SETTINGS = AISettings.make({
  provider: "auto",
  models: AIProviderModels.make({
    claude: "claude-sonnet-5",
    codex: "gpt-5.3-codex-spark",
    opencode: "openai/gpt-5.3-codex-spark",
  }),
})

/** Display metadata for an AI provider option. */
export interface AIProviderOption {
  readonly label: string
  readonly provider: AIProvider
}

/** Display metadata for a model option. */
export interface AIModelOption<Model extends string> {
  readonly label: string
  readonly model: Model
}

/** Provider options shown in the walkthrough settings menu. */
export const AI_PROVIDER_OPTIONS: readonly AIProviderOption[] = [
  { provider: "auto", label: "Auto" },
  { provider: "codex", label: "Codex" },
  { provider: "claude", label: "Claude" },
  { provider: "opencode", label: "OpenCode" },
]

/** Codex model options shown in settings. */
export const CODEX_MODEL_OPTIONS: readonly AIModelOption<CodexModel>[] = [
  { model: "gpt-5.5", label: "GPT 5.5" },
  { model: "gpt-5.3-codex-spark", label: "GPT 5.3 Codex Spark" },
  { model: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
]

/** Claude model options shown in settings. */
export const CLAUDE_MODEL_OPTIONS: readonly AIModelOption<ClaudeModel>[] = [
  { model: "claude-opus-4-8", label: "Opus 4.8" },
  { model: "claude-sonnet-5", label: "Sonnet 5.0" },
  { model: "claude-haiku-4-5", label: "Haiku 4.5" },
]

/** OpenCode model options shown in settings. */
export const OPENCODE_MODEL_OPTIONS: readonly AIModelOption<OpenCodeModel>[] = [
  { model: "openai/gpt-5.5", label: "GPT 5.5" },
  { model: "openai/gpt-5.3-codex-spark", label: "GPT 5.3 Codex Spark" },
  { model: "openai/gpt-5.4-mini", label: "GPT 5.4 Mini" },
  { model: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
  { model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5.0" },
  { model: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
]

/** Returns the model options relevant to the selected provider. */
export const modelOptionsForProvider = (
  provider: AIProvider,
): readonly AIModelOption<CodexModel | ClaudeModel | OpenCodeModel>[] => {
  if (provider === "claude") return CLAUDE_MODEL_OPTIONS
  if (provider === "opencode") return OPENCODE_MODEL_OPTIONS
  return CODEX_MODEL_OPTIONS
}

/** Returns the currently selected model ID for a provider. */
export const selectedModelForProvider = (settings: AISettings, provider: AIProvider) => {
  if (provider === "claude") return settings.models.claude
  if (provider === "opencode") return settings.models.opencode
  return settings.models.codex
}
