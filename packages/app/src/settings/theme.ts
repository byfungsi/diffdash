import type {
  Appearance,
  DarkTheme,
  LightTheme,
  ThemePreferences,
} from "@diffdash/domain/ai-settings"

/** Browser color scheme used for native controls and luminance-dependent utilities. */
export type ColorScheme = "light" | "dark"

/** Concrete palette applied after resolving appearance and its scheme-specific preference. */
export type ResolvedTheme =
  | "diffdash-light"
  | "diffdash-dark"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"

/** Color-scheme metadata associated with a concrete application palette. */
export type ThemeDefinition = {
  readonly colorScheme: ColorScheme
}

/** Complete application palette catalog. */
export const THEME_DEFINITIONS: Readonly<Record<ResolvedTheme, ThemeDefinition>> = {
  "diffdash-light": {
    colorScheme: "light",
  },
  "diffdash-dark": {
    colorScheme: "dark",
  },
  "catppuccin-latte": {
    colorScheme: "light",
  },
  "catppuccin-frappe": {
    colorScheme: "dark",
  },
  "catppuccin-macchiato": {
    colorScheme: "dark",
  },
  "catppuccin-mocha": {
    colorScheme: "dark",
  },
}

/** Resolves the color scheme selected by an explicit or system appearance preference. */
export const resolveColorScheme = (
  appearance: Appearance,
  systemColorScheme: ColorScheme,
): ColorScheme => (appearance === "system" ? systemColorScheme : appearance)

/** Resolves a concrete palette from appearance and independent light/dark selections. */
export const resolveThemePreference = (
  appearance: Appearance,
  themes: ThemePreferences,
  systemColorScheme: ColorScheme,
): ResolvedTheme => {
  const colorScheme = resolveColorScheme(appearance, systemColorScheme)
  return colorScheme === "light" ? resolveLightTheme(themes.light) : resolveDarkTheme(themes.dark)
}

/** Reads the browser's current system color scheme. */
export const getSystemColorScheme = (): ColorScheme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

const resolveLightTheme = (theme: LightTheme): ResolvedTheme =>
  theme === "diffdash" ? "diffdash-light" : theme

const resolveDarkTheme = (theme: DarkTheme): ResolvedTheme =>
  theme === "diffdash" ? "diffdash-dark" : theme
