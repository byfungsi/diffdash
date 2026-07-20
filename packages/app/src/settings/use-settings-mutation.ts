import { AISettings, DEFAULT_AI_SETTINGS } from "@diffdash/domain/ai-settings"
import { useEffect, useState } from "react"
import { formatError } from "@/shared/errors"
import {
  type SettingsMutationCoordinator,
  createSettingsMutationCoordinator,
} from "./settings-mutation"

/** State and operations for renderer settings persistence. */
type SettingsMutationController = {
  readonly settings: AISettings
  readonly status: string | null
  readonly update: (settings: AISettings) => Promise<AISettings>
}

/** Loads settings and coordinates optimistic serialized updates with last-write-wins rendering. */
export const useSettingsMutation = (): SettingsMutationController => {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS)
  const [status, setStatus] = useState<string | null>(null)
  const [coordinator] = useState<SettingsMutationCoordinator>(() =>
    createSettingsMutationCoordinator(DEFAULT_AI_SETTINGS, {
      write: (nextSettings) => window.diffDash.settings.update(nextSettings),
      onOptimistic: (nextSettings) => {
        setSettings(nextSettings)
        setStatus(null)
      },
      onConfirmed: (savedSettings) => {
        setSettings(savedSettings)
        setStatus("Saved walkthrough AI settings.")
      },
      onRollback: (confirmedSettings, error) => {
        setSettings(confirmedSettings)
        setStatus(formatError(error, "Could not save walkthrough AI settings"))
      },
    }),
  )

  useEffect(() => {
    let cancelled = false
    window.diffDash.settings
      .get()
      .then((savedSettings) => {
        if (!cancelled && coordinator.replaceConfirmed(savedSettings)) setSettings(savedSettings)
        return undefined
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [coordinator])

  return { settings, status, update: coordinator.update }
}
