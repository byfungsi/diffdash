import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import {
  AIAgentSelection,
  AIAgentSelections,
  AIModelId,
  AIProviderId,
  AISettings,
  CodeThemePreferences,
  DarkCodeTheme,
  DarkTheme,
  DEFAULT_CODE_THEME_PREFERENCES,
  DEFAULT_AI_SETTINGS,
  LightCodeTheme,
  LightTheme,
  ThemePreferences,
} from "./ai-settings"

describe("AI settings routing", () => {
  it("defaults source comments to collection mode", () => {
    expect(DEFAULT_AI_SETTINGS.commentMode).toBe("notes")
  })

  it("requires one tagged selection for each canonical capability", () => {
    const decode = Schema.decodeUnknownResult(AISettings)

    expect(
      Result.isSuccess(
        decode({
          ...Schema.encodeUnknownSync(AISettings)(
            AISettings.make({
              ...DEFAULT_AI_SETTINGS,
              selections: {
                walkthrough: AIAgentSelection.cases.Automatic.make({ quality: "best" }),
                "review-thread": AIAgentSelection.cases.Pinned.make({
                  providerId: AIProviderId.make("unavailable-provider"),
                  modelId: AIModelId.make("unavailable-model"),
                }),
              },
            }),
          ),
        }),
      ),
    ).toBe(true)
  })

  it("rejects incomplete records and strips unknown capability keys", () => {
    const decode = Schema.decodeUnknownResult(AIAgentSelections)

    expect(Result.isFailure(decode({ walkthrough: { _tag: "Automatic", quality: "best" } }))).toBe(
      true,
    )
    const extraKey = decode({
      walkthrough: { _tag: "Automatic", quality: "best" },
      "review-thread": { _tag: "Automatic", quality: "fast" },
      future: { _tag: "Automatic", quality: "balanced" },
    })
    expect(Result.isSuccess(extraKey)).toBe(true)
    const decodedKeys = Result.isSuccess(extraKey) ? Object.keys(extraKey.success) : []
    expect(decodedKeys).toHaveLength(2)
  })

  it("represents a pinned provider using its capability default model", () => {
    const result = Schema.decodeUnknownResult(AIAgentSelection)({
      _tag: "Pinned",
      providerId: "codex",
      modelId: null,
    })

    expect(Result.isSuccess(result)).toBe(true)
  })
})

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
