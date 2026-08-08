import { AppSettings } from "@diffdash/settings/app-settings"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import type { OperationHandlersFor } from "./operation-handlers"

type SettingsMethod = typeof CoreMethod.settingsGet | typeof CoreMethod.settingsUpdate

/** Acquires settings handlers for the closed Core operation map. */
export const makeSettingsOperationHandlers: Effect.Effect<
  OperationHandlersFor<SettingsMethod>,
  never,
  AppSettings
> = Effect.gen(function* () {
  const settings = yield* AppSettings

  return {
    [CoreMethod.settingsGet]: () => settings.get,
    [CoreMethod.settingsUpdate]: ({ settings: updated }) => settings.save(updated),
  } satisfies OperationHandlersFor<SettingsMethod>
})
