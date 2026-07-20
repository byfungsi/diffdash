import { join } from "node:path"

/** Resolves the process identity and storage namespace for packaged and development builds. */
export const resolveApplicationIdentity = ({
  appDataPath,
  explicitUserDataDirectory = false,
  packaged,
}: {
  readonly appDataPath: string
  readonly explicitUserDataDirectory?: boolean
  readonly packaged: boolean
}) =>
  packaged
    ? {
        appName: "DiffDash",
        appUserModelId: "dev.diffdash.app",
        storageNamespace: "diffdash",
        userDataPath: null,
      }
    : {
        appName: "DiffDash Development",
        appUserModelId: "dev.diffdash.app.development",
        storageNamespace: "diffdash-development",
        userDataPath: explicitUserDataDirectory ? null : join(appDataPath, "DiffDash Development"),
      }
