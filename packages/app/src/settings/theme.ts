import type { Appearance } from "@diffdash/domain/ai-settings"

/** Theme resolved from a persisted appearance preference. */
export type ResolvedTheme = "light" | "dark"

/** Resolves an explicit or system appearance preference. */
export const resolveThemePreference = (preference: Appearance): ResolvedTheme => {
  if (preference !== "system") return preference
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}
