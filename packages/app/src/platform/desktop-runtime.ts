import { Context, Effect, Layer, Queue, Stream } from "effect"

import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import type { AppPrerequisites, DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import { invokePreload, preloadEventStream, type RendererApiError } from "./renderer-api-error"

/** Renderer capabilities owned by the Electron shell rather than a product feature. */
export class DesktopRuntime extends Context.Service<
  DesktopRuntime,
  {
    readonly getDiagnostics: () => Effect.Effect<AppPrerequisites, RendererApiError>
    readonly installCli: () => Effect.Effect<DiffDashCliInstallResult, RendererApiError>
    readonly openExternalUrl: (url: string) => Effect.Effect<void, RendererApiError>
    readonly analytics: {
      readonly start: () => Effect.Effect<void, RendererApiError>
      readonly capture: (event: AnalyticsEvent) => Effect.Effect<void, RendererApiError>
    }
    readonly updates: {
      readonly states: Stream.Stream<AppUpdateState, RendererApiError>
      readonly check: () => Effect.Effect<void, RendererApiError>
      readonly download: () => Effect.Effect<void, RendererApiError>
      readonly restartAndInstall: () => Effect.Effect<void, RendererApiError>
    }
    readonly navigation: {
      readonly activateWindow: () => Effect.Effect<void, RendererApiError>
      readonly commands: Stream.Stream<CliNavigationCommand, RendererApiError>
    }
  }
>()("@diffdash/app/DesktopRuntime") {}

/** Desktop implementation of Electron-shell renderer capabilities. */
export const desktopRuntimeLayer = Layer.effect(
  DesktopRuntime,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    const updateStates = preloadEventStream(
      EventChannel.updateStateChanged,
      (listener) => api.updates.onStateChanged(listener),
      invokePreload(InvokeChannel.updatesGetState, () => api.updates.getState()),
    )
    const navigationNotifications = Stream.callback<void>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          api.navigation.onCommandsAvailable(() => void Queue.offerUnsafe(queue, undefined)),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.tap(() => Effect.sync(() => void Queue.offerUnsafe(queue, undefined)))),
    )
    const drainNavigationCommands = invokePreload(InvokeChannel.drainNavigationCommands, () =>
      api.navigation.drainCommands(),
    )

    return DesktopRuntime.of({
      getDiagnostics: () => invokePreload(InvokeChannel.appDiagnostics, () => api.diagnostics()),
      installCli: () =>
        invokePreload(InvokeChannel.appInstallDiffDashCli, () => api.installDiffDashCli()),
      openExternalUrl: (url) =>
        invokePreload(InvokeChannel.appOpenExternalUrl, () => api.openExternalUrl(url)),
      analytics: {
        start: () => invokePreload(InvokeChannel.analyticsStart, () => api.analytics.start()),
        capture: (event) =>
          invokePreload(InvokeChannel.analyticsCapture, () => api.analytics.capture(event)),
      },
      updates: {
        states: updateStates,
        check: () => invokePreload(InvokeChannel.updatesCheck, () => api.updates.check()),
        download: () => invokePreload(InvokeChannel.updatesDownload, () => api.updates.download()),
        restartAndInstall: () =>
          invokePreload(InvokeChannel.updatesRestartAndInstall, () =>
            api.updates.restartAndInstall(),
          ),
      },
      navigation: {
        activateWindow: () =>
          invokePreload(InvokeChannel.appActivateWindow, () => api.navigation.activateWindow()),
        commands: navigationNotifications.pipe(
          Stream.mapEffect(() => drainNavigationCommands),
          Stream.flatMap(Stream.fromIterable),
        ),
      },
    })
  }),
)
