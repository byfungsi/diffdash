import { describe, expect, it } from "@effect/vitest"
import { ThemePreferences } from "@diffdash/domain/ai-settings"
import { resolveThemePreference, THEME_DEFINITIONS } from "./theme"

const catppuccin = ThemePreferences.make({
  light: "catppuccin-latte",
  dark: "catppuccin-macchiato",
})

describe("theme resolution", () => {
  it("resolves system appearance through independent light and dark slots", () => {
    expect(resolveThemePreference("system", catppuccin, "light")).toBe("catppuccin-latte")
    expect(resolveThemePreference("system", catppuccin, "dark")).toBe("catppuccin-macchiato")
  })

  it("keeps explicit appearance independent from the system scheme", () => {
    expect(resolveThemePreference("light", catppuccin, "dark")).toBe("catppuccin-latte")
    expect(resolveThemePreference("dark", catppuccin, "light")).toBe("catppuccin-macchiato")
  })

  it("maps the DiffDash slots to concrete light and dark theme identities", () => {
    const diffdash = ThemePreferences.make({ light: "diffdash", dark: "diffdash" })

    expect(resolveThemePreference("light", diffdash, "dark")).toBe("diffdash-light")
    expect(resolveThemePreference("dark", diffdash, "light")).toBe("diffdash-dark")
    expect(THEME_DEFINITIONS["diffdash-light"].colorScheme).toBe("light")
    expect(THEME_DEFINITIONS["diffdash-dark"].colorScheme).toBe("dark")
  })
})
