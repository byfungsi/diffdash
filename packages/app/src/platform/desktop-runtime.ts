import { Cause, Context, Effect, Layer, Match, Queue, Stream } from "effect"
import type { WebUrl } from "@diffdash/domain/web-url"

import type { AppUpdateState } from "@diffdash/protocol/app-update"
import type { AnalyticsEvent } from "@diffdash/protocol/analytics"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import type { AppPrerequisites, DiffDashCliInstallResult } from "@diffdash/protocol/prerequisites"
import type {
  ConnectOpenCodeSessionRequest,
  ListOpenCodeSessionsRequest,
  OpenCodeConnection,
  OpenCodeSessionSummary,
  SubmitCommentReceipt,
  SubmitCommentRequest,
} from "@diffdash/protocol/ai-connection"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import { PreloadClient } from "./preload-client"
import {
  invokePreload,
  preloadEventStream,
  rendererApiError,
  type RendererApiError,
} from "./renderer-api-error"

/** Renderer capabilities owned by the Electron shell rather than a product feature. */
export class DesktopRuntime extends Context.Service<
  DesktopRuntime,
  {
    readonly getDiagnostics: () => Effect.Effect<AppPrerequisites, RendererApiError>
    readonly installCli: () => Effect.Effect<DiffDashCliInstallResult, RendererApiError>
    readonly ai: {
      readonly listOpenCodeSessions: (
        request: ListOpenCodeSessionsRequest,
      ) => Effect.Effect<readonly OpenCodeSessionSummary[], RendererApiError>
      readonly connectOpenCodeSession: (
        request: ConnectOpenCodeSessionRequest,
      ) => Effect.Effect<OpenCodeConnection, RendererApiError>
      readonly submitComment: (
        request: SubmitCommentRequest,
      ) => Effect.Effect<typeof SubmitCommentReceipt.Type, RendererApiError>
    }
    readonly openExternalUrl: (url: WebUrl) => Effect.Effect<void, RendererApiError>
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
    const navigationNotifications = Stream.callback<void, RendererApiError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          api.navigation.onCommandsAvailable((result) => {
            Match.valueTags(result, {
              Failure: (failure) =>
                Queue.failCauseUnsafe(
                  queue,
                  Cause.fail(
                    rendererApiError(EventChannel.navigationCommandsAvailable, failure.error),
                  ),
                ),
              Success: () => void Queue.offerUnsafe(queue, undefined),
            })
          }),
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
      ai: {
        listOpenCodeSessions: (request) =>
          invokePreload(InvokeChannel.aiListOpenCodeSessions, () =>
            api.ai.listOpenCodeSessions(request),
          ),
        connectOpenCodeSession: (request) =>
          invokePreload(InvokeChannel.aiConnectOpenCodeSession, () =>
            api.ai.connectOpenCodeSession(request),
          ),
        submitComment: (request) =>
          invokePreload(InvokeChannel.aiSubmitComment, () => api.ai.submitComment(request)),
      },
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
