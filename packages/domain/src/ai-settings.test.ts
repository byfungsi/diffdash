import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import {
  CodeThemePreferences,
  DarkCodeTheme,
  DarkTheme,
  DEFAULT_CODE_THEME_PREFERENCES,
  LightCodeTheme,
  LightTheme,
  ThemePreferences,
} from "./ai-settings"

describe("theme preferences", () => {
  it("accepts every supported light and dark theme", () => {
    const decodeLight = Schema.decodeUnknownResult(LightTheme)
    const decodeDark = Schema.decodeUnknownResult(DarkTheme)

    expect(Result.isSuccess(decodeLight("diffdash"))).toBe(true)
    expect(Result.isSuccess(decodeLight("catppuccin-latte"))).toBe(true)
    expect(Result.isSuccess(decodeDark("diffdash"))).toBe(true)
    expect(Result.isSuccess(decodeDark("catppuccin-frappe"))).toBe(true)
    expect(Result.isSuccess(decodeDark("catppuccin-macchiato"))).toBe(true)
    expect(Result.isSuccess(decodeDark("catppuccin-mocha"))).toBe(true)
  })

  it("rejects themes assigned to the wrong color scheme", () => {
    const decode = Schema.decodeUnknownResult(ThemePreferences)

    expect(Result.isFailure(decode({ light: "catppuccin-mocha", dark: "catppuccin-latte" }))).toBe(
      true,
    )
  })
})

describe("code theme preferences", () => {
  it("uses the DiffDash semantic theme as the dark default", () => {
    expect(DEFAULT_CODE_THEME_PREFERENCES.dark).toBe("diffdash-dark")
  })

  it("accepts the curated light and dark syntax themes", () => {
    const decodeLight = Schema.decodeUnknownResult(LightCodeTheme)
    const decodeDark = Schema.decodeUnknownResult(DarkCodeTheme)

    expect(Result.isSuccess(decodeLight("rose-pine-dawn"))).toBe(true)
    expect(Result.isSuccess(decodeLight("github-light-default"))).toBe(true)
    expect(Result.isSuccess(decodeLight("pierre-light-soft"))).toBe(true)
    expect(Result.isSuccess(decodeDark("rose-pine-moon"))).toBe(true)
    expect(Result.isSuccess(decodeDark("diffdash-dark"))).toBe(true)
    expect(Result.isSuccess(decodeDark("catppuccin-frappe"))).toBe(true)
    expect(Result.isSuccess(decodeDark("github-dark-default"))).toBe(true)
    expect(Result.isSuccess(decodeDark("pierre-dark-soft"))).toBe(true)
  })

  it("rejects syntax themes assigned to the wrong color scheme", () => {
    const decode = Schema.decodeUnknownResult(CodeThemePreferences)

    expect(Result.isFailure(decode({ light: "rose-pine-moon", dark: "rose-pine-dawn" }))).toBe(true)
  })
})
