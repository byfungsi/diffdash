import {
  AIAgentSelection,
  AIModelId,
  AIProviderId,
  AISettings,
  CodeThemePreferences,
  DEFAULT_AI_SETTINGS,
  ThemePreferences,
} from "@diffdash/domain/ai-settings"
import {
  RendererLayoutSettings,
  ReviewPaneSettings,
} from "@diffdash/domain/renderer-layout-settings"
import { describe, expect, it, vi } from "vitest"
import { createSettingsMutationCoordinator, parseRendererSettings } from "./settings-mutation"

const lightSettings = AISettings.make({ ...DEFAULT_AI_SETTINGS, appearance: "light" })
const darkSettings = AISettings.make({ ...DEFAULT_AI_SETTINGS, appearance: "dark" })
const ignoreRejection = (_error: unknown): void => undefined

describe("settings mutation coordinator", () => {
  it("restores nested settings classes after an Electron structured clone", () => {
    const settings = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      selections: {
        ...DEFAULT_AI_SETTINGS.selections,
        "review-thread": AIAgentSelection.cases.Pinned.make({
          providerId: AIProviderId.make("future-provider"),
          modelId: AIModelId.make("future-model"),
        }),
      },
    })
    const cloned = structuredClone(settings)

    expect(cloned.layout).not.toBeInstanceOf(RendererLayoutSettings)
    const parsed = parseRendererSettings(cloned)

    expect(parsed).toBeInstanceOf(AISettings)
    expect(parsed.themes).toBeInstanceOf(ThemePreferences)
    expect(parsed.codeThemes).toBeInstanceOf(CodeThemePreferences)
    expect(parsed.layout).toBeInstanceOf(RendererLayoutSettings)
    expect(parsed.layout.review).toBeInstanceOf(ReviewPaneSettings)
    expect(parsed.selections["review-thread"]).toEqual({
      _tag: "Pinned",
      providerId: "future-provider",
      modelId: "future-model",
    })
  })

  it("restores Catppuccin selections from an Electron structured clone", () => {
    const settings = AISettings.make({
      ...DEFAULT_AI_SETTINGS,
      appearance: "dark",
      themes: ThemePreferences.make({
        light: "catppuccin-latte",
        dark: "catppuccin-mocha",
      }),
      codeThemes: CodeThemePreferences.make({
        light: "github-light-default",
        dark: "pierre-dark-soft",
      }),
    })

    expect(parseRendererSettings(structuredClone(settings)).themes).toEqual({
      light: "catppuccin-latte",
      dark: "catppuccin-mocha",
    })
    expect(parseRendererSettings(structuredClone(settings)).codeThemes).toEqual({
      light: "github-light-default",
      dark: "pierre-dark-soft",
    })
  })

  it("applies functional updates to the latest optimistic settings", async () => {
    const writes: AISettings[] = []
    const coordinator = createSettingsMutationCoordinator(DEFAULT_AI_SETTINGS, {
      write: async (settings) => {
        writes.push(settings)
        return settings
      },
      onOptimistic: () => undefined,
      onConfirmed: () => undefined,
      onRollback: () => undefined,
    })

    const first = coordinator.update((current) =>
      AISettings.make({ ...current, appearance: "dark" }),
    )
    const second = coordinator.update((current) =>
      AISettings.make({ ...current, diffViewMode: "split" }),
    )
    await Promise.all([first, second])

    expect(writes[1]).toMatchObject({ appearance: "dark", diffViewMode: "split" })
  })

  it("ignores a stale initial read after settings writes begin", async () => {
    const rollbacks: AISettings[] = []
    const coordinator = createSettingsMutationCoordinator(DEFAULT_AI_SETTINGS, {
      write: async (settings) => {
        if (settings.diffViewMode === "split") throw new Error("disk full")
        return settings
      },
      onOptimistic: () => undefined,
      onConfirmed: () => undefined,
      onRollback: (settings) => rollbacks.push(settings),
    })

    await coordinator.update(darkSettings)
    expect(coordinator.replaceConfirmed(lightSettings)).toBe(false)
    await expect(
      coordinator.update((current) => AISettings.make({ ...current, diffViewMode: "split" })),
    ).rejects.toThrow("disk full")

    expect(rollbacks).toEqual([darkSettings])
  })

  it("serializes writes and ignores an older failure after a newer optimistic update", async () => {
    let rejectFirst: (error: unknown) => void = ignoreRejection
    const firstWrite = new Promise<AISettings>((_resolve, reject) => {
      rejectFirst = reject
    })
    const writes: AISettings[] = []
    const rendered: AISettings[] = []
    const rollbacks: AISettings[] = []
    const write = vi.fn<(settings: AISettings) => Promise<AISettings>>(async (settings) => {
      writes.push(settings)
      if (writes.length === 1) return firstWrite
      return settings
    })
    const coordinator = createSettingsMutationCoordinator(DEFAULT_AI_SETTINGS, {
      write,
      onOptimistic: (settings) => rendered.push(settings),
      onConfirmed: (settings) => rendered.push(settings),
      onRollback: (settings) => rollbacks.push(settings),
    })

    const older = coordinator.update(lightSettings).catch(() => lightSettings)
    const newer = coordinator.update(darkSettings)
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(rendered.at(-1)).toBe(darkSettings)

    rejectFirst(new Error("older write failed"))
    await older
    await newer

    expect(writes).toEqual([lightSettings, darkSettings])
    expect(rollbacks).toEqual([])
    expect(rendered.at(-1)).toBe(darkSettings)
  })

  it("rolls the latest failed write back to the newest confirmed response", async () => {
    const rendered: AISettings[] = []
    const errors: unknown[] = []
    const coordinator = createSettingsMutationCoordinator(DEFAULT_AI_SETTINGS, {
      write: async (settings) => {
        if (settings.appearance === "dark") throw new Error("disk full")
        return settings
      },
      onOptimistic: (settings) => rendered.push(settings),
      onConfirmed: (settings) => rendered.push(settings),
      onRollback: (settings, error) => {
        rendered.push(settings)
        errors.push(error)
      },
    })

    await coordinator.update(lightSettings)
    await expect(coordinator.update(darkSettings)).rejects.toThrow("disk full")

    expect(rendered.at(-1)).toBe(lightSettings)
    expect(errors).toHaveLength(1)
  })
})
