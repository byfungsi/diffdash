import {
  createDesktopUpdater,
  nativeUpdaterAdapter,
  type DesktopUpdater,
} from "../../src/main/services/app-updater"
import { app } from "electron"

/** Creates the Electron-owned updater from native application facts. */
export const createApplicationUpdater = (): DesktopUpdater =>
  createDesktopUpdater({
    adapter: nativeUpdaterAdapter(),
    ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
    arch: process.arch,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
  })
