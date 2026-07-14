import { join } from "node:path"
import { Context, Layer } from "effect"

/** Runtime configuration provided once by the Electron app boundary. */
export class AppConfig extends Context.Tag("@diffdash/AppConfig")<
  AppConfig,
  {
    readonly databasePath: string
    readonly diffDashCliPath: string
    readonly appVersion: string
    readonly architecture: string
    readonly packaged: boolean
    readonly platform: string
    readonly posthogHost: string
    readonly posthogKey: string
    readonly settingsPath: string
    readonly tempDir: string
    readonly remoteWorktreePoolPath: string
    readonly worktreePoolPath: string
  }
>() {
  static readonly layer = (config: {
    readonly databasePath: string
    readonly diffDashCliPath?: string
    readonly appVersion?: string
    readonly architecture?: string
    readonly packaged?: boolean
    readonly platform?: string
    readonly posthogHost?: string
    readonly posthogKey?: string
    readonly settingsPath: string
    readonly tempDir: string
    readonly remoteWorktreePoolPath?: string
    readonly worktreePoolPath?: string
  }) =>
    Layer.succeed(
      AppConfig,
      AppConfig.of({
        ...config,
        appVersion: config.appVersion ?? "0.0.0",
        architecture: config.architecture ?? "unknown",
        diffDashCliPath: config.diffDashCliPath ?? "",
        packaged: config.packaged ?? false,
        platform: config.platform ?? "unknown",
        posthogHost: config.posthogHost ?? "",
        posthogKey: config.posthogKey ?? "",
        remoteWorktreePoolPath:
          config.remoteWorktreePoolPath ?? join(config.tempDir, "remote-worktree-pool"),
        worktreePoolPath: config.worktreePoolPath ?? join(config.tempDir, "worktree-pool"),
      }),
    )
}
