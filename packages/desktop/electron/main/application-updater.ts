import {
  createDesktopUpdater,
  nativeUpdaterAdapter,
  type DesktopUpdater,
} from "../../src/main/services/app-updater"
import type { DesktopHostConfiguration } from "./desktop-host-configuration"

/** Creates the Electron-owned updater from native application facts. */
export const createApplicationUpdater = (
  configuration: DesktopHostConfiguration,
): DesktopUpdater => {
  const options = {
    adapter: nativeUpdaterAdapter(),
    arch: configuration.application.architecture,
    currentVersion: configuration.application.version,
    packaged: configuration.application.packaged,
    platform: configuration.application.platform,
  }
  return configuration.updater.appImagePath === null
    ? createDesktopUpdater(options)
    : createDesktopUpdater({ ...options, appImagePath: configuration.updater.appImagePath })
}
