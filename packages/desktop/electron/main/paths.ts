import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { app } from "electron"

/** Resolves paths whose locations differ between development and packaged builds. */
export const applicationPaths = () => {
  const configDirectory = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "diffdash",
  )
  return {
    agentWorkingDirectory: join(app.getPath("temp"), "diffdash"),
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
      join(homedir(), ".diffdash", "remote-worktree-pool"),
    settingsPath: join(configDirectory, "settings.json"),
    statePath: join(configDirectory, "state.json"),
    worktreePoolPath:
      process.env.DIFFDASH_WORKTREE_POOL_PATH ?? join(homedir(), ".diffdash", "worktree-pool"),
  } as const
}
