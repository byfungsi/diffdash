import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { useEffect, useState } from "react"
import { runRendererPromise, useRendererPreferences } from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import {
  type SettingsMutationCoordinator,
  createSettingsMutationCoordinator,
  parseRendererSettings,
} from "./settings-mutation"

/** State and operations for renderer settings persistence. */
type SettingsMutationController = {
  readonly settings: AISettings
  readonly status: string | null
  readonly update: (
    update: AISettings | ((current: AISettings) => AISettings),
  ) => Promise<AISettings>
}

/** Loads settings and coordinates optimistic serialized updates with last-write-wins rendering. */
export const useSettingsMutation = (): SettingsMutationController => {
  const preferences = useRendererPreferences()
  const [settings, setSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS)
  const [status, setStatus] = useState<string | null>(null)
  const [coordinator] = useState<SettingsMutationCoordinator>(() =>
    createSettingsMutationCoordinator(DEFAULT_AI_SETTINGS, {
      write: async (nextSettings) =>
        parseRendererSettings(await runRendererPromise(preferences.saveSettings(nextSettings))),
      onOptimistic: (nextSettings) => {
        setSettings(nextSettings)
        setStatus(null)
      },
      onConfirmed: (savedSettings) => {
        setSettings(savedSettings)
        setStatus("Saved settings.")
      },
      onRollback: (confirmedSettings, error) => {
        setSettings(confirmedSettings)
        setStatus(formatError(error, "Could not save settings"))
      },
    }),
  )

  useEffect(() => {
    let cancelled = false
    runRendererPromise(preferences.loadSettings())
      .then((savedSettings) => {
        const parsedSettings = parseRendererSettings(savedSettings)
        if (!cancelled && coordinator.replaceConfirmed(parsedSettings)) setSettings(parsedSettings)
        return undefined
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [coordinator, preferences])

  return { settings, status, update: coordinator.update }
}
