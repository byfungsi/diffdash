import { Context, Effect, Layer, Schema } from "effect"
import electronUpdater, {
  type AppUpdater as ElectronNativeUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater"

import {
  AppUpdateAvailable,
  AppUpdateChecking,
  AppUpdateDownloaded,
  AppUpdateDownloading,
  AppUpdateFailed,
  AppUpdateIdle,
  type AppUpdateState,
  AppUpdateUnsupported,
  type AppUpdateUnsupportedReason,
} from "@diffdash/protocol/app-update"

const DEFAULT_UPDATE_BASE_URL = "https://download.usediffdash.com/updates/stable"
const INITIAL_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

/** A recoverable automatic-update operation failure. */
class AppUpdaterError extends Schema.TaggedError<AppUpdaterError>()("AppUpdaterError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.NullOr(Schema.Defect),
}) {}

/** Native updater seam used by the production service and deterministic tests. */
export interface NativeUpdaterAdapter {
  readonly configure: (feedUrl: string) => void
  readonly check: () => Promise<unknown>
  readonly download: () => Promise<readonly string[]>
  readonly quitAndInstall: () => void
  readonly onChecking: (listener: () => void) => () => void
  readonly onAvailable: (listener: (info: { readonly version: string }) => void) => () => void
  readonly onNotAvailable: (listener: () => void) => () => void
  readonly onProgress: (listener: (info: { readonly percent: number }) => void) => () => void
  readonly onDownloaded: (listener: (info: { readonly version: string }) => void) => () => void
  readonly onError: (listener: (error: Error) => void) => () => void
}

/** Runtime facts used to select and configure an automatic-update feed. */
export interface AppUpdaterOptions {
  readonly adapter: NativeUpdaterAdapter
  readonly appImagePath?: string
  readonly arch: string
  readonly currentVersion: string
  readonly feedBaseUrl?: string
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
}

/** Main-process service for checking, downloading, and installing DiffDash updates. */
export class AppUpdater extends Context.Tag("@diffdash/AppUpdater")<
  AppUpdater,
  {
    readonly state: Effect.Effect<AppUpdateState>
    readonly check: Effect.Effect<void, AppUpdaterError>
    readonly download: Effect.Effect<void, AppUpdaterError>
    readonly quitAndInstall: Effect.Effect<void, AppUpdaterError>
    readonly startAutomaticChecks: Effect.Effect<void>
    readonly subscribe: (listener: (state: AppUpdateState) => void) => Effect.Effect<() => void>
  }
>() {
  /** Creates an updater layer for production or a supplied test adapter. */
  static layer(options: AppUpdaterOptions) {
    return Layer.scoped(
      AppUpdater,
      Effect.acquireRelease(
        Effect.sync(() => makeAppUpdater(options)),
        ({ cleanup }) => Effect.sync(cleanup),
      ).pipe(Effect.map(({ service }) => service)),
    )
  }
}

/** Creates the production adapter around electron-updater. */
export const nativeUpdaterAdapter = (): NativeUpdaterAdapter => {
  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  return {
    configure: (feedUrl) => autoUpdater.setFeedURL({ provider: "generic", url: feedUrl }),
    check: () => autoUpdater.checkForUpdates(),
    download: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    onChecking: (listener) => subscribeNative(autoUpdater, "checking-for-update", listener),
    onAvailable: (listener) =>
      subscribeNative(autoUpdater, "update-available", (info: UpdateInfo) =>
        listener({ version: info.version }),
      ),
    onNotAvailable: (listener) => subscribeNative(autoUpdater, "update-not-available", listener),
    onProgress: (listener) =>
      subscribeNative(autoUpdater, "download-progress", (info: ProgressInfo) =>
        listener({ percent: info.percent }),
      ),
    onDownloaded: (listener) =>
      subscribeNative(autoUpdater, "update-downloaded", (info: UpdateInfo) =>
        listener({ version: info.version }),
      ),
    onError: (listener) => subscribeNative(autoUpdater, "error", listener),
  }
}

const subscribeNative = <Event extends Parameters<ElectronNativeUpdater["on"]>[0]>(
  updater: ElectronNativeUpdater,
  event: Event,
  listener: Parameters<typeof updater.on<Event>>[1],
) => {
  updater.on(event, listener)
  return () => updater.removeListener(event, listener)
}

const makeAppUpdater = (options: AppUpdaterOptions) => {
  const eligibility = updateEligibility(options)
  let state: AppUpdateState =
    "reason" in eligibility
      ? AppUpdateUnsupported.make({
          currentVersion: options.currentVersion,
          reason: eligibility.reason,
        })
      : AppUpdateIdle.make({ currentVersion: options.currentVersion })
  let availableVersion: string | null = null
  let initialTimer: NodeJS.Timeout | null = null
  let intervalTimer: NodeJS.Timeout | null = null
  const listeners = new Set<(state: AppUpdateState) => void>()
  const subscriptions: Array<() => void> = []

  const publish = (nextState: AppUpdateState) => {
    state = nextState
    for (const listener of listeners) listener(state)
  }
  const fail = (operation: string, cause: unknown) => {
    const message =
      cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause)
    publish(AppUpdateFailed.make({ currentVersion: options.currentVersion, message }))
    return AppUpdaterError.make({ operation, message, cause })
  }

  if ("feedUrl" in eligibility) {
    options.adapter.configure(eligibility.feedUrl)
    subscriptions.push(
      options.adapter.onChecking(() => {
        publish(AppUpdateChecking.make({ currentVersion: options.currentVersion }))
      }),
      options.adapter.onAvailable((info) => {
        availableVersion = info.version
        publish(
          AppUpdateAvailable.make({
            currentVersion: options.currentVersion,
            version: info.version,
          }),
        )
      }),
      options.adapter.onNotAvailable(() => {
        availableVersion = null
        publish(AppUpdateIdle.make({ currentVersion: options.currentVersion }))
      }),
      options.adapter.onProgress((info) => {
        if (availableVersion === null) return
        publish(
          AppUpdateDownloading.make({
            currentVersion: options.currentVersion,
            percent: Math.min(100, Math.max(0, info.percent)),
            version: availableVersion,
          }),
        )
      }),
      options.adapter.onDownloaded((info) => {
        availableVersion = info.version
        publish(
          AppUpdateDownloaded.make({
            currentVersion: options.currentVersion,
            version: info.version,
          }),
        )
      }),
      options.adapter.onError((error) => {
        publish(
          AppUpdateFailed.make({
            currentVersion: options.currentVersion,
            message: error.message,
          }),
        )
      }),
    )
  }

  const check = Effect.tryPromise({
    try: async () => {
      if ("reason" in eligibility) throw new Error("Automatic updates are unavailable.")
      await options.adapter.check()
    },
    catch: (cause) => fail("check", cause),
  })
  const download = Effect.tryPromise({
    try: async () => {
      if ("reason" in eligibility || availableVersion === null) {
        throw new Error("No update is available to download.")
      }
      publish(
        AppUpdateDownloading.make({
          currentVersion: options.currentVersion,
          percent: 0,
          version: availableVersion,
        }),
      )
      await options.adapter.download()
    },
    catch: (cause) => fail("download", cause),
  })
  const quitAndInstall = Effect.try({
    try: () => {
      if (state["_tag"] !== "downloaded") throw new Error("No downloaded update is ready.")
      options.adapter.quitAndInstall()
    },
    catch: (cause) => fail("quitAndInstall", cause),
  })
  const startAutomaticChecks = Effect.sync(() => {
    if ("reason" in eligibility || initialTimer !== null || intervalTimer !== null) return
    const runCheck = () => void Effect.runPromise(check).catch(() => undefined)
    initialTimer = setTimeout(runCheck, INITIAL_CHECK_DELAY_MS)
    initialTimer.unref()
    intervalTimer = setInterval(runCheck, CHECK_INTERVAL_MS)
    intervalTimer.unref()
  })
  const cleanup = () => {
    if (initialTimer !== null) clearTimeout(initialTimer)
    if (intervalTimer !== null) clearInterval(intervalTimer)
    for (const unsubscribe of subscriptions) unsubscribe()
    listeners.clear()
  }

  return {
    cleanup,
    service: AppUpdater.of({
      state: Effect.sync(() => state),
      check,
      download,
      quitAndInstall,
      startAutomaticChecks,
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }),
    }),
  }
}

const updateEligibility = (
  options: AppUpdaterOptions,
): { readonly feedUrl: string } | { readonly reason: AppUpdateUnsupportedReason } => {
  if (!options.packaged) return { reason: "development" }
  if (options.platform === "darwin") {
    if (options.arch !== "arm64" && options.arch !== "x64") return { reason: "architecture" }
    return { feedUrl: `${options.feedBaseUrl ?? DEFAULT_UPDATE_BASE_URL}/macos/${options.arch}` }
  }
  if (options.platform !== "linux") return { reason: "platform" }
  if (options.arch !== "x64") return { reason: "architecture" }
  if (options.appImagePath === undefined || options.appImagePath.trim().length === 0)
    return { reason: "installation" }
  return { feedUrl: `${options.feedBaseUrl ?? DEFAULT_UPDATE_BASE_URL}/linux/x64` }
}
