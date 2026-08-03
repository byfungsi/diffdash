import { AISettings } from "@diffdash/domain/ai-settings"
import { Schema } from "effect"

/** Restores domain classes after Electron structured-clones settings across IPC. */
export const parseRendererSettings = Schema.decodeUnknownSync(AISettings)

/** Side effects used by the serialized settings mutation coordinator. */
type SettingsMutationDependencies = {
  readonly write: (settings: AISettings) => Promise<AISettings>
  readonly onOptimistic: (settings: AISettings) => void
  readonly onConfirmed: (settings: AISettings) => void
  readonly onRollback: (settings: AISettings, error: unknown) => void
}

/** Serialized last-write-wins settings mutation API. */
export type SettingsMutationCoordinator = {
  readonly update: (
    update: AISettings | ((current: AISettings) => AISettings),
  ) => Promise<AISettings>
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
  let optimisticSettings = initialSettings
  let latestVersion = 0
  let tail: Promise<void> = Promise.resolve()

  const update = (
    updateValue: AISettings | ((current: AISettings) => AISettings),
  ): Promise<AISettings> => {
    const settings =
      typeof updateValue === "function" ? updateValue(optimisticSettings) : updateValue
    optimisticSettings = settings
    const version = latestVersion + 1
    latestVersion = version
    dependencies.onOptimistic(settings)

    const request = tail
      .catch(() => undefined)
      .then(() => dependencies.write(settings))
      .then(
        (savedSettings) => {
          confirmedSettings = savedSettings
          if (version === latestVersion) {
            optimisticSettings = savedSettings
            dependencies.onConfirmed(savedSettings)
          }
          return savedSettings
        },
        (error: unknown) => {
          if (version === latestVersion) {
            optimisticSettings = confirmedSettings
            dependencies.onRollback(confirmedSettings, error)
          }
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
      if (latestVersion !== 0) return false
      confirmedSettings = settings
      optimisticSettings = settings
      return true
    },
    whenIdle: () => tail,
  }
}
