import { CoreConfiguration } from "@diffdash/core"
import { Schema } from "effect"
import { app } from "electron"
import { applicationPaths } from "./paths"

const optionalEnvironmentValue = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value

/** Decodes Electron-owned runtime facts into the plain DiffDash Core configuration contract. */
export const resolveCoreConfiguration = (): CoreConfiguration => {
  const paths = applicationPaths()
  const gitFixtureEnabled = process.env.DIFFDASH_E2E_FAKE_GIT_PROVIDER === "1"
  return Schema.decodeUnknownSync(CoreConfiguration)({
    application: {
      version: app.getVersion(),
      architecture: process.arch,
      platform: process.platform,
      packaged: app.isPackaged,
    },
    paths: {
      database: paths.databasePath,
      settings: paths.settingsPath,
      state: paths.statePath,
      temporaryDirectory: paths.agentWorkingDirectory,
      worktreePool: paths.worktreePoolPath,
      remoteWorktreePool: paths.remoteWorktreePoolPath,
      diffDashCli: paths.diffDashCliPath,
      appImage: optionalEnvironmentValue(process.env.APPIMAGE),
    },
    analytics: {
      host: optionalEnvironmentValue(process.env.VITE_POSTHOG_HOST),
      projectKey: optionalEnvironmentValue(process.env.VITE_POSTHOG_KEY),
    },
    environment: {
      executableSearchPath: process.env.PATH ?? "",
      homeDirectory: process.env.HOME ?? "",
    },
    fixtures: {
      agentProviderEnabled: process.env.DIFFDASH_E2E_FAKE_AGENT_PROVIDER === "1",
      gitProvider: gitFixtureEnabled
        ? {
            remoteUrl: optionalEnvironmentValue(process.env.DIFFDASH_E2E_FAKE_GIT_REMOTE),
            baseRevision: optionalEnvironmentValue(process.env.DIFFDASH_E2E_FAKE_GIT_BASE_SHA),
            headRevision: optionalEnvironmentValue(process.env.DIFFDASH_E2E_FAKE_GIT_HEAD_SHA),
          }
        : null,
    },
  })
}
