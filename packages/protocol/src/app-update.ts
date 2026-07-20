import { Schema } from "effect"

/** Why automatic updates are unavailable for the current installation. */
export const AppUpdateUnsupportedReason = Schema.Literal(
  "development",
  "platform",
  "architecture",
  "installation",
)

/** Why automatic updates are unavailable for the current installation. */
export type AppUpdateUnsupportedReason = typeof AppUpdateUnsupportedReason.Type

/** Automatic updates are unavailable for this installation. */
export class AppUpdateUnsupported extends Schema.TaggedClass<AppUpdateUnsupported>()(
  "unsupported",
  {
    currentVersion: Schema.String,
    reason: AppUpdateUnsupportedReason,
  },
) {}

/** The updater is idle and the current installation is eligible. */
export class AppUpdateIdle extends Schema.TaggedClass<AppUpdateIdle>()("idle", {
  currentVersion: Schema.String,
}) {}

/** DiffDash is checking the stable update feed. */
export class AppUpdateChecking extends Schema.TaggedClass<AppUpdateChecking>()("checking", {
  currentVersion: Schema.String,
}) {}

/** A newer release is available and waiting for download approval. */
export class AppUpdateAvailable extends Schema.TaggedClass<AppUpdateAvailable>()("available", {
  currentVersion: Schema.String,
  version: Schema.String,
}) {}

/** An approved update is downloading. */
export class AppUpdateDownloading extends Schema.TaggedClass<AppUpdateDownloading>()(
  "downloading",
  {
    currentVersion: Schema.String,
    percent: Schema.Number,
    version: Schema.String,
  },
) {}

/** An update is downloaded and ready to install. */
export class AppUpdateDownloaded extends Schema.TaggedClass<AppUpdateDownloaded>()("downloaded", {
  currentVersion: Schema.String,
  version: Schema.String,
}) {}

/** The updater failed while checking, downloading, or installing. */
export class AppUpdateFailed extends Schema.TaggedClass<AppUpdateFailed>()("error", {
  currentVersion: Schema.String,
  message: Schema.String,
}) {}

/** Renderer-safe automatic update lifecycle state. */
export const AppUpdateState = Schema.Union(
  AppUpdateUnsupported,
  AppUpdateIdle,
  AppUpdateChecking,
  AppUpdateAvailable,
  AppUpdateDownloading,
  AppUpdateDownloaded,
  AppUpdateFailed,
)

/** Renderer-safe automatic update lifecycle state. */
export type AppUpdateState = typeof AppUpdateState.Type
