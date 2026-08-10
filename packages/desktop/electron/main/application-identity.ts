import { join } from "node:path"

/** Stable Electron identity and storage namespace selected for one host process. */
export interface ApplicationIdentity {
  readonly appName: string
  readonly appUserModelId: string
  readonly storageNamespace: string
  readonly userDataPath: string | null
}

/** Resolves the process identity and storage namespace for packaged and development builds. */
export const resolveApplicationIdentity = ({
  appDataPath,
  explicitUserDataDirectory = false,
  packaged,
}: {
  readonly appDataPath: string
  readonly explicitUserDataDirectory?: boolean
  readonly packaged: boolean
}): ApplicationIdentity =>
  packaged
    ? {
        appName: "DiffDash",
        appUserModelId: "dev.diffdash.app",
        storageNamespace: "diffdash",
        userDataPath: explicitUserDataDirectory ? null : join(appDataPath, "DiffDash"),
      }
    : {
        appName: "DiffDash Development",
        appUserModelId: "dev.diffdash.app.development",
        storageNamespace: "diffdash-development",
        userDataPath: explicitUserDataDirectory ? null : join(appDataPath, "DiffDash Development"),
      }
