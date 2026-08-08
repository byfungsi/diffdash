import { Schema } from "effect"
import {
  DEFAULT_RENDERER_LAYOUT_SETTINGS,
  RendererLayoutSettings,
} from "./renderer-layout-settings"

/** Current persisted settings format. */
export const AI_SETTINGS_VERSION = 7 as const

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

/** Automatic model quality used by capability routing. */
export const AutoQuality = Schema.Literals(["fast", "balanced", "best"])

/** Automatic model quality used by capability routing. */
export type AutoQuality = typeof AutoQuality.Type

/** A capability route selected automatically or pinned to an open provider ID. */
export const AICapabilityRoute = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

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
export const AIProviderModels = Schema.Record(
  Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
)

/** Open provider-to-model selections retained even when a provider package is absent. */
export type AIProviderModels = typeof AIProviderModels.Type

/** User-configurable application settings persisted as versioned JSON. */
export class AISettings extends Schema.Class<AISettings>("AISettings")({
  version: Schema.Literal(AI_SETTINGS_VERSION),
  appearance: Appearance,
  themes: ThemePreferences,
  codeThemes: CodeThemePreferences,
  diffViewMode: DiffViewMode,
  layout: RendererLayoutSettings,
  routes: AICapabilityRoutes,
  models: AIProviderModels,
  autoQuality: AutoQuality,
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
  routes: AICapabilityRoutes.make({ walkthrough: "auto", reviewThread: "auto" }),
  models: {},
  autoQuality: "balanced",
  telemetryEnabled: true,
})
