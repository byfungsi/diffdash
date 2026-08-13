import { Schema } from "effect"
import {
  DEFAULT_RENDERER_LAYOUT_SETTINGS,
  RendererLayoutSettings,
} from "./renderer-layout-settings"

/** Current persisted settings format. */
export const AI_SETTINGS_VERSION = 8 as const

/** Application appearance preference. */
export const Appearance = Schema.Literals(["light", "dark", "system"])

/** Application appearance selected in user settings. */
export type Appearance = typeof Appearance.Type

/** Palette available when the application uses a light color scheme. */
export const LightTheme = Schema.Literals(["diffdash", "catppuccin-latte"])

/** Palette available when the application uses a light color scheme. */
export type LightTheme = typeof LightTheme.Type

/** Palette available when the application uses a dark color scheme. */
export const DarkTheme = Schema.Literals([
  "diffdash",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
])

/** Palette available when the application uses a dark color scheme. */
export type DarkTheme = typeof DarkTheme.Type

/** Independent palette selections for light and dark appearance modes. */
export class ThemePreferences extends Schema.Class<ThemePreferences>("ThemePreferences")({
  light: LightTheme,
  dark: DarkTheme,
}) {}

/** Default palettes used by DiffDash for each appearance mode. */
export const DEFAULT_THEME_PREFERENCES = ThemePreferences.make({
  light: "diffdash",
  dark: "diffdash",
})

/** Syntax-highlighting theme available when the application uses a light color scheme. */
export const LightCodeTheme = Schema.Literals([
  "rose-pine-dawn",
  "catppuccin-latte",
  "github-light-default",
  "pierre-light-soft",
])

/** Syntax-highlighting theme available when the application uses a light color scheme. */
export type LightCodeTheme = typeof LightCodeTheme.Type

/** Syntax-highlighting theme available when the application uses a dark color scheme. */
export const DIFFDASH_DARK_CODE_THEME = "diffdash-dark" as const

/** Syntax-highlighting theme available when the application uses a dark color scheme. */
export const DarkCodeTheme = Schema.Literals([
  DIFFDASH_DARK_CODE_THEME,
  "rose-pine-moon",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "github-dark-default",
  "pierre-dark-soft",
])

/** Syntax-highlighting theme available when the application uses a dark color scheme. */
export type DarkCodeTheme = typeof DarkCodeTheme.Type

/** Independent syntax-highlighting selections for light and dark appearance modes. */
export class CodeThemePreferences extends Schema.Class<CodeThemePreferences>(
  "CodeThemePreferences",
)({
  light: LightCodeTheme,
  dark: DarkCodeTheme,
}) {}

/** Default syntax-highlighting themes used by DiffDash. */
export const DEFAULT_CODE_THEME_PREFERENCES = CodeThemePreferences.make({
  light: "rose-pine-dawn",
  dark: DIFFDASH_DARK_CODE_THEME,
})

/** Preferred layout for rendered source diffs. */
export const DiffViewMode = Schema.Literals(["auto", "unified", "split"])

/** Preferred layout for rendered source diffs. */
export type DiffViewMode = typeof DiffViewMode.Type

/** Stable agent capabilities independently configured and executed by DiffDash. */
export const AgentCapability = Schema.Literals(["walkthrough", "review-thread"])

/** Stable agent capabilities independently configured and executed by DiffDash. */
export type AgentCapability = typeof AgentCapability.Type

/** Provider-neutral model quality used by automatic capability routing. */
export const AgentModelQuality = Schema.Literals(["fast", "balanced", "best"])

/** Provider-neutral model quality used by automatic capability routing. */
export type AgentModelQuality = typeof AgentModelQuality.Type

/** Provider identity persisted independently of installed provider packages. */
export const AIProviderId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AIProviderId"),
)

/** Provider identity persisted independently of installed provider packages. */
export type AIProviderId = typeof AIProviderId.Type

/** Provider-owned model identity persisted independently of provider packages. */
export const AIModelId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AIModelId"),
)

/** Provider-owned model identity persisted independently of provider packages. */
export type AIModelId = typeof AIModelId.Type

/** Complete routing choice for one agent capability. */
export const AIAgentSelection = Schema.TaggedUnion({
  Automatic: { quality: AgentModelQuality },
  Pinned: { providerId: AIProviderId, modelId: Schema.NullOr(AIModelId) },
})

/** Complete routing choice for one agent capability. */
export type AIAgentSelection = typeof AIAgentSelection.Type

/** Closed routing record containing one authoritative choice per agent capability. */
export const AIAgentSelections = Schema.Struct({
  walkthrough: AIAgentSelection,
  "review-thread": AIAgentSelection,
})

/** Closed routing record containing one authoritative choice per agent capability. */
export type AIAgentSelections = typeof AIAgentSelections.Type

/** User-configurable application settings persisted as versioned JSON. */
export class AISettings extends Schema.Class<AISettings>("AISettings")({
  version: Schema.Literal(AI_SETTINGS_VERSION),
  appearance: Appearance,
  themes: ThemePreferences,
  codeThemes: CodeThemePreferences,
  diffViewMode: DiffViewMode,
  layout: RendererLayoutSettings,
  selections: AIAgentSelections,
  telemetryEnabled: Schema.Boolean,
}) {}

/** Default AI settings for first launch and invalid/missing agent settings. */
export const DEFAULT_AI_SETTINGS = AISettings.make({
  version: AI_SETTINGS_VERSION,
  appearance: "system",
  themes: DEFAULT_THEME_PREFERENCES,
  codeThemes: DEFAULT_CODE_THEME_PREFERENCES,
  diffViewMode: "auto",
  layout: DEFAULT_RENDERER_LAYOUT_SETTINGS,
  selections: AIAgentSelections.make({
    walkthrough: AIAgentSelection.cases.Automatic.make({ quality: "balanced" }),
    "review-thread": AIAgentSelection.cases.Automatic.make({ quality: "balanced" }),
  }),
  telemetryEnabled: true,
})
