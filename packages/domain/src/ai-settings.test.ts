import { describe, expect, it } from "@effect/vitest"
import { Either, Schema } from "effect"
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
    const decodeLight = Schema.decodeUnknownEither(LightTheme)
    const decodeDark = Schema.decodeUnknownEither(DarkTheme)

    expect(Either.isRight(decodeLight("diffdash"))).toBe(true)
    expect(Either.isRight(decodeLight("catppuccin-latte"))).toBe(true)
    expect(Either.isRight(decodeDark("diffdash"))).toBe(true)
    expect(Either.isRight(decodeDark("catppuccin-frappe"))).toBe(true)
    expect(Either.isRight(decodeDark("catppuccin-macchiato"))).toBe(true)
    expect(Either.isRight(decodeDark("catppuccin-mocha"))).toBe(true)
  })

  it("rejects themes assigned to the wrong color scheme", () => {
    const decode = Schema.decodeUnknownEither(ThemePreferences)

    expect(Either.isLeft(decode({ light: "catppuccin-mocha", dark: "catppuccin-latte" }))).toBe(
      true,
    )
  })
})

describe("code theme preferences", () => {
  it("uses the DiffDash semantic theme as the dark default", () => {
    expect(DEFAULT_CODE_THEME_PREFERENCES.dark).toBe("diffdash-dark")
  })

  it("accepts the curated light and dark syntax themes", () => {
    const decodeLight = Schema.decodeUnknownEither(LightCodeTheme)
    const decodeDark = Schema.decodeUnknownEither(DarkCodeTheme)

    expect(Either.isRight(decodeLight("rose-pine-dawn"))).toBe(true)
    expect(Either.isRight(decodeLight("github-light-default"))).toBe(true)
    expect(Either.isRight(decodeLight("pierre-light-soft"))).toBe(true)
    expect(Either.isRight(decodeDark("rose-pine-moon"))).toBe(true)
    expect(Either.isRight(decodeDark("diffdash-dark"))).toBe(true)
    expect(Either.isRight(decodeDark("catppuccin-frappe"))).toBe(true)
    expect(Either.isRight(decodeDark("github-dark-default"))).toBe(true)
    expect(Either.isRight(decodeDark("pierre-dark-soft"))).toBe(true)
  })

  it("rejects syntax themes assigned to the wrong color scheme", () => {
    const decode = Schema.decodeUnknownEither(CodeThemePreferences)

    expect(Either.isLeft(decode({ light: "rose-pine-moon", dark: "rose-pine-dawn" }))).toBe(true)
  })
})
