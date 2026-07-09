import { Context, Layer } from "effect"

/** Runtime configuration provided once by the Electron app boundary. */
export class AppConfig extends Context.Tag("@diffdash/AppConfig")<
  AppConfig,
  {
    readonly databasePath: string
    readonly settingsPath: string
    readonly tempDir: string
  }
>() {
  static readonly layer = (config: {
    readonly databasePath: string
    readonly settingsPath: string
    readonly tempDir: string
  }) => Layer.succeed(AppConfig, AppConfig.of(config))
}
