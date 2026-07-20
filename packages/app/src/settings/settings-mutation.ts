import type { AISettings } from "@diffdash/domain/ai-settings"

/** Side effects used by the serialized settings mutation coordinator. */
type SettingsMutationDependencies = {
  readonly write: (settings: AISettings) => Promise<AISettings>
  readonly onOptimistic: (settings: AISettings) => void
  readonly onConfirmed: (settings: AISettings) => void
  readonly onRollback: (settings: AISettings, error: unknown) => void
}

/** Serialized last-write-wins settings mutation API. */
export type SettingsMutationCoordinator = {
  readonly update: (settings: AISettings) => Promise<AISettings>
  readonly replaceConfirmed: (settings: AISettings) => boolean
  readonly whenIdle: () => Promise<void>
}

/**
 * Serializes settings writes while preventing stale responses and failures from replacing newer
 * optimistic state.
 */
export const createSettingsMutationCoordinator = (
  initialSettings: AISettings,
  dependencies: SettingsMutationDependencies,
): SettingsMutationCoordinator => {
  let confirmedSettings = initialSettings
  let latestVersion = 0
  let tail: Promise<void> = Promise.resolve()

  const update = (settings: AISettings): Promise<AISettings> => {
    const version = latestVersion + 1
    latestVersion = version
    dependencies.onOptimistic(settings)

    const request = tail
      .catch(() => undefined)
      .then(() => dependencies.write(settings))
      .then(
        (savedSettings) => {
          confirmedSettings = savedSettings
          if (version === latestVersion) dependencies.onConfirmed(savedSettings)
          return savedSettings
        },
        (error: unknown) => {
          if (version === latestVersion) dependencies.onRollback(confirmedSettings, error)
          throw error
        },
      )
    tail = request.then(
      () => undefined,
      () => undefined,
    )
    return request
  }

  return {
    update,
    replaceConfirmed: (settings) => {
      confirmedSettings = settings
      return latestVersion === 0
    },
    whenIdle: () => tail,
  }
}
