import { Context, Effect, Layer, Option } from "effect"

import type { AISettings } from "@diffdash/domain/ai-settings"
import type { AppState } from "@diffdash/domain/app-state"
import type {
  ProjectWorkspaceState,
  ProjectWorkspaceStateInput,
} from "@diffdash/domain/project-workspace"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer persistence capabilities for preferences, onboarding, and project workspace state. */
export class RendererPreferences extends Context.Service<
  RendererPreferences,
  {
    readonly loadSettings: () => Effect.Effect<AISettings, RendererApiError>
    readonly saveSettings: (settings: AISettings) => Effect.Effect<AISettings, RendererApiError>
    readonly loadAppState: () => Effect.Effect<AppState, RendererApiError>
    readonly saveAppState: (state: AppState) => Effect.Effect<AppState, RendererApiError>
    readonly loadWorkspace: (
      projectId: ReviewProjectId,
    ) => Effect.Effect<Option.Option<ProjectWorkspaceState>, RendererApiError>
    readonly saveWorkspace: (
      input: ProjectWorkspaceStateInput,
    ) => Effect.Effect<ProjectWorkspaceState, RendererApiError>
  }
>()("@diffdash/app/RendererPreferences") {}

/** Desktop implementation of renderer persistence capabilities. */
export const rendererPreferencesLayer = Layer.effect(
  RendererPreferences,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return RendererPreferences.of({
      loadSettings: () => invokePreload(InvokeChannel.settingsGet, () => api.settings.get()),
      saveSettings: (settings) =>
        invokePreload(InvokeChannel.settingsUpdate, () => api.settings.update(settings)),
      loadAppState: () => invokePreload(InvokeChannel.appStateGet, () => api.appState.get()),
      saveAppState: (state) =>
        invokePreload(InvokeChannel.appStateUpdate, () => api.appState.update(state)),
      loadWorkspace: (projectId) =>
        invokePreload(InvokeChannel.projectWorkspaceGet, () =>
          api.projectWorkspace.get(projectId),
        ).pipe(Effect.map(Option.fromNullishOr)),
      saveWorkspace: (input) =>
        invokePreload(InvokeChannel.projectWorkspaceSave, () => api.projectWorkspace.save(input)),
    })
  }),
)
