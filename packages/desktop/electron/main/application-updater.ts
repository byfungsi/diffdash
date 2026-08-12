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
  const appImagePath =
    configuration.updater.appImagePath === null
      ? {}
      : { appImagePath: configuration.updater.appImagePath }
  return createDesktopUpdater({
    adapter: nativeUpdaterAdapter(),
    ...appImagePath,
    arch: configuration.application.architecture,
    currentVersion: configuration.application.version,
    packaged: configuration.application.packaged,
    platform: configuration.application.platform,
  })
}
