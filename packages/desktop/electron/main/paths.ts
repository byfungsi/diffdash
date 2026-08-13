import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ApplicationIdentity } from "./application-identity"

/** Immutable paths resolved once for the Electron host. */
export interface ApplicationPaths {
  readonly agentWorkingDirectory: string
  readonly configDirectory: string
  readonly databasePath: string
  readonly developmentIconPath: string | null
  readonly diffDashCliPath: string
  readonly preloadPath: string
  readonly remoteWorktreePoolPath: string
  readonly rendererHtmlPath: string
  readonly settingsPath: string
  readonly statePath: string
  readonly worktreePoolPath: string
}

/** Resolves paths whose locations differ between development and packaged builds. */
export const resolveApplicationPaths = ({
  environment,
  homeDirectory = homedir(),
  identity,
  moduleDirectory,
  packaged,
  resourcesPath,
  temporaryDirectory,
  userDataDirectory,
}: {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: string
  readonly identity: ApplicationIdentity
  readonly moduleDirectory: string
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly temporaryDirectory: string
  readonly userDataDirectory: string
}): ApplicationPaths => {
  const { storageNamespace } = identity
  const configDirectory = join(
    environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"),
    storageNamespace,
  )
  const applicationDataDirectory = join(homeDirectory, `.${storageNamespace}`)
  return {
    agentWorkingDirectory: join(temporaryDirectory, storageNamespace),
    configDirectory,
    databasePath: join(userDataDirectory, "diffdash.sqlite"),
    developmentIconPath: packaged
      ? null
      : resolve(moduleDirectory, "../../resources/icons/icon.png"),
    diffDashCliPath: packaged
      ? join(resourcesPath, "bin", "diffdash")
      : resolve(moduleDirectory, "../../bin/diffdash.mjs"),
    preloadPath: resolve(moduleDirectory, "../preload/index.mjs"),
    remoteWorktreePoolPath:
      environment.DIFFDASH_REMOTE_WORKTREE_POOL_PATH ??
      join(applicationDataDirectory, "remote-worktree-pool"),
    rendererHtmlPath: resolve(moduleDirectory, "../renderer/index.html"),
    settingsPath: join(configDirectory, "settings.json"),
    statePath: join(configDirectory, "state.json"),
    worktreePoolPath:
      environment.DIFFDASH_WORKTREE_POOL_PATH ?? join(applicationDataDirectory, "worktree-pool"),
  }
}
