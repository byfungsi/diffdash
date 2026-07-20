import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { describe, expect, it, vi } from "vitest"
import { createSettingsMutationCoordinator } from "./settings-mutation"

const lightSettings = AISettings.make({ ...DEFAULT_AI_SETTINGS, appearance: "light" })
const darkSettings = AISettings.make({ ...DEFAULT_AI_SETTINGS, appearance: "dark" })
const ignoreRejection = (_error: unknown): void => undefined

describe("settings mutation coordinator", () => {
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
