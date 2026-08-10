import { Effect, Match, Schema } from "effect"
import electronUpdater, {
  type AppUpdater as ElectronNativeUpdater,
  type ProgressInfo,
  type UpdateCheckResult,
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
  AppUpdateFeedUrl,
  type AppUpdateFeedUrl as AppUpdateFeedUrlType,
} from "@diffdash/protocol/app-update"

const DEFAULT_UPDATE_BASE_URL = AppUpdateFeedUrl.make(
  "https://download.usediffdash.com/updates/stable",
)
const INITIAL_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

const AppUpdaterOperation = Schema.Literals(["check", "download", "quitAndInstall"])
type AppUpdaterOperation = typeof AppUpdaterOperation.Type

/** A recoverable automatic-update operation failure. */
export class AppUpdaterError extends Schema.TaggedError<AppUpdaterError>()("AppUpdaterError", {
  operation: AppUpdaterOperation,
  message: Schema.String,
  cause: Schema.NullOr(Schema.ErrorInstance()),
}) {}

/** Native updater seam used by the production service and deterministic tests. */
export interface NativeUpdaterAdapter {
  readonly configure: (feedUrl: AppUpdateFeedUrlType) => void
  readonly check: () => Promise<UpdateCheckResult | null>
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
  readonly feedBaseUrl?: AppUpdateFeedUrlType
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
}

/** Electron-owned updater operations and lifecycle. */
export interface DesktopUpdater {
  /** Returns the latest updater state. */
  readonly getState: () => Effect.Effect<AppUpdateState>

  /** Checks the configured feed for an update. */
  readonly check: () => Effect.Effect<void, AppUpdaterError>

  /** Downloads the currently available update. */
  readonly download: () => Effect.Effect<void, AppUpdaterError>

  /** Installs a downloaded update and exits the application. */
  readonly quitAndInstall: () => Effect.Effect<void, AppUpdaterError>

  /** Starts the bounded automatic update-check timers once. */
  readonly startAutomaticChecks: () => Effect.Effect<void>

  /** Subscribes to updater state changes until the returned cleanup runs. */
  readonly subscribe: (listener: (state: AppUpdateState) => void) => Effect.Effect<() => void>

  /** Releases timers, native subscriptions, and listeners. */
  readonly dispose: () => Effect.Effect<void>
}

type AppUpdaterEvent =
  | { readonly _tag: "checking" }
  | { readonly _tag: "available"; readonly version: string }
  | { readonly _tag: "notAvailable" }
  | { readonly _tag: "progress"; readonly percent: number }
  | { readonly _tag: "downloaded"; readonly version: string }
  | { readonly _tag: "error"; readonly message: string }

type AppUpdaterCommand = { readonly _tag: "download" } | { readonly _tag: "quitAndInstall" }

const rejectDownload = () => Promise.reject(new Error("No update is available to download."))
const rejectInstall = () => Promise.reject(new Error("No downloaded update is ready."))

/** Creates the production adapter around electron-updater. */
export const nativeUpdaterAdapter = (): NativeUpdaterAdapter => {
  let updater: ElectronNativeUpdater | null = null
  const getUpdater = () => {
    if (updater !== null) return updater

    const { autoUpdater } = electronUpdater
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    updater = autoUpdater
    return updater
  }

  return {
    configure: (feedUrl) => getUpdater().setFeedURL({ provider: "generic", url: feedUrl }),
    check: () => getUpdater().checkForUpdates(),
    download: () => getUpdater().downloadUpdate(),
    quitAndInstall: () => getUpdater().quitAndInstall(false, true),
    onChecking: (listener) => subscribeNative(getUpdater(), "checking-for-update", listener),
    onAvailable: (listener) =>
      subscribeNative(getUpdater(), "update-available", (info: UpdateInfo) =>
        listener({ version: info.version }),
      ),
    onNotAvailable: (listener) => subscribeNative(getUpdater(), "update-not-available", listener),
    onProgress: (listener) =>
      subscribeNative(getUpdater(), "download-progress", (info: ProgressInfo) =>
        listener({ percent: info.percent }),
      ),
    onDownloaded: (listener) =>
      subscribeNative(getUpdater(), "update-downloaded", (info: UpdateInfo) =>
        listener({ version: info.version }),
      ),
    onError: (listener) => subscribeNative(getUpdater(), "error", listener),
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

/** Creates the Electron-owned updater without introducing another managed runtime. */
export const createDesktopUpdater = (options: AppUpdaterOptions): DesktopUpdater => {
  const eligibility = updateEligibility(options)
  let state: AppUpdateState =
    "reason" in eligibility
      ? AppUpdateUnsupported.make({
          currentVersion: options.currentVersion,
          reason: eligibility.reason,
        })
      : AppUpdateIdle.make({ currentVersion: options.currentVersion })
  let initialTimer: NodeJS.Timeout | null = null
  let intervalTimer: NodeJS.Timeout | null = null
  const listeners = new Set<(state: AppUpdateState) => void>()
  const subscriptions: Array<() => void> = []

  const publish = (nextState: AppUpdateState) => {
    state = nextState
    for (const listener of listeners) listener(state)
  }
  const fail = <A>(operation: AppUpdaterOperation, cause: A) => {
    const message =
      Schema.is(Schema.ErrorInstance())(cause) && cause.message.length > 0
        ? cause.message
        : String(cause)
    publish(AppUpdateFailed.make({ currentVersion: options.currentVersion, message }))
    return AppUpdaterError.make({
      operation,
      message,
      cause: Schema.is(Schema.ErrorInstance())(cause) ? cause : new Error(String(cause)),
    })
  }
  const publishProgress = (version: string, percent: number) => {
    publish(
      AppUpdateDownloading.make({
        currentVersion: options.currentVersion,
        percent: Math.min(100, Math.max(0, percent)),
        version,
      }),
    )
  }
  const transition = (event: AppUpdaterEvent): void =>
    Match.valueTags(event, {
      checking: () => {
        publish(AppUpdateChecking.make({ currentVersion: options.currentVersion }))
      },
      available: ({ version }) => {
        publish(AppUpdateAvailable.make({ currentVersion: options.currentVersion, version }))
      },
      notAvailable: () => {
        publish(AppUpdateIdle.make({ currentVersion: options.currentVersion }))
      },
      progress: ({ percent }) =>
        Match.valueTags(state, {
          unsupported: () => undefined,
          idle: () => undefined,
          checking: () => undefined,
          available: ({ version }) => {
            publishProgress(version, percent)
          },
          downloading: ({ version }) => {
            publishProgress(version, percent)
          },
          downloaded: () => undefined,
          error: () => undefined,
        }),
      downloaded: ({ version }) => {
        publish(AppUpdateDownloaded.make({ currentVersion: options.currentVersion, version }))
      },
      error: ({ message }) => {
        publish(AppUpdateFailed.make({ currentVersion: options.currentVersion, message }))
      },
    })

  if ("feedUrl" in eligibility) {
    options.adapter.configure(eligibility.feedUrl)
    subscriptions.push(
      options.adapter.onChecking(() => {
        transition({ _tag: "checking" })
      }),
      options.adapter.onAvailable((info) => {
        transition({ _tag: "available", version: info.version })
      }),
      options.adapter.onNotAvailable(() => {
        transition({ _tag: "notAvailable" })
      }),
      options.adapter.onProgress((info) => {
        transition({ _tag: "progress", percent: info.percent })
      }),
      options.adapter.onDownloaded((info) => {
        transition({ _tag: "downloaded", version: info.version })
      }),
      options.adapter.onError((error) => {
        transition({ _tag: "error", message: error.message })
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
  const executeCommand = (command: AppUpdaterCommand): Promise<void> =>
    Match.valueTags(command, {
      download: () =>
        Match.valueTags(state, {
          unsupported: rejectDownload,
          idle: rejectDownload,
          checking: rejectDownload,
          available: async ({ version }) => {
            publishProgress(version, 0)
            await options.adapter.download()
          },
          downloading: rejectDownload,
          downloaded: rejectDownload,
          error: rejectDownload,
        }),
      quitAndInstall: () =>
        Match.valueTags(state, {
          unsupported: rejectInstall,
          idle: rejectInstall,
          checking: rejectInstall,
          available: rejectInstall,
          downloading: rejectInstall,
          downloaded: async () => {
            options.adapter.quitAndInstall()
          },
          error: rejectInstall,
        }),
    })
  const runCommand = (command: AppUpdaterCommand) =>
    Effect.tryPromise({
      try: () => executeCommand(command),
      catch: (cause) => fail(command._tag, cause),
    })
  const download = runCommand({ _tag: "download" })
  const quitAndInstall = runCommand({ _tag: "quitAndInstall" })
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
    getState: () => Effect.sync(() => state),
    check: () => check,
    download: () => download,
    quitAndInstall: () => quitAndInstall,
    startAutomaticChecks: () => startAutomaticChecks,
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    dispose: () => Effect.sync(cleanup),
  }
}

const updateEligibility = (
  options: AppUpdaterOptions,
): { readonly feedUrl: AppUpdateFeedUrlType } | { readonly reason: AppUpdateUnsupportedReason } => {
  if (!options.packaged) return { reason: "development" }
  if (options.platform === "darwin") {
    if (options.arch !== "arm64" && options.arch !== "x64") return { reason: "architecture" }
    return {
      feedUrl: AppUpdateFeedUrl.make(
        `${options.feedBaseUrl ?? DEFAULT_UPDATE_BASE_URL}/macos/${options.arch}`,
      ),
    }
  }
  if (options.platform !== "linux") return { reason: "platform" }
  if (options.arch !== "x64") return { reason: "architecture" }
  if (options.appImagePath === undefined || options.appImagePath.trim().length === 0)
    return { reason: "installation" }
  return {
    feedUrl: AppUpdateFeedUrl.make(`${options.feedBaseUrl ?? DEFAULT_UPDATE_BASE_URL}/linux/x64`),
  }
}
