import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { app } from "electron"
import { resolveApplicationIdentity } from "./application-identity"

/** Resolves paths whose locations differ between development and packaged builds. */
export const applicationPaths = () => {
  const { storageNamespace } = resolveApplicationIdentity({
    appDataPath: app.getPath("appData"),
    packaged: app.isPackaged,
  })
  const configDirectory = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    storageNamespace,
  )
  const applicationDataDirectory = join(homedir(), `.${storageNamespace}`)
  return {
    agentWorkingDirectory: join(app.getPath("temp"), storageNamespace),
    configDirectory,
    databasePath: join(app.getPath("userData"), "diffdash.sqlite"),
    developmentIconPath: app.isPackaged
      ? null
      : resolve(__dirname, "../../resources/icons/icon.png"),
    diffDashCliPath: app.isPackaged
      ? join(process.resourcesPath, "bin", "diffdash")
      : resolve(__dirname, "../../bin/diffdash.mjs"),
    remoteWorktreePoolPath:
      process.env.DIFFDASH_REMOTE_WORKTREE_POOL_PATH ??
      join(applicationDataDirectory, "remote-worktree-pool"),
    settingsPath: join(configDirectory, "settings.json"),
    statePath: join(configDirectory, "state.json"),
    worktreePoolPath:
      process.env.DIFFDASH_WORKTREE_POOL_PATH ?? join(applicationDataDirectory, "worktree-pool"),
  } as const
}
